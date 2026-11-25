"""Feature-set experiments on the validation split only (the test split is never loaded).

    python -m training.experiments

Compares the original 28 features with the v2 candidates, then drops each new
candidate in turn. A candidate is kept only if removing it lowers validation
ROC-AUC. Hyperparameters are fixed to v1's chosen setting so that only the
features vary.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import xgboost as xgb
from sklearn.metrics import average_precision_score, roc_auc_score

from riskradar.dataset import read_prs
from riskradar.features import ALL_FEATURE_NAMES

from .train import chronological_split

ROOT = Path(__file__).resolve().parent.parent
V1 = ALL_FEATURE_NAMES[:28]
NEW = ALL_FEATURE_NAMES[28:]
PARAMS = {"objective": "binary:logistic", "eval_metric": "auc", "tree_method": "hist", "eta": 0.03,
          "max_depth": 3, "min_child_weight": 1, "lambda": 1.0, "subsample": 0.8, "colsample_bytree": 0.8,
          "seed": 7, "nthread": 4}


def val_scores(tr, va, features: list[str], seeds: tuple[int, ...] = (7, 8, 9)) -> tuple[float, float]:
    """Mean validation ROC-AUC / PR-AUC over a few seeds (subsampling makes single runs noisy)."""
    aucs, aps = [], []
    for seed in seeds:
        dtr = xgb.DMatrix(tr[features].astype(np.float32), label=tr.label, feature_names=features)
        dva = xgb.DMatrix(va[features].astype(np.float32), label=va.label, feature_names=features)
        b = xgb.train({**PARAMS, "seed": seed}, dtr, 3000, evals=[(dva, "val")], early_stopping_rounds=150,
                      verbose_eval=False)
        p = b.predict(dva, iteration_range=(0, b.best_iteration + 1))
        aucs.append(roc_auc_score(va.label, p))
        aps.append(average_precision_score(va.label, p))
    return float(np.mean(aucs)), float(np.mean(aps))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=ROOT / "data" / "prs.csv.gz")
    ap.add_argument("--out", type=Path, default=ROOT / "artifacts" / "experiments.json")
    args = ap.parse_args(argv)

    df = read_prs(args.data)
    df["split"] = chronological_split(df)
    tr, va = df[df.split == "train"], df[df.split == "val"]
    del df                                     # nothing below can reach the test rows

    results = {}
    for name, feats in [("v1: original 28", list(V1)), ("v2: all candidates", list(ALL_FEATURE_NAMES))]:
        results[name] = val_scores(tr, va, feats)
        print(f"{name:40} val AUC {results[name][0]:.4f}  PR-AUC {results[name][1]:.4f}", flush=True)
    full_auc = results["v2: all candidates"][0]
    keep = []
    for f in NEW:
        feats = [x for x in ALL_FEATURE_NAMES if x != f]
        auc, aps = val_scores(tr, va, feats)
        results[f"v2 without {f}"] = (auc, aps)
        verdict = "keep" if auc < full_auc else "drop"
        if verdict == "keep":
            keep.append(f)
        print(f"{'  without ' + f:40} val AUC {auc:.4f}  PR-AUC {aps:.4f}  ({auc - full_auc:+.4f}) -> {verdict}",
              flush=True)
    final = list(V1) + keep
    results["v2: selected"] = val_scores(tr, va, final)
    print(f"{'v2: selected (' + str(len(final)) + ')':40} val AUC {results['v2: selected'][0]:.4f}  "
          f"PR-AUC {results['v2: selected'][1]:.4f}")
    args.out.write_text(json.dumps({"results": {k: {"val_roc_auc": round(a, 4), "val_pr_auc": round(b, 4)}
                                                for k, (a, b) in results.items()},
                                    "kept": keep, "selected_features": final}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
