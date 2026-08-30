"""Train the BugDNA risk model.

Two modes, and the difference between them is the whole point:

**Real data** (``--data path/to/pull_requests.csv --target caused_incident``)
    Trains on outcomes an operator has actually observed. Evaluation metrics from
    a held-out split are written into the artifact metadata and reported by
    ``/v1/model/info``, because they mean something.

**Bootstrap** (no ``--data``)
    Trains on the synthetic dataset. The artifact is marked ``synthetic: true``
    and its ``metrics`` field is left **null**, so the service never quotes an
    accuracy figure derived from data BugDNA invented. Holdout numbers from the
    synthetic split are still recorded, under a clearly separate
    ``syntheticHoldout`` key, purely so a developer can confirm training worked.

Nothing here assumes a target definition. What counts as a "bad" pull request is
a product decision — "implicated in a production incident within 7 days of
merge", "required a revert", "triggered a rollback" are all defensible, and they
imply different models. ``--target`` names the column; the choice stays with the
operator, and is recorded in the metadata.

Hyperparameters are equally configurable. The defaults are conservative settings
appropriate for a small tabular binary-classification problem — not values tuned
against any benchmark, and labelled as such.

Usage
-----
    # bootstrap, so the pipeline runs on a fresh install
    python -m training.generate_bootstrap_dataset
    python -m training.train --version 1.0.0

    # real data
    python -m training.train --data data/history.csv --target caused_incident --version 2.0.0

    # override hyperparameters
    python -m training.train --params '{"max_depth": 5, "eta": 0.05}'
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings
from app.features import CONTRACT

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("train")


# ---------------------------------------------------------------------------
# Hyperparameters
# ---------------------------------------------------------------------------
# Reasonable defaults for a few-thousand-row tabular binary classification task:
# shallow trees and a low learning rate, which resist overfitting on small data.
# These are **not** tuned against a benchmark. Override with --params.

DEFAULT_PARAMS: dict[str, Any] = {
    "objective": "binary:logistic",
    "eval_metric": ["logloss", "auc"],
    "max_depth": 4,
    "eta": 0.08,
    "subsample": 0.85,
    "colsample_bytree": 0.85,
    "min_child_weight": 8,
    "gamma": 0.5,
    "reg_lambda": 2.0,
    "reg_alpha": 0.5,
    # Determinism matters: the same data must produce the same artifact.
    "seed": 20260830,
    "tree_method": "hist",
}

DEFAULT_ROUNDS = 400
EARLY_STOPPING_ROUNDS = 40


def load_dataset(
    path: Path, target: str, feature_keys: list[str]
) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """Read a CSV and align it to the feature contract.

    Missing feature columns are a hard error rather than being filled: silently
    training on a subset of the contract produces a model whose vector layout
    does not match what the service will send it, and the mismatch would only
    surface as quietly wrong scores.
    """
    import pandas as pd

    frame = pd.read_csv(path)

    if target not in frame.columns:
        raise SystemExit(
            f"Target column '{target}' is not present in {path}.\n"
            f"Available columns: {', '.join(frame.columns[:20])}\n"
            f"Name the outcome column with --target."
        )

    missing = [key for key in feature_keys if key not in frame.columns]
    if missing:
        raise SystemExit(
            f"{len(missing)} feature column(s) required by feature set "
            f"v{CONTRACT.feature_set_version} are missing from {path}:\n"
            f"  {', '.join(missing[:12])}"
            f"{f' and {len(missing) - 12} more' if len(missing) > 12 else ''}\n\n"
            f"Every feature in contracts/feature-spec.json must be present, so the "
            f"trained model's vector layout matches what the service sends at "
            f"inference time."
        )

    extra = [c for c in frame.columns if c not in feature_keys and c != target]
    if extra:
        logger.info(
            "  ignoring %d non-contract column(s): %s",
            len(extra),
            ", ".join(extra[:8]),
        )

    features = frame[feature_keys].astype(float)
    labels = frame[target]

    # Accept 0/1, bool, or yes/no.
    if labels.dtype == object:
        labels = (
            labels.astype(str)
            .str.strip()
            .str.lower()
            .map(
                {
                    "1": 1, "true": 1, "yes": 1, "y": 1,
                    "0": 0, "false": 0, "no": 0, "n": 0,
                }
            )
        )

    if labels.isna().any():
        raise SystemExit(
            f"Target column '{target}' contains {int(labels.isna().sum())} value(s) that "
            f"could not be read as a binary label."
        )

    labels = labels.astype(int)

    unique = sorted(labels.unique())
    if set(unique) - {0, 1}:
        raise SystemExit(
            f"Target column '{target}' must be binary (0/1). Found: {unique[:10]}"
        )
    if len(unique) < 2:
        raise SystemExit(
            f"Target column '{target}' contains only the value {unique[0]}. "
            f"Training needs both positive and negative examples."
        )

    # NaNs are legitimate in XGBoost (it learns a default direction), but for
    # this feature set they mean an extractor failed, so fill with the contract's
    # documented neutral values instead.
    for key in feature_keys:
        spec = CONTRACT.spec(key)
        if spec is not None:
            features[key] = features[key].fillna(spec.fallback)

    return (
        features.to_numpy(dtype=np.float32),
        labels.to_numpy(dtype=np.int32),
        feature_keys,
    )


def evaluate(booster: Any, matrix: Any, y_true: np.ndarray) -> dict[str, float]:
    """Compute holdout metrics.

    Reports precision/recall/F1 alongside AUC and Brier, because for a risk
    product the operating point matters more than a single ranking number — a
    model that flags everything has excellent recall and is useless.
    """
    from sklearn.metrics import (
        average_precision_score,
        brier_score_loss,
        f1_score,
        log_loss,
        precision_score,
        recall_score,
        roc_auc_score,
    )

    probabilities = booster.predict(matrix)
    predictions = (probabilities >= 0.5).astype(int)

    metrics = {
        "rocAuc": float(roc_auc_score(y_true, probabilities)),
        "averagePrecision": float(average_precision_score(y_true, probabilities)),
        "logLoss": float(log_loss(y_true, probabilities, labels=[0, 1])),
        # Brier score: mean squared error of the probabilities. Directly measures
        # calibration, which is what matters when a number is shown to a user.
        "brierScore": float(brier_score_loss(y_true, probabilities)),
        "precisionAt50": float(precision_score(y_true, predictions, zero_division=0)),
        "recallAt50": float(recall_score(y_true, predictions, zero_division=0)),
        "f1At50": float(f1_score(y_true, predictions, zero_division=0)),
        "positiveRate": float(y_true.mean()),
        "holdoutRows": len(y_true),
    }

    return {k: round(v, 6) for k, v in metrics.items()}


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the BugDNA risk model.")
    parser.add_argument(
        "--data",
        type=Path,
        default=None,
        help=(
            "CSV of historical pull requests with the contract's feature columns plus a "
            "binary target. Omit to train on the synthetic bootstrap dataset."
        ),
    )
    parser.add_argument(
        "--target",
        default="caused_incident",
        help=(
            "Name of the binary outcome column. The definition of this outcome is a "
            "product decision and is recorded in the artifact metadata."
        ),
    )
    parser.add_argument("--version", default=None, help="artifact version, e.g. 1.0.0")
    parser.add_argument("--model-name", default=None, help="defaults to MODEL_NAME")
    parser.add_argument("--out-dir", type=Path, default=None, help="defaults to MODEL_DIR")
    parser.add_argument("--rounds", type=int, default=DEFAULT_ROUNDS)
    parser.add_argument("--test-size", type=float, default=0.2)
    parser.add_argument(
        "--params",
        default=None,
        help='JSON object of XGBoost parameter overrides, e.g. \'{"max_depth": 5}\'',
    )
    parser.add_argument(
        "--notes", default=None, help="free-text note stored in the artifact metadata"
    )
    args = parser.parse_args()

    if not CONTRACT.loaded:
        raise SystemExit(
            "No feature contract found. Run `npm run contracts:generate` in backend/, "
            "and make contracts/feature-spec.json reachable (CONTRACTS_DIR)."
        )

    try:
        import xgboost as xgb
        from sklearn.model_selection import train_test_split
    except ImportError as exc:
        raise SystemExit(
            f"Missing a training dependency ({exc}). Install with:\n"
            f"  pip install -r requirements.txt"
        ) from exc

    feature_keys = list(CONTRACT.keys)
    model_name = args.model_name or settings.model_name
    out_dir = args.out_dir or settings.model_dir
    version = args.version or datetime.now(tz=UTC).strftime("%Y.%m.%d")

    # ---- resolve the dataset ----------------------------------------------
    synthetic = args.data is None
    data_path = args.data

    if synthetic:
        candidate = Path("data/bootstrap.csv")
        if not candidate.is_file():
            raise SystemExit(
                "No --data supplied and data/bootstrap.csv does not exist.\n"
                "Generate the synthetic bootstrap dataset first:\n"
                "  python -m training.generate_bootstrap_dataset"
            )
        data_path = candidate
        logger.warning(
            "\nTraining on the SYNTHETIC bootstrap dataset.\n"
            "  The resulting model approximates BugDNA's documented heuristic; it does\n"
            "  not predict real incidents. It will be marked synthetic and will report\n"
            "  no accuracy metrics. Supply --data with real outcomes for a meaningful\n"
            "  model. See docs/ML_MODEL.md.\n"
        )

    logger.info("Loading %s", data_path)
    features, labels, feature_names = load_dataset(data_path, args.target, feature_keys)

    logger.info(
        "  %d rows, %d features, %.1f%% positive",
        len(labels),
        features.shape[1],
        100 * labels.mean(),
    )

    # ---- split -------------------------------------------------------------
    x_train, x_test, y_train, y_test = train_test_split(
        features,
        labels,
        test_size=args.test_size,
        random_state=DEFAULT_PARAMS["seed"],
        stratify=labels,
    )

    train_matrix = xgb.DMatrix(x_train, label=y_train, feature_names=feature_names)
    test_matrix = xgb.DMatrix(x_test, label=y_test, feature_names=feature_names)

    # ---- parameters --------------------------------------------------------
    params = dict(DEFAULT_PARAMS)
    if args.params:
        try:
            params.update(json.loads(args.params))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"--params is not valid JSON: {exc}") from exc

    # Rebalance when the positive class is rare, so the model does not simply
    # learn to predict "safe" for everything.
    positives = int(y_train.sum())
    negatives = int(len(y_train) - positives)
    if positives > 0 and negatives / positives > 3:
        params["scale_pos_weight"] = round(negatives / positives, 3)
        logger.info(
            "  applying scale_pos_weight=%s for class imbalance",
            params["scale_pos_weight"],
        )

    logger.info(
        "Training (max %d rounds, early stopping after %d)",
        args.rounds,
        EARLY_STOPPING_ROUNDS,
    )

    evals_result: dict[str, dict[str, list[float]]] = {}
    booster = xgb.train(
        params,
        train_matrix,
        num_boost_round=args.rounds,
        evals=[(train_matrix, "train"), (test_matrix, "holdout")],
        early_stopping_rounds=EARLY_STOPPING_ROUNDS,
        evals_result=evals_result,
        verbose_eval=50,
    )

    best_iteration = getattr(booster, "best_iteration", None)
    logger.info(
        "  stopped at iteration %s",
        best_iteration if best_iteration is not None else args.rounds,
    )

    # ---- evaluate ----------------------------------------------------------
    holdout_metrics = evaluate(booster, test_matrix, y_test)

    logger.info("Holdout metrics:")
    for key, value in holdout_metrics.items():
        logger.info("  %-20s %s", key, value)

    # Gain-based importance, useful for inspecting what the model leaned on.
    # Not presented as validated feature importance anywhere in the product.
    importance = booster.get_score(importance_type="gain")
    top = sorted(importance.items(), key=lambda kv: kv[1], reverse=True)[:12]
    logger.info("Top features by gain:")
    for key, gain in top:
        logger.info("  %-36s %.2f", key, gain)

    # ---- write the artifact ------------------------------------------------
    out_dir.mkdir(parents=True, exist_ok=True)
    model_path = out_dir / f"{model_name}-v{version}.json"
    meta_path = out_dir / f"{model_name}-v{version}.meta.json"

    booster.save_model(str(model_path))

    metadata: dict[str, Any] = {
        "name": model_name,
        "version": version,
        "featureSetVersion": CONTRACT.feature_set_version,
        "featureNames": feature_names,
        "trainedAt": datetime.now(tz=UTC).isoformat(),
        "trainingRows": len(labels),
        "synthetic": synthetic,
        "target": {
            "column": args.target,
            "definition": (
                "SYNTHETIC: generated from BugDNA's documented heuristic weights plus noise."
                if synthetic
                else (
                    "Operator-supplied. See the dataset's own documentation for "
                    "what this column means."
                )
            ),
            "positiveRate": round(float(labels.mean()), 6),
        },
        "hyperparameters": params,
        "bestIteration": best_iteration,
        "engine": "xgboost",
        "xgboostVersion": xgb.__version__,
        "topFeaturesByGain": [{"key": k, "gain": round(v, 4)} for k, v in top],
        "notes": args.notes,
    }

    if synthetic:
        # The crucial distinction: no `metrics` key, so /v1/model/info reports
        # null and the service adds its "no accuracy claim is made" note. The
        # numbers are still recorded, under a name that cannot be mistaken for a
        # real-world result.
        metadata["metrics"] = None
        metadata["syntheticHoldout"] = holdout_metrics
        metadata["warning"] = (
            "Trained on synthetic data whose labels were derived from BugDNA's own "
            "heuristic weights. The holdout numbers under `syntheticHoldout` measure "
            "how well the model reproduces that heuristic, NOT how well it predicts "
            "production incidents. No accuracy claim about real-world failures is "
            "supported by this artifact."
        )
    else:
        metadata["metrics"] = holdout_metrics
        metadata["evaluation"] = {
            "method": "stratified holdout",
            "testSize": args.test_size,
            "seed": DEFAULT_PARAMS["seed"],
        }

    meta_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

    logger.info("")
    logger.info("Wrote %s", model_path)
    logger.info("Wrote %s", meta_path)
    logger.info("")

    if synthetic:
        logger.warning(
            "This artifact is marked synthetic. The service will serve it and will\n"
            "  state on every prediction that it was not fitted on real outcomes.\n"
        )

    logger.info("Reload the running service to pick it up:")
    logger.info("  curl -X POST localhost:%d/v1/model/reload \\", settings.ml_port)
    logger.info('    -H "x-internal-token: $ML_SERVICE_TOKEN"')


if __name__ == "__main__":
    main()
