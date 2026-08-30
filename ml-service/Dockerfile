# =============================================================================
# BugDNA risk service
# =============================================================================
# Two stages so the compiler toolchain needed to build wheels (numpy, xgboost,
# shap) does not ship in the runtime image.

# ---------------------------------------------------------------------------
# Stage 1 — build wheels
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# libgomp is needed to *link* xgboost; build-essential for any sdist fallback.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY ml-service/requirements.txt ./
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install -r requirements.txt

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

# libgomp1 is a runtime requirement of xgboost's OpenMP support — without it the
# import fails with an opaque loader error.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

# Run as a non-root user. The service reads model files and answers HTTP; it has
# no reason to be able to write anywhere but its model directory.
RUN groupadd --system --gid 1001 bugdna \
    && useradd --system --uid 1001 --gid bugdna --create-home bugdna

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app

WORKDIR /app

COPY --chown=bugdna:bugdna ml-service/app ./app
COPY --chown=bugdna:bugdna ml-service/training ./training
COPY --chown=bugdna:bugdna ml-service/docker-entrypoint.sh ./docker-entrypoint.sh

# The feature contract is generated in the backend and committed at the repo
# root, which is why this image builds from the root context (see
# docker-compose.yml). Without it the service runs in permissive mode.
COPY --chown=bugdna:bugdna contracts ./contracts

RUN mkdir -p /app/models /app/data \
    && chown -R bugdna:bugdna /app/models /app/data \
    && chmod +x ./docker-entrypoint.sh

USER bugdna

ENV ML_PORT=8000 \
    MODEL_DIR=/app/models \
    CONTRACTS_DIR=/app/contracts \
    MODEL_NAME=bugdna-risk \
    MODEL_VERSION=latest

EXPOSE 8000

# Reports `degraded` rather than failing when running on the heuristic fallback,
# so a missing model artifact does not take the container out of rotation.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD curl -fsS http://localhost:8000/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
# Wrapped in a shell so the port is resolved at start time. `PORT` is what
# every PaaS injects and routes to; `ML_PORT` is our own name for it; 8000 is
# the Compose default. A hardcoded port here would work on Render only
# because it sniffs listening sockets, which is not a guarantee to lean on.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-${ML_PORT:-8000}} --log-config none"]
