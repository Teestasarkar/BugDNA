"""Train and evaluate the XGBoost risk model.

    python -m training.train

Evaluation protocol (decided before looking at any test number):
  * Split each repository chronologically: its oldest 60% of PRs train, the
    next 20% validate, the newest 20% test. The model never sees the future of
    a repository it is evaluated on.
  * Hyperparameters, early stopping and the decision threshold are chosen on
    validation only. The test split is scored once, by the final model.
  * Two operating points are fixed on validation: "balanced" maximises F1;
    "high recall" is the highest threshold that still catches at least 80% of
    validation defects. Precision and recall are reported on test at both.
  * Reported alongside: a size-only baseline, logistic regression on the same
    features, and leave-repositories-out cross-validation (how well the model
    transfers to a repository it has never seen).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    f1_score,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from riskradar.dataset import read_prs
from riskradar.features import FEATURE_NAMES, FEATURES

ROOT = Path(__file__).resolve().parent.parent
SEED = 7
SPLIT = (0.6, 0.2, 0.2)


def chronological_split(df: pd.DataFrame) -> pd.Series:
    split = pd.Series("train", index=df.index)
    for _, g in df.groupby("repo"):
        g = g.sort_values(["merged_at", "number"])
        n = len(g)
        n_train, n_val = int(round(n * SPLIT[0])), int(round(n * SPLIT[1]))
        split.loc[g.index[n_train:n_train + n_val]] = "val"
        split.loc[g.index[n_train + n_val:]] = "test"
    return split


def dmatrix(df: pd.DataFrame, y: pd.Series | None = None) -> xgb.DMatrix:
    return xgb.DMatrix(df[list(FEATURE_NAMES)].astype(np.float32), label=y, feature_names=list(FEATURE_NAMES),
                       missing=math.nan)


def fit(params: dict, dtrain: xgb.DMatrix, dval: xgb.DMatrix) -> xgb.Booster:
    return xgb.train(params, dtrain, num_boost_round=3000, evals=[(dval, "val")],
                     early_stopping_rounds=150, verbose_eval=False)


def predict(booster: xgb.Booster, d: xgb.DMatrix) -> np.ndarray:
    best = getattr(booster, "best_iteration", None)
    return booster.predict(d, iteration_range=(0, best + 1)) if best is not None else booster.predict(d)


def curve(xs: np.ndarray, ys: np.ndarray, n: int = 120) -> list[list[float]]:
    idx = np.unique(np.linspace(0, len(xs) - 1, min(n, len(xs))).round().astype(int))
    return [[round(float(xs[i]), 4), round(float(ys[i]), 4)] for i in idx]


SEARCH_SIZE = 60
HIGH_RECALL_TARGET = 0.80
SEARCH_SPACE = {
    "eta": [0.01, 0.02, 0.03, 0.05],
    "max_depth": [2, 3, 4, 5, 6, 8],
    "min_child_weight": [1, 3, 5, 10, 20],
    "lambda": [0.5, 1.0, 3.0, 10.0],
    "subsample": [0.6, 0.7, 0.8, 0.9, 1.0],
    "colsample_bytree": [0.4, 0.6, 0.8, 1.0],
    "gamma": [0.0, 0.5, 1.0, 2.0],
}


def sample_configs(n: int) -> list[dict]:
    rng = np.random.default_rng(SEED)
    out: list[dict] = []
    while len(out) < n:
        cfg = {k: v[int(rng.integers(len(v)))] for k, v in SEARCH_SPACE.items()}
        if cfg not in out:
            out.append(cfg)
    return out


def binary_metrics(y: np.ndarray, p: np.ndarray, threshold: float) -> dict:
    pred = p >= threshold
    order = np.argsort(-p)
    k10, k20 = max(1, int(0.1 * len(p))), max(1, int(0.2 * len(p)))
    return {
        "n": int(len(y)), "positives": int(y.sum()), "base_rate": round(float(y.mean()), 4),
        "roc_auc": round(float(roc_auc_score(y, p)), 4),
        "pr_auc": round(float(average_precision_score(y, p)), 4),
        "precision": round(float(precision_score(y, pred, zero_division=0)), 4),
        "recall": round(float(recall_score(y, pred)), 4),
        "f1": round(float(f1_score(y, pred)), 4),
        "flagged_share": round(float(pred.mean()), 4),
        "precision_at_top10pct": round(float(y[order[:k10]].mean()), 4),
        "recall_at_top20pct": round(float(y[order[:k20]].sum() / max(1, y.sum())), 4),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=ROOT / "data" / "prs.csv.gz")
    ap.add_argument("--out", type=Path, default=ROOT / "artifacts")
    ap.add_argument("--quick", action="store_true", help="one hyperparameter setting (tests and smoke runs)")
    args = ap.parse_args(argv)
    t0 = time.time()

    df = read_prs(args.data)
    df["split"] = chronological_split(df)
    tr, va, te = (df[df.split == s] for s in ("train", "val", "test"))
    dtr, dva, dte = dmatrix(tr, tr.label), dmatrix(va, va.label), dmatrix(te, te.label)
    print(f"{len(df):,} PRs / {df.repo.nunique()} repos; train {len(tr):,} val {len(va):,} test {len(te):,}; "
          f"defect rate {df.label.mean():.1%}")

    # -- hyperparameter search on validation AUC (random search, fixed seed) -------------------
    base = {"objective": "binary:logistic", "eval_metric": "auc", "tree_method": "hist", "seed": SEED,
            "nthread": 4}
    configs = [{"eta": 0.03, "max_depth": 4, "min_child_weight": 5, "lambda": 1.0, "subsample": 0.8,
                "colsample_bytree": 0.8, "gamma": 0.0}] if args.quick else sample_configs(SEARCH_SIZE)
    search = []
    best = None
    for cfg in configs:
        params = {**base, **cfg}
        booster = fit(params, dtr, dva)
        auc = roc_auc_score(va.label, predict(booster, dva))
        search.append({**cfg, "trees": booster.best_iteration + 1, "val_auc": round(float(auc), 4)})
        if best is None or auc > best[0]:
            best = (auc, params, booster)
    val_auc, params, booster = best
    n_trees = booster.best_iteration + 1
    booster = booster[:n_trees]          # drop the trees grown after the early-stopping point
    print(f"best of {len(configs)} configs: val AUC {val_auc:.4f} with "
          + ", ".join(f"{k}={params[k]}" for k in SEARCH_SPACE) + f", trees={n_trees}")

    # -- operating points on validation ---------------------------------------------------------
    p_val = predict(booster, dva)
    prec, rec, thr = precision_recall_curve(va.label, p_val)
    f1 = 2 * prec[:-1] * rec[:-1] / np.clip(prec[:-1] + rec[:-1], 1e-12, None)
    threshold = float(thr[int(np.argmax(f1))])
    reaches = np.where(rec[:-1] >= HIGH_RECALL_TARGET)[0]
    high_recall_threshold = float(thr[reaches[-1]]) if len(reaches) else float(thr[0])

    # -- the one look at test ------------------------------------------------------------------
    p_test = predict(booster, dte)
    y_test = te.label.to_numpy()
    test = binary_metrics(y_test, p_test, threshold)
    val = binary_metrics(va.label.to_numpy(), p_val, threshold)
    test_hr = binary_metrics(y_test, p_test, high_recall_threshold)
    val_hr = binary_metrics(va.label.to_numpy(), p_val, high_recall_threshold)
    print(f"TEST  AUC {test['roc_auc']}  PR-AUC {test['pr_auc']}  balanced: precision {test['precision']} "
          f"recall {test['recall']} | high-recall: precision {test_hr['precision']} recall {test_hr['recall']} "
          f"(base rate {test['base_rate']})")

    # -- baselines -------------------------------------------------------------------------------
    size = (te.lines_added + te.lines_deleted).to_numpy()
    logit = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(max_iter=2000))
    logit.fit(np.log1p(tr[list(FEATURE_NAMES)].clip(lower=0)), tr.label)
    p_logit = logit.predict_proba(np.log1p(te[list(FEATURE_NAMES)].clip(lower=0)))[:, 1]
    baselines = {
        "size_only_roc_auc": round(float(roc_auc_score(y_test, size)), 4),
        "size_only_pr_auc": round(float(average_precision_score(y_test, size)), 4),
        "logistic_regression_roc_auc": round(float(roc_auc_score(y_test, p_logit)), 4),
        "logistic_regression_pr_auc": round(float(average_precision_score(y_test, p_logit)), 4),
    }

    # -- transfer to unseen repositories ----------------------------------------------------------
    fold_aucs = []
    fixed = {**params}
    n_folds = min(5, df.repo.nunique())
    for k_tr, k_te in GroupKFold(n_splits=n_folds).split(df, df.label, df.repo):
        a, b = df.iloc[k_tr], df.iloc[k_te]
        m = xgb.train(fixed, dmatrix(a, a.label), num_boost_round=n_trees)
        fold_aucs.append(float(roc_auc_score(b.label, m.predict(dmatrix(b)))))
    cross_project = {"folds": n_folds, "roc_auc_mean": round(float(np.mean(fold_aucs)), 4),
                     "roc_auc_std": round(float(np.std(fold_aucs)), 4),
                     "fold_roc_aucs": [round(a, 4) for a in fold_aucs]}

    # -- SHAP: XGBoost's TreeSHAP vs the shap package ----------------------------------------------
    contribs = booster.predict(dte, pred_contribs=True)
    shap_check = None
    try:
        import shap

        sv = shap.TreeExplainer(booster).shap_values(te[list(FEATURE_NAMES)].astype(np.float32).iloc[:500])
        shap_check = float(np.max(np.abs(sv - contribs[:500, :-1])))
        print(f"shap.TreeExplainer vs XGBoost pred_contribs: max abs diff {shap_check:.2e}")
    except Exception as exc:  # noqa: BLE001 - optional cross-check
        print(f"shap cross-check skipped: {exc}")
    importance = sorted(
        ({"feature": n, "mean_abs_shap": round(float(np.mean(np.abs(contribs[:, j]))), 4)}
         for j, n in enumerate(FEATURE_NAMES)), key=lambda r: -r["mean_abs_shap"])

    # -- per-repository test results ---------------------------------------------------------------
    per_repo = []
    te_scored = te.assign(prob=p_test)
    for repo, g in te_scored.groupby("repo"):
        both = g.label.nunique() == 2
        per_repo.append({"repo": repo, "test_prs": int(len(g)), "test_positives": int(g.label.sum()),
                         "roc_auc": round(float(roc_auc_score(g.label, g.prob)), 4) if both else None,
                         "recall": round(float(((g.prob >= threshold) & (g.label == 1)).sum() /
                                               max(1, g.label.sum())), 4)})

    # -- write artifacts ----------------------------------------------------------------------------
    args.out.mkdir(parents=True, exist_ok=True)
    booster.save_model(str(args.out / "model.json"))
    medians = {n: (None if math.isnan(v) else float(v))
               for n, v in tr[list(FEATURE_NAMES)].median().items()}
    val_sorted = np.sort(p_val)
    (args.out / "model_meta.json").write_text(json.dumps({
        "features": list(FEATURE_NAMES), "threshold": threshold, "high_recall_threshold": high_recall_threshold,
        "medians": medians,
        "validation_probabilities": [round(float(x), 6) for x in val_sorted],
        "params": {k: v for k, v in params.items() if k != "nthread"}, "trees": n_trees,
    }))

    fpr, tpr, _ = roc_curve(y_test, p_test)
    pr_p, pr_r, _ = precision_recall_curve(y_test, p_test)
    fpr_s, tpr_s, _ = roc_curve(y_test, size)
    def operating_point(t: float, m: dict) -> dict:
        flagged = p_test >= t
        fpr_t = float((flagged & (y_test == 0)).sum() / max(1, (y_test == 0).sum()))
        return {"fpr": round(fpr_t, 4), "recall": m["recall"], "precision": m["precision"]}
    dates = {s: [str(g.merged_at.min())[:10], str(g.merged_at.max())[:10]] for s, g in df.groupby("split")}
    metrics = {
        "dataset": {"prs": int(len(df)), "repos": int(df.repo.nunique()),
                    "defect_rate": round(float(df.label.mean()), 4),
                    "features": len(FEATURE_NAMES), "split_sizes": {s: int((df.split == s).sum()) for s in
                                                                    ("train", "val", "test")},
                    "split_dates": dates, "languages_note": "see data/repos.json"},
        "model": {"algorithm": "XGBoost (binary:logistic)", **{k: params[k] for k in SEARCH_SPACE},
                  "configs_searched": len(configs),
                  "trees": n_trees, "validation_roc_auc": round(float(val_auc), 4)},
        "threshold": round(threshold, 4), "test": test, "validation": val, "baselines": baselines,
        "high_recall": {"target_recall": HIGH_RECALL_TARGET, "threshold": round(high_recall_threshold, 4),
                        "test": test_hr, "validation": val_hr},
        "cross_project": cross_project, "search": search, "shap_max_abs_diff_vs_shap_package": shap_check,
        "importance": importance, "per_repo": per_repo,
        "curves": {"roc": curve(fpr, tpr), "pr": curve(pr_r[::-1], pr_p[::-1]),
                   "roc_size_only": curve(fpr_s, tpr_s), "operating_point": operating_point(threshold, test),
                   "operating_point_high_recall": operating_point(high_recall_threshold, test_hr)},
        "feature_specs": [{"name": f.name, "group": f.group, "label": f.label, "description": f.description}
                          for f in FEATURES if f.name in FEATURE_NAMES],
        "seconds": round(time.time() - t0, 1),
    }
    (args.out / "metrics.json").write_text(json.dumps(metrics, indent=2))

    d_all = dmatrix(df)
    df_out = df[["repo", "number", "title", "merged_at", "split", "label", "fixed_by", "top_files",
                 *FEATURE_NAMES]].copy()
    df_out["prob"] = booster.predict(d_all).round(5)
    df_out.to_csv(args.out / "predictions.csv.gz", index=False, compression="gzip")
    print(f"wrote {args.out} in {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
