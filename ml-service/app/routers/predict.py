"""Prediction endpoint.

The whole public surface of the risk service is essentially this one call:
a feature vector in, a score plus ranked attributions out.
"""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Depends, HTTPException, status

from ..config import settings
from ..deps import require_internal_token
from ..features import CONTRACT, align
from ..model import risk_model
from ..schemas import (
    Contribution,
    Explanation,
    ModelInfo,
    Prediction,
    PredictRequest,
    PredictResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1", tags=["prediction"])


@router.post(
    "/predict",
    response_model=PredictResponse,
    summary="Score a pull request's feature vector and explain the result",
)
async def predict(
    request: PredictRequest,
    _: None = Depends(require_internal_token),
) -> PredictResponse:
    started = time.perf_counter()

    if not request.features:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "EMPTY_FEATURES",
                "message": "At least one feature is required to score a pull request.",
            },
        )

    # Neither engine can score without a model or weights, so if the heuristic
    # fallback is disabled and no model loaded, say so rather than returning a
    # number from nowhere.
    if not risk_model.loaded and not settings.allow_heuristic_fallback:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "MODEL_NOT_LOADED",
                "message": (
                    "No risk model is loaded and the heuristic fallback is disabled. "
                    "Train a model or set ALLOW_HEURISTIC_FALLBACK=true."
                ),
                "details": risk_model.load_error,
            },
        )

    warnings: list[str] = []

    # A feature-set mismatch is the caller's problem to know about: the score is
    # still produced (aligned to this service's contract), but the response says
    # the two sides disagree.
    if (
        CONTRACT.loaded
        and request.feature_set_version != CONTRACT.feature_set_version
    ):
        warnings.append(
            f"Caller extracted features against v{request.feature_set_version}, but this "
            f"service is aligned to v{CONTRACT.feature_set_version}. Values were mapped by "
            f"key; regenerate contracts/feature-spec.json on both sides to remove this warning."
        )

    aligned = align(request.features)
    warnings.extend(aligned.warnings)

    result = risk_model.score(aligned)

    # The model returns a probability; the presented 0-100 score is a linear
    # rescaling of it. Deliberately not a curve — a monotonic transform the
    # product could not explain would make the number less trustworthy, not more.
    probability = max(0.0, min(1.0, result.probability))
    risk_score = round(probability * 100.0, 1)

    contributions = _rank_contributions(result.contributions, request.max_contributions)

    response = PredictResponse(
        model=ModelInfo(**risk_model.info()),
        prediction=Prediction(
            probability=round(probability, 6),
            risk_score=risk_score,
            risk_level=CONTRACT.level_for_score(risk_score),
            confidence=result.confidence,
        ),
        explanation=Explanation(
            base_value=round(result.base_value, 6),
            contributions=contributions,
            method=result.method,  # type: ignore[arg-type]
            notes=result.notes,
        ),
        warnings=warnings,
        latency_ms=round((time.perf_counter() - started) * 1000, 2),
    )

    logger.info(
        "prediction served",
        extra={
            "analysis_id": request.context.analysis_id if request.context else None,
            "repository": request.context.repository if request.context else None,
            "pull_request": (
                request.context.pull_request_number if request.context else None
            ),
            "engine": response.model.engine,
            "model_version": response.model.version,
            "risk_score": risk_score,
            "risk_level": response.prediction.risk_level,
            "contributions": len(contributions),
            "warnings": len(warnings),
            "latency_ms": response.latency_ms,
        },
    )

    return response


def _rank_contributions(
    raw: list[tuple[str, float, float]],
    limit: int,
) -> list[Contribution]:
    """Rank by absolute influence and normalise to comparable shares.

    Both directions are kept. An explanation that lists only what is wrong makes
    a low score look arbitrary — showing that tests were included and the author
    knows the module is what makes a LOW assessment credible.
    """
    total = sum(abs(value) for _, value, _ in raw)
    ordered = sorted(raw, key=lambda item: abs(item[1]), reverse=True)
    capped = ordered[: min(limit, settings.shap_max_features_returned)]

    return [
        Contribution(
            key=key,
            shap_value=round(shap_value, 6),
            feature_value=round(feature_value, 6),
            contribution=round((abs(shap_value) / total) * 100.0, 2) if total > 0 else 0.0,
        )
        for key, shap_value, feature_value in capped
    ]
