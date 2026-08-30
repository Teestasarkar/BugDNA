"""Feature contract.

Loads `contracts/feature-spec.json`, which is generated from the TypeScript
feature registry in the backend. That file is the single authority for:

  * which features exist and in what order (the model's vector layout),
  * each feature's neutral fallback when a caller cannot compute it,
  * the weights used by the transparent heuristic scorer.

Keeping one generated contract rather than a hand-maintained Python copy is what
stops the two services from silently disagreeing about the feature set — a class
of bug that would show up as quietly wrong risk scores rather than an error.

If the contract is missing the service still starts, in a clearly degraded mode:
it accepts whatever features the caller sends, in sorted order, and says so in
its warnings. Refusing to start would take the product down over a build
artifact; scoring silently against a guessed layout would be worse than either.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

from .config import settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class FeatureSpec:
    """One feature, as declared by the shared contract."""

    key: str
    label: str
    description: str
    category: str
    type: str
    unit: str | None
    fallback: float
    expected_direction: str
    heuristic_weight: float
    requires_history: bool


@dataclass(frozen=True)
class RiskBand:
    level: str
    min: int
    max: int


@dataclass(frozen=True)
class FeatureContract:
    feature_set_version: str
    features: tuple[FeatureSpec, ...]
    risk_bands: tuple[RiskBand, ...]
    source: str
    loaded: bool

    @property
    def keys(self) -> tuple[str, ...]:
        """Ordered feature keys — the canonical model vector layout."""
        return tuple(spec.key for spec in self.features)

    def spec(self, key: str) -> FeatureSpec | None:
        return self._by_key.get(key)

    def __post_init__(self) -> None:
        # dataclass is frozen, so build the index via object.__setattr__.
        object.__setattr__(self, "_by_key", {spec.key: spec for spec in self.features})

    def level_for_score(self, score: float) -> str:
        """Map a 0-100 score onto a band.

        The backend applies the authoritative banding; this exists so the
        service's own responses are self-consistent.
        """
        clamped = max(0.0, min(100.0, score))
        for band in self.risk_bands:
            if band.min <= clamped <= band.max:
                return band.level
        return "CRITICAL"


_DEFAULT_BANDS = (
    RiskBand(level="LOW", min=0, max=34),
    RiskBand(level="MODERATE", min=35, max=59),
    RiskBand(level="HIGH", min=60, max=79),
    RiskBand(level="CRITICAL", min=80, max=100),
)


def _load_from_path(path: Path) -> FeatureContract:
    payload = json.loads(path.read_text(encoding="utf-8"))

    features = tuple(
        FeatureSpec(
            key=item["key"],
            label=item.get("label", item["key"]),
            description=item.get("description", ""),
            category=item.get("category", "CHANGE_SHAPE"),
            type=item.get("type", "count"),
            unit=item.get("unit"),
            fallback=float(item.get("fallback", 0.0)),
            expected_direction=item.get("expectedDirection", "context"),
            heuristic_weight=float(item.get("heuristicWeight", 0.0)),
            requires_history=bool(item.get("requiresHistory", False)),
        )
        for item in payload["features"]
    )

    bands = tuple(
        RiskBand(level=b["level"], min=int(b["min"]), max=int(b["max"]))
        for b in payload.get("riskBands", [])
    ) or _DEFAULT_BANDS

    return FeatureContract(
        feature_set_version=payload.get("featureSetVersion", "unknown"),
        features=features,
        risk_bands=bands,
        source=str(path),
        loaded=True,
    )


def load_contract() -> FeatureContract:
    """Load the contract from the first path that exists."""
    for path in settings.candidate_contract_paths():
        if not path.is_file():
            continue
        try:
            contract = _load_from_path(path)
        except (KeyError, ValueError, json.JSONDecodeError) as exc:
            logger.error("feature contract at %s is malformed: %s", path, exc)
            continue

        logger.info(
            "loaded feature contract",
            extra={
                "path": str(path),
                "feature_set_version": contract.feature_set_version,
                "feature_count": len(contract.features),
            },
        )
        return contract

    searched = ", ".join(str(p) for p in settings.candidate_contract_paths())
    logger.warning(
        "no feature contract found (searched: %s) — running in permissive mode: "
        "features will be ordered as received. Run `npm run contracts:generate` "
        "in the backend and mount contracts/ into this service.",
        searched,
    )

    return FeatureContract(
        feature_set_version="unknown",
        features=(),
        risk_bands=_DEFAULT_BANDS,
        source="none",
        loaded=False,
    )


# Loaded once at import; the contract is a build artifact and does not change at
# runtime.
CONTRACT: FeatureContract = load_contract()


@dataclass
class AlignedFeatures:
    """A feature dict aligned to the contract's vector layout."""

    keys: tuple[str, ...]
    values: list[float]
    # Non-fatal problems worth telling the caller about.
    warnings: list[str]

    def as_dict(self) -> dict[str, float]:
        return dict(zip(self.keys, self.values, strict=True))


def align(
    features: dict[str, float],
    contract: FeatureContract | None = None,
) -> AlignedFeatures:
    """Order an incoming feature dict into the model's expected vector.

    Three cases are handled explicitly rather than left to chance, because each
    would otherwise produce a plausible-looking but wrong score:

      * **missing feature** — filled with the contract's documented neutral
        fallback, and reported. Silently using 0 would make "no repository
        history" look like "zero prior incidents".
      * **unknown feature** — ignored, and reported. A model cannot consume a
        column it was never fitted on.
      * **non-finite value** — replaced with the fallback, and reported. NaN
        propagates through XGBoost into a meaningless score.
    """
    active = contract or CONTRACT
    warnings: list[str] = []

    if not active.loaded or not active.features:
        # Permissive mode: sorted order is at least deterministic.
        keys = tuple(sorted(features.keys()))
        values = [_finite(features[k], 0.0, k, warnings) for k in keys]
        warnings.append(
            "No feature contract is loaded, so features were ordered alphabetically. "
            "Scores are not comparable with a contract-aligned model."
        )
        return AlignedFeatures(keys=keys, values=values, warnings=warnings)

    keys = active.keys
    values: list[float] = []
    missing: list[str] = []

    for spec in active.features:
        if spec.key not in features:
            missing.append(spec.key)
            values.append(spec.fallback)
            continue
        values.append(_finite(features[spec.key], spec.fallback, spec.key, warnings))

    if missing:
        preview = ", ".join(missing[:6])
        suffix = f" and {len(missing) - 6} more" if len(missing) > 6 else ""
        warnings.append(
            f"{len(missing)} expected feature(s) were not supplied and used their "
            f"documented neutral values: {preview}{suffix}."
        )

    unknown = sorted(set(features) - set(keys))
    if unknown:
        preview = ", ".join(unknown[:6])
        suffix = f" and {len(unknown) - 6} more" if len(unknown) > 6 else ""
        warnings.append(
            f"{len(unknown)} unrecognised feature(s) were ignored because the model "
            f"was not fitted on them: {preview}{suffix}. "
            f"Regenerate contracts/feature-spec.json if the feature set changed."
        )

    return AlignedFeatures(keys=keys, values=values, warnings=warnings)


def _finite(value: object, fallback: float, key: str, warnings: list[str]) -> float:
    """Coerce to a finite float, falling back and reporting when impossible."""
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        warnings.append(f"Feature '{key}' was not numeric; used its neutral value.")
        return fallback

    if number != number or number in (float("inf"), float("-inf")):  # NaN or inf
        warnings.append(f"Feature '{key}' was not finite; used its neutral value.")
        return fallback

    return number
