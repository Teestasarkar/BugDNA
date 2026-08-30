#!/bin/sh
# =============================================================================
# BugDNA risk service entrypoint
# =============================================================================
# Ensures a model artifact exists before serving, so a fresh `docker compose up`
# produces genuine XGBoost predictions with real SHAP attributions rather than
# falling back to the heuristic scorer.
#
# The bootstrap model is trained on synthetic data and is marked as such in its
# metadata — the service discloses that on every prediction. Set
# BOOTSTRAP_MODEL_ON_START=false to skip this and rely on a mounted artifact (or
# the heuristic fallback).
set -e

MODEL_DIR="${MODEL_DIR:-/app/models}"
MODEL_NAME="${MODEL_NAME:-bugdna-risk}"
BOOTSTRAP="${BOOTSTRAP_MODEL_ON_START:-true}"
BOOTSTRAP_ROWS="${BOOTSTRAP_ROWS:-12000}"

existing_model="$(find "$MODEL_DIR" -maxdepth 1 -name "${MODEL_NAME}-v*.json" ! -name '*.meta.json' 2>/dev/null | head -n 1)"

if [ -n "$existing_model" ]; then
  echo "[entrypoint] using existing model artifact: $(basename "$existing_model")"
elif [ "$BOOTSTRAP" != "true" ]; then
  echo "[entrypoint] no model artifact found and BOOTSTRAP_MODEL_ON_START=false."
  echo "[entrypoint] the service will serve its transparent heuristic scorer."
else
  echo "[entrypoint] no model artifact found — training a bootstrap model."
  echo "[entrypoint] NOTE: this is fitted on SYNTHETIC data and is marked as such."
  echo "[entrypoint]       it exists so the pipeline runs end to end on a fresh install."

  if python -m training.generate_bootstrap_dataset --rows "$BOOTSTRAP_ROWS" --out /app/data/bootstrap.csv \
    && python -m training.train --version 1.0.0 --out-dir "$MODEL_DIR"; then
    echo "[entrypoint] bootstrap model ready."
  else
    # Never block startup on training: the heuristic fallback keeps the product
    # working, and the failure is visible in /health.
    echo "[entrypoint] WARNING: bootstrap training failed; falling back to the heuristic scorer." >&2
  fi
fi

exec "$@"
