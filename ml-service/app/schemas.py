"""Request and response models.

These mirror `backend/src/modules/ml/ml.types.ts`. The two files are the two
halves of one wire contract, and both are deliberately narrow: features in, score
and attributions out. Nothing about XGBoost or SHAP crosses this boundary beyond
a label naming which produced the answer — which is what lets the model be
retrained or replaced without touching the product backend.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

RiskLevel = Literal["LOW", "MODERATE", "HIGH", "CRITICAL"]
Engine = Literal["xgboost", "heuristic"]
ExplanationMethod = Literal["shap_tree", "heuristic_weights"]


class PredictContext(BaseModel):
    """Traceability only.

    Logged so a score can be tied back to the analysis that requested it. These
    values are **never** used as model inputs — a repository name is not a risk
    signal, and treating it as one would make the model memorise projects instead
    of learning about changes.
    """

    analysis_id: str = Field(max_length=64)
    repository: str = Field(max_length=256)
    pull_request_number: int = Field(ge=0)


class PredictRequest(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    feature_set_version: str = Field(
        max_length=32,
        description="Version of the feature contract the caller extracted against.",
    )
    features: dict[str, float] = Field(
        description="Feature key -> numeric value. Keys must match the shared contract.",
    )
    context: PredictContext | None = None
    max_contributions: int = Field(default=12, ge=1, le=100)


class ModelInfo(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    name: str
    version: str
    engine: Engine
    feature_set_version: str
    trained_at: str | None = None
    # Populated only when the operator supplied evaluation metrics at training
    # time. Never invented: an untrained or bootstrap model reports null, because
    # quoting an accuracy figure BugDNA has not measured would be a fabrication.
    metrics: dict[str, float] | None = None
    feature_count: int


class Prediction(BaseModel):
    probability: float = Field(ge=0.0, le=1.0)
    risk_score: float = Field(ge=0.0, le=100.0)
    risk_level: RiskLevel
    # Distance from the decision boundary, rescaled to 0-1. For the bootstrap
    # model this is a rough confidence signal, not a calibrated uncertainty
    # estimate — documented in docs/ML_MODEL.md.
    confidence: float = Field(ge=0.0, le=1.0)


class Contribution(BaseModel):
    key: str
    # SHAP value in the model's log-odds space. Sign carries direction:
    # positive pushes risk up.
    shap_value: float
    feature_value: float
    # Share of total absolute movement, 0-100, for comparable bar widths.
    contribution: float


class Explanation(BaseModel):
    # SHAP base value: the model's expected output over its training set. The
    # contributions explain the journey from here to this prediction.
    base_value: float
    contributions: list[Contribution]
    method: ExplanationMethod
    notes: list[str] = Field(default_factory=list)


class PredictResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    model: ModelInfo
    prediction: Prediction
    explanation: Explanation
    warnings: list[str] = Field(default_factory=list)
    latency_ms: float


class HealthResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    status: Literal["ok", "degraded"]
    model_loaded: bool
    engine: Engine
    model_version: str | None
    feature_set_version: str
    detail: str | None = None


class ErrorDetail(BaseModel):
    code: str
    message: str
    details: dict | list | str | None = None


class ErrorResponse(BaseModel):
    error: ErrorDetail
