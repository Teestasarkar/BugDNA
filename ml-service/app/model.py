"""Model loading, scoring and SHAP explanation.

Responsibilities
----------------
* resolve and load an XGBoost artifact from disk (or fall back to the heuristic),
* build a SHAP ``TreeExplainer`` once, at load time, rather than per request,
* verify that the artifact's feature layout matches the current contract,
* produce a score plus per-feature attributions in a single shape regardless of
  which engine answered.

Design notes worth defending
----------------------------
**The explainer is built once.** Constructing a ``TreeExplainer`` is expensive
relative to an inference; doing it per request would dominate latency. It is
immutable once built, so sharing it across requests is safe.

**Feature-layout mismatches fail loudly.** An artifact trained on an older
feature set will still happily accept a vector of the same width and return a
confident, meaningless number. So the trained feature list is stored alongside
the model and compared on load. A mismatch is reported and — unless the
operator has allowed the heuristic fallback — refuses to serve, because a wrong
score presented as authoritative is worse than an honest 503.

**Metrics are never invented.** ``metrics`` is populated only from what a
training run actually wrote. A bootstrap model reports ``null``.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from . import heuristic
from .config import settings
from .features import CONTRACT, AlignedFeatures

logger = logging.getLogger(__name__)

# Artifact naming: <model_name>-v<version>.json alongside <...>.meta.json
_ARTIFACT_PATTERN = re.compile(r"^(?P<name>.+)-v(?P<version>[0-9]+(?:\.[0-9]+)*)\.json$")


@dataclass
class ModelMetadata:
    """What a training run recorded about the artifact it produced."""

    name: str
    version: str
    feature_set_version: str
    feature_names: list[str]
    trained_at: str | None = None
    # Only what was measured. Absent for an untrained/bootstrap artifact.
    metrics: dict[str, float] | None = None
    training_rows: int | None = None
    notes: str | None = None
    # True when the artifact was fitted on the synthetic bootstrap dataset rather
    # than on real labelled outcomes. Surfaced so nobody mistakes one for the other.
    synthetic: bool = False

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ModelMetadata:
        raw_metrics = payload.get("metrics")
        metrics: dict[str, float] | None = None
        if isinstance(raw_metrics, dict) and raw_metrics:
            metrics = {
                str(k): float(v)
                for k, v in raw_metrics.items()
                if isinstance(v, (int, float))
            }

        return cls(
            name=str(payload.get("name", settings.model_name)),
            version=str(payload.get("version", "0.0.0")),
            feature_set_version=str(payload.get("featureSetVersion", "unknown")),
            feature_names=[str(f) for f in payload.get("featureNames", [])],
            trained_at=payload.get("trainedAt"),
            metrics=metrics,
            training_rows=payload.get("trainingRows"),
            notes=payload.get("notes"),
            synthetic=bool(payload.get("synthetic", False)),
        )


@dataclass
class ScoreResult:
    """Uniform result shape from either engine."""

    probability: float
    confidence: float
    base_value: float
    # (key, attribution, feature_value)
    contributions: list[tuple[str, float, float]]
    method: str
    notes: list[str]


class RiskModel:
    """The loaded scorer. Thread-safe for concurrent inference."""

    def __init__(self) -> None:
        self._booster: Any | None = None
        self._explainer: Any | None = None
        self._metadata: ModelMetadata | None = None
        self._load_error: str | None = None
        self._lock = threading.Lock()

    # -- state -------------------------------------------------------------

    @property
    def loaded(self) -> bool:
        return self._booster is not None

    @property
    def engine(self) -> str:
        return "xgboost" if self.loaded else "heuristic"

    @property
    def metadata(self) -> ModelMetadata | None:
        return self._metadata

    @property
    def load_error(self) -> str | None:
        return self._load_error

    def feature_count(self) -> int:
        if self._metadata and self._metadata.feature_names:
            return len(self._metadata.feature_names)
        return len(CONTRACT.features)

    # -- loading -----------------------------------------------------------

    def load(self) -> None:
        """Resolve and load an artifact. Never raises; records the reason instead."""
        with self._lock:
            self._booster = None
            self._explainer = None
            self._metadata = None
            self._load_error = None

            artifact = self._resolve_artifact()
            if artifact is None:
                self._load_error = (
                    f"No model artifact found in {settings.model_dir} matching "
                    f"'{settings.model_name}' version '{settings.model_version}'. "
                    f"Train one with `python -m training.train`."
                )
                logger.warning(self._load_error)
                return

            model_path, meta_path = artifact

            try:
                import xgboost as xgb
            except ImportError as exc:  # pragma: no cover - dependency is declared
                self._load_error = f"xgboost is not installed: {exc}"
                logger.error(self._load_error)
                return

            try:
                metadata = self._read_metadata(meta_path, model_path)

                booster = xgb.Booster()
                booster.load_model(str(model_path))

                # A model whose columns do not match the contract will score
                # confidently and wrongly. Catch it here.
                mismatch = self._check_feature_alignment(metadata)
                if mismatch is not None:
                    self._load_error = mismatch
                    if not settings.allow_heuristic_fallback:
                        logger.error(
                            "refusing to serve a mismatched model: %s", mismatch
                        )
                        return
                    logger.error(
                        "model feature layout does not match the contract; "
                        "falling back to the heuristic scorer: %s",
                        mismatch,
                    )
                    return

                explainer = self._build_explainer(booster)

                self._booster = booster
                self._explainer = explainer
                self._metadata = metadata

                self._log_loaded(metadata, explainer)

            except Exception as exc:
                self._load_error = f"failed to load {model_path.name}: {exc}"
                logger.exception("model load failed")

    @staticmethod
    def _log_loaded(metadata: ModelMetadata, explainer: object | None) -> None:
        """
        Announce a successful load.

        Isolated in its own try/except on purpose. The booster, explainer and
        metadata are already committed by the time this runs, so a fault *here*
        is a logging fault — but it used to be caught by the caller's
        `except Exception`, which set `_load_error` and logged "model load
        failed". The service then served the heuristic fallback while a
        perfectly good XGBoost model sat loaded in memory, and the log said the
        model could not be read.

        That is exactly what happened: `extra={"name": ...}` collides with
        `LogRecord.name`, which stdlib logging refuses to overwrite —
        `KeyError: Attempt to overwrite 'name' in LogRecord`. Hence `model_name`
        below, and hence this guard, because the next reserved-key collision
        should degrade a log line and nothing else.
        """
        try:
            logger.info(
                "model loaded",
                extra={
                    "model_name": metadata.name,
                    "version": metadata.version,
                    "feature_set_version": metadata.feature_set_version,
                    "features": len(metadata.feature_names),
                    "synthetic": metadata.synthetic,
                    "has_metrics": metadata.metrics is not None,
                    "explainer": explainer is not None,
                },
            )
        except Exception:
            logger.warning(
                "model loaded, but writing the load log line failed", exc_info=True
            )

    def _resolve_artifact(self) -> tuple[Path, Path] | None:
        """Find the artifact to serve, honouring MODEL_VERSION."""
        directory = settings.model_dir
        if not directory.is_dir():
            return None

        candidates: list[tuple[tuple[int, ...], Path]] = []

        for path in directory.glob("*.json"):
            if path.name.endswith(".meta.json"):
                continue
            match = _ARTIFACT_PATTERN.match(path.name)
            if not match or match.group("name") != settings.model_name:
                continue

            version = match.group("version")
            if settings.model_version not in ("latest", version):
                continue

            sortable = tuple(int(part) for part in version.split("."))
            candidates.append((sortable, path))

        if not candidates:
            return None

        # Highest version wins when `latest`.
        candidates.sort(key=lambda item: item[0], reverse=True)
        model_path = candidates[0][1]
        meta_path = model_path.with_suffix("").with_suffix(".meta.json")
        if not meta_path.exists():
            meta_path = model_path.parent / f"{model_path.stem}.meta.json"

        return model_path, meta_path

    def _read_metadata(self, meta_path: Path, model_path: Path) -> ModelMetadata:
        if meta_path.is_file():
            return ModelMetadata.from_dict(
                json.loads(meta_path.read_text(encoding="utf-8"))
            )

        # No sidecar: infer what we can, and be explicit that nothing about its
        # provenance or performance is known.
        match = _ARTIFACT_PATTERN.match(model_path.name)
        logger.warning(
            "no metadata sidecar for %s; provenance and feature layout are unknown",
            model_path.name,
        )
        return ModelMetadata(
            name=settings.model_name,
            version=match.group("version") if match else "0.0.0",
            feature_set_version="unknown",
            feature_names=list(CONTRACT.keys),
            notes="No metadata sidecar was found; feature layout assumed from the contract.",
        )

    def _check_feature_alignment(self, metadata: ModelMetadata) -> str | None:
        """Return a description of any contract mismatch, or None if aligned."""
        if not CONTRACT.loaded:
            return None  # nothing to compare against
        if not metadata.feature_names:
            return None  # unknown layout; already warned

        expected = list(CONTRACT.keys)
        if metadata.feature_names == expected:
            return None

        missing = [k for k in expected if k not in metadata.feature_names]
        extra = [k for k in metadata.feature_names if k not in expected]

        if not missing and not extra:
            return (
                "the model's feature order differs from the contract "
                f"(model v{metadata.version}, contract v{CONTRACT.feature_set_version})"
            )

        return (
            f"model v{metadata.version} was trained on feature set "
            f"v{metadata.feature_set_version}, which does not match the current "
            f"contract v{CONTRACT.feature_set_version}. "
            f"Missing from model: {missing[:5]}. Unknown to contract: {extra[:5]}. "
            f"Retrain with `python -m training.train`."
        )

    def _build_explainer(self, booster: Any) -> Any | None:
        """Build the SHAP TreeExplainer once.

        Explanation is a product requirement, not a nice-to-have, so a failure
        here is logged prominently — but it does not prevent scoring. XGBoost can
        also produce exact tree SHAP values directly via ``pred_contribs``, which
        is the path used when the SHAP package is unavailable.
        """
        try:
            import shap

            explainer = shap.TreeExplainer(booster)
            logger.info("SHAP TreeExplainer ready")
            return explainer
        except Exception as exc:
            logger.warning(
                "could not build a SHAP explainer (%s); falling back to XGBoost's "
                "built-in tree SHAP via pred_contribs, which is numerically equivalent",
                exc,
            )
            return None

    # -- scoring -----------------------------------------------------------

    def score(self, aligned: AlignedFeatures) -> ScoreResult:
        """Score a vector, with attributions."""
        if not self.loaded:
            result = heuristic.score(aligned)
            return ScoreResult(
                probability=result.probability,
                confidence=heuristic.confidence_from_logit(result.probability),
                base_value=result.base_value,
                contributions=result.contributions,
                method="heuristic_weights",
                notes=(
                    result.notes + ([self._load_error] if self._load_error else [])
                ),
            )

        import xgboost as xgb

        matrix = xgb.DMatrix(
            np.asarray([aligned.values], dtype=np.float32),
            feature_names=list(aligned.keys),
        )

        probability = float(self._booster.predict(matrix)[0])  # type: ignore[union-attr]
        base_value, shap_values = self._explain(matrix, aligned)

        contributions = [
            (key, float(shap_values[index]), float(aligned.values[index]))
            for index, key in enumerate(aligned.keys)
        ]

        return ScoreResult(
            probability=probability,
            confidence=heuristic.confidence_from_logit(probability),
            base_value=base_value,
            contributions=contributions,
            method="shap_tree",
            notes=self._scoring_notes(),
        )

    def _explain(self, matrix: Any, aligned: AlignedFeatures) -> tuple[float, np.ndarray]:
        """Exact tree SHAP values for one row, plus the base value."""
        if self._explainer is not None:
            values = self._explainer.shap_values(
                np.asarray([aligned.values], dtype=np.float32)
            )
            row = np.asarray(values)[0] if np.ndim(values) > 1 else np.asarray(values)
            expected = self._explainer.expected_value
            base = float(
                expected[0] if isinstance(expected, (list, np.ndarray)) else expected
            )
            return base, np.asarray(row, dtype=float)

        # XGBoost's own tree SHAP. The final column is the bias/base value.
        contribs = self._booster.predict(matrix, pred_contribs=True)  # type: ignore[union-attr]
        row = np.asarray(contribs)[0]
        return float(row[-1]), np.asarray(row[:-1], dtype=float)

    def _scoring_notes(self) -> list[str]:
        notes: list[str] = []
        meta = self._metadata

        if meta is None:
            return notes

        if meta.synthetic:
            notes.append(
                "This model was fitted on BugDNA's synthetic bootstrap dataset, not on "
                "real labelled incident outcomes. It produces consistent, explainable "
                "rankings, but its absolute probabilities are not calibrated against "
                "production failures. See docs/ML_MODEL.md."
            )

        if meta.metrics is None:
            notes.append(
                "No evaluation metrics were recorded for this model artifact, so no "
                "accuracy claim is made."
            )

        if (
            CONTRACT.loaded
            and meta.feature_set_version not in ("unknown", CONTRACT.feature_set_version)
        ):
            notes.append(
                f"Model was trained against feature set v{meta.feature_set_version}; "
                f"the current contract is v{CONTRACT.feature_set_version}."
            )

        return notes

    # -- reporting ---------------------------------------------------------

    def info(self) -> dict[str, Any]:
        meta = self._metadata

        return {
            "name": meta.name if meta else settings.model_name,
            "version": meta.version if meta else "heuristic-1.0.0",
            "engine": self.engine,
            "feature_set_version": (
                meta.feature_set_version if meta else CONTRACT.feature_set_version
            ),
            "trained_at": meta.trained_at if meta else None,
            "metrics": meta.metrics if meta else None,
            "feature_count": self.feature_count(),
        }


# Module-level singleton, loaded during application startup.
risk_model = RiskModel()
