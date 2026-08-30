"""BugDNA risk service.

A deliberately small FastAPI application whose entire job is: given a feature
vector describing a pull request, return a risk probability and an explanation of
which features drove it.

Keeping this separate from the product backend is the point. It means the model
can be retrained, re-tuned, or swapped for a different algorithm entirely without
touching the Node codebase, and it means the ML dependency tree (xgboost, shap,
numpy) never enters the API's runtime.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .config import settings
from .features import CONTRACT
from .logging_conf import configure_logging
from .model import risk_model
from .routers import meta, predict

configure_logging()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Load the model once, at startup.

    Loading lazily on the first request would put SHAP explainer construction —
    hundreds of milliseconds — on a user-facing path, and would hide a broken
    artifact until someone tried to use it.
    """
    logger.info(
        "starting BugDNA risk service",
        extra={
            "environment": settings.environment,
            "model_dir": str(settings.model_dir),
            "model_name": settings.model_name,
            "model_version": settings.model_version,
            "feature_contract": CONTRACT.source,
            "feature_set_version": CONTRACT.feature_set_version,
            "feature_count": len(CONTRACT.features),
            "heuristic_fallback": settings.allow_heuristic_fallback,
        },
    )

    if settings.is_production and not settings.service_token:
        # Refuses to start rather than silently serving an unauthenticated
        # scoring endpoint in production.
        raise RuntimeError(
            "ML_SERVICE_TOKEN must be set in production. The risk service accepts "
            "feature vectors and must not be reachable without the shared secret."
        )

    risk_model.load()

    if risk_model.loaded:
        logger.info("ready", extra={"engine": "xgboost", "model": risk_model.info()})
    elif settings.allow_heuristic_fallback:
        logger.warning(
            "ready on the heuristic fallback — no trained model artifact is loaded",
            extra={"reason": risk_model.load_error},
        )
    else:
        logger.error(
            "no model loaded and the heuristic fallback is disabled; /v1/predict "
            "will return 503",
            extra={"reason": risk_model.load_error},
        )

    yield

    logger.info("shutting down")


app = FastAPI(
    title="BugDNA Risk Service",
    description=(
        "Internal scoring and explainability service for BugDNA. Accepts a "
        "pull-request feature vector and returns a risk probability with per-feature "
        "SHAP attributions."
    ),
    version="1.0.0",
    lifespan=lifespan,
    # No CORS: this service is never called from a browser. The only client is
    # the BugDNA API, over a private network.
    docs_url="/docs",
    redoc_url=None,
    openapi_url="/openapi.json",
)

app.include_router(meta.router)
app.include_router(predict.router)


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------
# Matches the backend's error envelope, so a failure from either service reads
# the same way in logs and in the UI.


@app.exception_handler(RequestValidationError)
async def validation_error_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    logger.warning(
        "request validation failed",
        extra={"path": request.url.path, "errors": exc.errors()[:5]},
    )
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "error": {
                "code": "VALIDATION_FAILED",
                "message": "The request body did not match the expected schema.",
                "details": [
                    {
                        "field": ".".join(str(p) for p in err.get("loc", [])),
                        "message": err.get("msg"),
                    }
                    for err in exc.errors()[:20]
                ],
            }
        },
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Log the detail, return none of it.

    An unexpected exception here is a bug in the scoring path; its message could
    contain feature values or file paths, so the client gets a generic 500 and the
    detail goes to the log.
    """
    logger.exception(
        "unhandled error", extra={"path": request.url.path, "error_type": type(exc).__name__}
    )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "error": {
                "code": "INTERNAL",
                "message": "The risk service encountered an unexpected error.",
            }
        },
    )


@app.get("/", include_in_schema=False)
async def root() -> dict[str, object]:
    return {
        "service": "bugdna-ml",
        "version": "1.0.0",
        "engine": risk_model.engine,
        "featureSetVersion": CONTRACT.feature_set_version,
        "endpoints": ["/health", "/v1/predict", "/v1/model/info", "/v1/features", "/docs"],
    }


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=settings.ml_port,
        log_config=None,  # logging_conf owns formatting
    )
