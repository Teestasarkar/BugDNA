"""Load the trained model and turn feature vectors into scores and explanations.

SHAP values come from XGBoost's built-in TreeSHAP (`pred_contribs=True`), the
same exact algorithm the `shap` package's TreeExplainer runs; training asserts
the two agree. Using the built-in keeps the serving image small.
"""

from __future__ import annotations

import json
import math
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import xgboost as xgb

from .explain import Factor, risk_shares, top_factors
from .features import FEATURE_NAMES

DEFAULT_ARTIFACTS = Path(__file__).resolve().parent.parent / "artifacts"


def artifacts_dir() -> Path:
    """Where the trained model lives; RISKRADAR_ARTIFACTS overrides it (tests, alternative builds)."""
    return Path(os.environ.get("RISKRADAR_ARTIFACTS") or DEFAULT_ARTIFACTS)


@dataclass(frozen=True)
class Score:
    probability: float
    percentile: float          # share of validation PRs scored lower, 0-100
    band: str                  # HIGH (flagged) | MEDIUM | LOW
    flagged: bool
    high_recall_flagged: bool  # flagged in high-recall mode (catches >=80% of defects on validation)
    base_value: float          # model output (log-odds) before any feature contributes
    contributions: dict[str, float]
    factors: list[Factor]

    def to_dict(self) -> dict:
        return {
            "probability": round(self.probability, 4), "percentile": round(self.percentile, 1),
            "band": self.band, "flagged": self.flagged, "high_recall_flagged": self.high_recall_flagged,
            "base_value": round(self.base_value, 4),
            "contributions": {k: round(v, 4) for k, v in self.contributions.items()},
            "shares": {k: round(v, 1) for k, v in sorted(risk_shares(self.contributions).items(),
                                                          key=lambda kv: -kv[1])},
            "factors": [f.to_dict() for f in self.factors],
        }


def to_matrix(rows: Sequence[Mapping[str, float]]) -> np.ndarray:
    return np.array([[float(r.get(n, math.nan)) for n in FEATURE_NAMES] for r in rows], dtype=np.float32)


class RiskModel:
    def __init__(self, directory: Path | None = None) -> None:
        directory = directory or artifacts_dir()
        meta = json.loads((directory / "model_meta.json").read_text())
        if tuple(meta["features"]) != FEATURE_NAMES:
            raise RuntimeError("model was trained on a different feature set than this code defines")
        self.meta = meta
        self.threshold: float = meta["threshold"]
        self.high_recall_threshold: float = meta.get("high_recall_threshold", meta["threshold"])
        self.medians: dict[str, float] = meta["medians"]
        self._val_sorted = np.array(meta["validation_probabilities"], dtype=np.float64)
        self.booster = xgb.Booster()
        self.booster.load_model(str(directory / "model.json"))

    def percentile(self, p: float) -> float:
        return 100.0 * float(np.searchsorted(self._val_sorted, p, side="left")) / max(1, len(self._val_sorted))

    def band(self, p: float, pct: float) -> str:
        if p >= self.threshold:
            return "HIGH"
        return "MEDIUM" if pct >= 50 else "LOW"

    def contributions(self, x: np.ndarray) -> np.ndarray:
        """TreeSHAP values for a feature matrix (rows x features, without the bias column)."""
        dm = xgb.DMatrix(x.astype(np.float32), feature_names=list(FEATURE_NAMES), missing=math.nan)
        return self.booster.predict(dm, pred_contribs=True)[:, :-1]

    def score(self, rows: Sequence[Mapping[str, float]], contexts: Sequence[Mapping] | None = None,
              k: int = 3) -> list[Score]:
        dm = xgb.DMatrix(to_matrix(rows), feature_names=list(FEATURE_NAMES), missing=math.nan)
        probs = self.booster.predict(dm)
        contribs = self.booster.predict(dm, pred_contribs=True)
        out = []
        for i, row in enumerate(rows):
            p = float(probs[i])
            c = {n: float(contribs[i, j]) for j, n in enumerate(FEATURE_NAMES)}
            pct = self.percentile(p)
            ctx = contexts[i] if contexts else None
            out.append(Score(probability=p, percentile=pct, band=self.band(p, pct), flagged=p >= self.threshold,
                             high_recall_flagged=p >= self.high_recall_threshold,
                             base_value=float(contribs[i, -1]), contributions=c,
                             factors=top_factors(row, c, self.medians, ctx, k=k)))
        return out
