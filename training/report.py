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


def render(m: dict, repos: list[dict], v1: dict | None = None) -> str:
    t, b, cp, ds = m["test"], m["baselines"], m["cross_project"], m["dataset"]
    hr = m.get("high_recall")
    nf = ds["features"]
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
        f"| **Balanced mode** (threshold = max F1 on validation): defect-causing PRs caught | "
        f"**{pct(t['recall'])}** ({caught} of {t['positives']}) |",
        f"| Balanced mode: precision | **{pct(t['precision'])}** (flags {pct(t['flagged_share'])} of PRs) |",
        *([f"| **High-recall mode** (threshold catching {pct(hr['target_recall'], 0)} of validation defects): caught | "
           f"**{pct(hr['test']['recall'])}** ({round(hr['test']['recall'] * t['positives'])} of {t['positives']}) |",
           f"| High-recall mode: precision | **{pct(hr['test']['precision'])}** "
           f"(flags {pct(hr['test']['flagged_share'])} of PRs) |"] if hr else []),
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
        f"| Logistic regression, same {nf} features | {b['logistic_regression_roc_auc']:.3f} | "
        f"{b['logistic_regression_pr_auc']:.3f} |",
        f"| **XGBoost, {nf} features** | **{t['roc_auc']:.3f}** | **{t['pr_auc']:.3f}** |",
        "",
        f"Model: {m['model']['trees']} trees, depth {m['model']['max_depth']}, learning rate {m['model'].get('eta')}, "
        f"min child weight {m['model']['min_child_weight']}, L2 {m['model']['lambda']}, "
        f"best of {m['model'].get('configs_searched', '?')} configurations by validation ROC-AUC "
        f"({m['model']['validation_roc_auc']:.3f}). Thresholds: balanced {m['threshold']:.3f}"
        + (f", high recall {hr['threshold']:.3f}" if hr else "") + ".",
        "",
        "**Reading these numbers honestly**",
        "",
        f"- *Most of the signal is in the features, not the model class.* Logistic regression on the same {nf} "
        f"features reaches {b['logistic_regression_roc_auc']:.3f} ROC-AUC against XGBoost's {t['roc_auc']:.3f}; "
        f"XGBoost's edge shows more at the top of the ranking (PR-AUC {t['pr_auc']:.3f} vs "
        f"{b['logistic_regression_pr_auc']:.3f}). Both clear the lines-changed heuristic "
        f"({b['size_only_roc_auc']:.3f}) by a wide margin.",
        f"- *The newest PRs had the least time to be found faulty.* The test split's defect rate "
        f"({pct(t['base_rate'])}) is below validation's ({pct(m['validation']['base_rate'])}), partly because its "
        "PRs had fewer months for fixes to land, so some test \"false alarms\" are probably defects nobody has "
        "fixed yet.",
        "- *Precision and recall trade off along one curve.* Both modes are points on the same model's curve, "
        "fixed on validation before the test split was scored; a reviewer chooses how many PRs they can afford to "
        "look at, not a better model.",
        "",
        "Top risk drivers (mean |SHAP| on the test split):",
        "",
    ]
    for i, r in enumerate(m["importance"][:8], 1):
        lines.append(f"{i}. {specs[r['feature']]['label']} (`{r['feature']}`): {r['mean_abs_shap']:.3f}")
    if v1:
        a = v1["test"]
        lines += ["", "**Model history.** v1 (28 features, 24-configuration grid) and v2 "
                  f"({nf} features, {m['model'].get('configs_searched', '?')}-configuration random search) were "
                  "both evaluated on the same test split. Every v2 change was chosen on validation "
                  "(`training/experiments.py`, `artifacts/experiments.json`), but the test split has now been "
                  "looked at twice, so treat the v2 figures as slightly optimistic.", "",
                  "| Held-out test | v1 | v2 |", "|---|---|---|",
                  f"| ROC-AUC | {a['roc_auc']:.3f} | {t['roc_auc']:.3f} |",
                  f"| PR-AUC | {a['pr_auc']:.3f} | {t['pr_auc']:.3f} |",
                  f"| Caught (balanced mode) | {pct(a['recall'])} | {pct(t['recall'])} |",
                  f"| Precision (balanced mode) | {pct(a['precision'])} | {pct(t['precision'])} |",
                  f"| Precision among the riskiest 10% | {pct(a['precision_at_top10pct'])} | "
                  f"{pct(t['precision_at_top10pct'])} |",
                  f"| Unseen repositories ROC-AUC | {v1['cross_project']['roc_auc_mean']:.3f} | "
                  f"{cp['roc_auc_mean']:.3f} |"]
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
    v1_path = ROOT / "artifacts" / "metrics_v1.json"
    v1 = json.loads(v1_path.read_text()) if v1_path.exists() else None
    repos = json.loads((ROOT / "data" / "repos.json").read_text())
    readme = ROOT / "README.md"
    text = readme.read_text(encoding="utf-8")
    if START not in text or END not in text:
        print("README.md has no results markers", file=sys.stderr)
        return 1
    new = re.sub(re.escape(START) + ".*?" + re.escape(END), lambda _: render(m, repos, v1), text, flags=re.S)
    readme.write_text(new, encoding="utf-8")
    print("README results section updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
