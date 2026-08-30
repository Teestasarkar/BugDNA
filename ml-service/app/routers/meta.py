"""Health, model and contract introspection.

`/health` is public so orchestrators and the backend's readiness probe can reach
it without a secret. It exposes only what is already visible in the deployment's
own configuration — no feature values, no predictions.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends

from ..config import settings
from ..deps import require_internal_token
from ..features import CONTRACT
from ..model import risk_model
from ..schemas import HealthResponse, ModelInfo

logger = logging.getLogger(__name__)

router = APIRouter(tags=["meta"])


@router.get("/health", response_model=HealthResponse, summary="Liveness and model state")
async def health() -> HealthResponse:
    """Report whether a trained model is serving.

    `degraded` rather than a failure when running on the heuristic fallback: the
    service is answering correctly and the product works, so a load balancer
    should keep sending traffic. The backend surfaces the distinction in the UI
    instead of hiding it.
    """
    loaded = risk_model.loaded

    detail: str | None = None
    if not loaded:
        detail = (
            "Serving the transparent heuristic scorer; no trained model artifact is "
            "loaded. " + (risk_model.load_error or "")
        ).strip()
    elif not CONTRACT.loaded:
        detail = "No feature contract is loaded; features are ordered alphabetically."

    return HealthResponse(
        status="ok" if loaded and CONTRACT.loaded else "degraded",
        model_loaded=loaded,
        engine=risk_model.engine,  # type: ignore[arg-type]
        model_version=risk_model.info()["version"],
        feature_set_version=CONTRACT.feature_set_version,
        detail=detail,
    )


@router.get("/v1/model/info", response_model=ModelInfo, summary="Model metadata")
async def model_info(_: None = Depends(require_internal_token)) -> ModelInfo:
    """What is serving, and what is known about it.

    `metrics` is null unless a training run recorded real evaluation numbers.
    """
    return ModelInfo(**risk_model.info())


@router.post("/v1/model/reload", summary="Reload the model artifact from disk")
async def reload_model(_: None = Depends(require_internal_token)) -> dict[str, object]:
    """Pick up a newly trained artifact without restarting the container.

    Useful because retraining writes to a mounted volume; the alternative is a
    rolling restart for what is a file read.
    """
    risk_model.load()

    logger.info(
        "model reloaded on request",
        extra={"loaded": risk_model.loaded, "engine": risk_model.engine},
    )

    return {
        "reloaded": True,
        "loaded": risk_model.loaded,
        "engine": risk_model.engine,
        "model": risk_model.info(),
        "error": risk_model.load_error,
    }


@router.get("/v1/features", summary="The feature contract this service is aligned to")
async def features(_: None = Depends(require_internal_token)) -> dict[str, object]:
    """Expose the loaded contract.

    Makes a mismatch between the backend's extractor and this service's model
    diagnosable from outside, rather than requiring a look at both containers.
    """
    return {
        "featureSetVersion": CONTRACT.feature_set_version,
        "loaded": CONTRACT.loaded,
        "source": CONTRACT.source,
        "featureCount": len(CONTRACT.features),
        "riskBands": [
            {"level": b.level, "min": b.min, "max": b.max} for b in CONTRACT.risk_bands
        ],
        "features": [
            {
                "key": spec.key,
                "label": spec.label,
                "category": spec.category,
                "type": spec.type,
                "unit": spec.unit,
                "fallback": spec.fallback,
                "expectedDirection": spec.expected_direction,
                "heuristicWeight": spec.heuristic_weight,
                "requiresHistory": spec.requires_history,
            }
            for spec in CONTRACT.features
        ],
        "modelDir": str(settings.model_dir),
    }
