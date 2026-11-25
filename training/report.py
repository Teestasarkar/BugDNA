"""Render the README's results section from artifacts/metrics.json.

    python -m training.report

Everything between the `results:start` and `results:end` markers in README.md is
regenerated, so the numbers in the README are always the numbers of the shipped
model and never typed by hand.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
START, END = "<!-- results:start -->", "<!-- results:end -->"


def pct(v: float, d: int = 1) -> str:
    return f"{v * 100:.{d}f}%"


def render(m: dict, repos: list[dict]) -> str:
    t, b, cp, ds = m["test"], m["baselines"], m["cross_project"], m["dataset"]
    specs = {f["name"]: f for f in m["feature_specs"]}
    caught = round(t["recall"] * t["positives"])
    lines = [
        START,
        "",
        f"**{ds['prs']:,} pull requests from {ds['repos']} repositories; {pct(ds['defect_rate'])} labelled "
        f"defect-inducing.** Test split = the newest 20% of every repository "
        f"({ds['split_sizes']['test']:,} PRs, merged {ds['split_dates']['test'][0]} "
        f"to {ds['split_dates']['test'][1]}), "
        "never used for training, tuning or threshold selection.",
        "",
        "| Held-out test | Value |",
        "|---|---|",
        f"| ROC-AUC | **{t['roc_auc']:.3f}** |",
        f"| PR-AUC (base rate {t['base_rate']:.3f}) | **{t['pr_auc']:.3f}** |",
        f"| Precision at the validation-chosen threshold | **{pct(t['precision'])}** |",
        f"| Recall at that threshold | **{pct(t['recall'])}** ({caught} of {t['positives']} defect-inducing PRs) |",
        f"| PRs flagged at that threshold | {pct(t['flagged_share'])} |",
        f"| Recall when reviewing only the riskiest 20% | {pct(t['recall_at_top20pct'])} |",
        f"| Precision among the riskiest 10% | {pct(t['precision_at_top10pct'])} "
        f"({t['precision_at_top10pct'] / t['base_rate']:.1f}x base rate) |",
        f"| ROC-AUC on repositories never seen in training ({cp['folds']}-fold, grouped by repo) | "
        f"{cp['roc_auc_mean']:.3f} ± {cp['roc_auc_std']:.3f} |",
        "",
        "| Same test split | ROC-AUC | PR-AUC |",
        "|---|---|---|",
        f"| Random | 0.500 | {t['base_rate']:.3f} |",
        f"| Lines changed (bigger = riskier) | {b['size_only_roc_auc']:.3f} | {b['size_only_pr_auc']:.3f} |",
        f"| Logistic regression, same 28 features | {b['logistic_regression_roc_auc']:.3f} | "
        f"{b['logistic_regression_pr_auc']:.3f} |",
        f"| **XGBoost, 28 features** | **{t['roc_auc']:.3f}** | **{t['pr_auc']:.3f}** |",
        "",
        f"Model: {m['model']['trees']} trees, depth {m['model']['max_depth']}, min child weight "
        f"{m['model']['min_child_weight']}, L2 {m['model']['lambda']}, chosen on validation ROC-AUC "
        f"{m['model']['validation_roc_auc']:.3f}. Decision threshold {m['threshold']:.3f} (max F1 on validation).",
        "",
        "Top risk drivers (mean |SHAP| on the test split):",
        "",
    ]
    for i, r in enumerate(m["importance"][:8], 1):
        lines.append(f"{i}. {specs[r['feature']]['label']} (`{r['feature']}`): {r['mean_abs_shap']:.3f}")
    lines += ["", "<details><summary>Per-repository results</summary>", "",
              "| Repository | PRs | Defect rate | Test PRs | Test ROC-AUC |", "|---|---|---|---|---|"]
    per = {r["repo"]: r for r in m["per_repo"]}
    for r in repos:
        p = per.get(r["repo"], {})
        auc = f"{p['roc_auc']:.2f}" if p.get("roc_auc") is not None else "n/a"
        lines.append(f"| [{r['repo']}](https://github.com/{r['repo']}) | {r['selected']} | "
                     f"{pct(r['defect_inducing'] / max(1, r['selected']))} | {p.get('test_prs', 0)} | {auc} |")
    lines += ["", "</details>", "", END]
    return "\n".join(lines)


def main() -> int:
    m = json.loads((ROOT / "artifacts" / "metrics.json").read_text())
    repos = json.loads((ROOT / "data" / "repos.json").read_text())
    readme = ROOT / "README.md"
    text = readme.read_text(encoding="utf-8")
    if START not in text or END not in text:
        print("README.md has no results markers", file=sys.stderr)
        return 1
    new = re.sub(re.escape(START) + ".*?" + re.escape(END), lambda _: render(m, repos), text, flags=re.S)
    readme.write_text(new, encoding="utf-8")
    print("README results section updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
