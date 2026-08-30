"""Generate the synthetic bootstrap dataset.

READ THIS BEFORE USING THE OUTPUT
=================================

This script produces **synthetic data**. It is not a corpus of real pull requests,
and a model fitted on it cannot predict production incidents. It exists for one
narrow purpose: to let the full pipeline — feature extraction, XGBoost inference,
SHAP attribution, explanation, recommendation — run end to end on a fresh install
before anyone has supplied labelled outcomes.

How the labels are produced
---------------------------
Feature vectors are sampled from ranges chosen to resemble plausible pull
requests, then labelled by passing them through **the same documented heuristic
weights the fallback scorer uses**, plus noise. The consequence is precise and
worth stating plainly:

    A model trained on this data learns to approximate BugDNA's stated
    heuristic. It does not learn anything about real-world failures.

That is deliberate rather than a shortcut. It means the bootstrap model is:

  * **consistent** with the documented weights, so scores are explainable and
    stable rather than arbitrary;
  * **honest** — no accuracy claim can be derived from it, and the artifact is
    marked ``synthetic: true`` so every response carries that caveat;
  * **replaceable** — the moment an operator supplies real labelled data,
    ``train.py --data`` uses it instead and this file becomes irrelevant.

What real training data would look like
--------------------------------------
One row per historical pull request: the 43 feature columns from
``contracts/feature-spec.json``, plus a binary target column. The target
definition is the operator's to choose and is a genuine product decision — for
example "was this PR implicated in a production incident within 7 days of
merge". BugDNA does not assume one; ``train.py --target`` names the column.

See docs/ML_MODEL.md for the full discussion.

Usage
-----
    python -m training.generate_bootstrap_dataset --rows 12000 --out data/bootstrap.csv
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import random
import sys
from pathlib import Path

# Allow `python training/generate_bootstrap_dataset.py` as well as `-m`.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.features import CONTRACT
from app.heuristic import heuristic_logit

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("bootstrap")

# ---------------------------------------------------------------------------
# Sampling ranges
# ---------------------------------------------------------------------------
# Plausible magnitudes per feature type. These shape the *distribution* of
# synthetic pull requests; they are not measurements of any real repository.

ARCHETYPE_WEIGHTS = {
    "docs_only": 0.08,
    "tiny_fix": 0.16,
    "small_feature": 0.22,
    "medium_feature": 0.18,
    "large_refactor": 0.12,
    "dependency_bump": 0.08,
    "migration": 0.07,
    "config_infra": 0.05,
    "hotfix": 0.04,
}


def _churn_for(archetype: str, rng: random.Random) -> tuple[int, int, int]:
    """Return (files_changed, lines_added, lines_deleted)."""
    ranges: dict[str, tuple[tuple[int, int], tuple[int, int], tuple[int, int]]] = {
        "docs_only": ((1, 4), (2, 60), (0, 30)),
        "tiny_fix": ((1, 3), (2, 30), (1, 25)),
        "small_feature": ((2, 8), (30, 220), (5, 90)),
        "medium_feature": ((6, 20), (150, 600), (40, 250)),
        "large_refactor": ((18, 120), (400, 3500), (300, 3000)),
        "dependency_bump": ((2, 6), (50, 1200), (40, 1100)),
        "migration": ((3, 14), (40, 400), (10, 200)),
        "config_infra": ((1, 6), (5, 80), (2, 60)),
        "hotfix": ((1, 4), (3, 60), (1, 30)),
    }
    file_range, add_range, del_range = ranges[archetype]
    return (
        rng.randint(*file_range),
        rng.randint(*add_range),
        rng.randint(*del_range),
    )


def _sample_row(rng: random.Random) -> dict[str, float]:
    """Draw one plausible feature vector."""
    archetype = rng.choices(
        list(ARCHETYPE_WEIGHTS), weights=list(ARCHETYPE_WEIGHTS.values()), k=1
    )[0]

    files_changed, lines_added, lines_deleted = _churn_for(archetype, rng)
    total_churn = lines_added + lines_deleted

    is_docs_only = archetype == "docs_only"
    is_dependency = archetype == "dependency_bump"
    is_migration = archetype == "migration"
    is_config = archetype == "config_infra"
    is_hotfix = archetype == "hotfix"
    is_large = archetype == "large_refactor"

    # Test discipline correlates with archetype: hotfixes and dependency bumps
    # skip tests far more often than deliberate features do.
    p_tests = {
        "docs_only": 0.02,
        "tiny_fix": 0.30,
        "small_feature": 0.70,
        "medium_feature": 0.72,
        "large_refactor": 0.45,
        "dependency_bump": 0.15,
        "migration": 0.40,
        "config_infra": 0.10,
        "hotfix": 0.12,
    }[archetype]

    touches_tests = rng.random() < p_tests
    test_files = rng.randint(1, max(1, files_changed // 3)) if touches_tests else 0
    test_churn = rng.randint(10, max(20, total_churn // 3)) if touches_tests else 0

    modules_touched = (
        1
        if files_changed <= 2
        else min(files_changed, max(1, int(rng.gauss(files_changed / 3.5, 1.5))))
    )
    modules_touched = max(1, modules_touched)

    source_files = max(0, files_changed - test_files - (files_changed if is_docs_only else 0))

    migration_files = rng.randint(1, 3) if is_migration else 0
    dependency_files = rng.randint(1, 3) if is_dependency else 0
    lockfile_churn = rng.randint(200, 1500) if is_dependency else 0
    config_files = rng.randint(1, 4) if is_config else (1 if rng.random() < 0.10 else 0)
    infra_files = rng.randint(1, 3) if is_config else (1 if rng.random() < 0.05 else 0)

    has_destructive_sql = is_migration and rng.random() < 0.35
    touches_public_api = (not is_docs_only) and rng.random() < (0.45 if is_large else 0.22)
    public_api_files = rng.randint(1, max(1, source_files)) if touches_public_api else 0
    touches_auth = (not is_docs_only) and rng.random() < 0.12
    removes_error_handling = (not is_docs_only) and rng.random() < (0.18 if is_hotfix else 0.06)

    has_description = rng.random() < (0.55 if is_hotfix else 0.85)
    description_length = rng.randint(40, 1400) if has_description else 0
    review_comments = rng.randint(0, 18) if rng.random() < 0.6 else 0

    repo_median = rng.randint(40, 400)

    # --- tail coverage ------------------------------------------------------
    # Independent sampling almost never produces a pull request that trips
    # several serious signals at once, so the extreme corner of the feature
    # space stays unrepresented — and a tree model asked to score a genuinely
    # alarming change then has to extrapolate, which it does conservatively.
    # Real incidents cluster: the migration that drops a column is also the one
    # rushed out without tests. Escalating a minority of rows reproduces that
    # correlation and gives the model a tail to learn from.
    if rng.random() < 0.12:
        touches_tests = False
        test_files = 0
        test_churn = 0
        has_destructive_sql = has_destructive_sql or (migration_files > 0) or rng.random() < 0.5
        if migration_files == 0 and has_destructive_sql:
            migration_files = rng.randint(1, 3)
        touches_auth = touches_auth or rng.random() < 0.6
        removes_error_handling = removes_error_handling or rng.random() < 0.5
        touches_public_api = True
        public_api_files = max(public_api_files, rng.randint(2, 8))
        modules_touched = max(modules_touched, rng.randint(4, 12))
        files_changed = max(files_changed, modules_touched * 2)
        lines_added = max(lines_added, rng.randint(400, 2500))
        lines_deleted = max(lines_deleted, rng.randint(200, 1500))
        total_churn = lines_added + lines_deleted
        source_files = max(1, files_changed - test_files)
        review_comments = 0
        is_docs_only = False

    return {
        # change shape
        "lines_added": float(lines_added),
        "lines_deleted": float(lines_deleted),
        "total_churn": float(total_churn),
        "files_changed": float(files_changed),
        "commits_count": float(rng.randint(1, max(2, files_changed // 2 + 1))),
        "avg_changes_per_file": total_churn / files_changed if files_changed else 0.0,
        "max_file_churn": float(rng.randint(1, max(2, total_churn))),
        "deletion_ratio": (lines_deleted / total_churn) if total_churn else 0.0,
        "files_removed": float(rng.randint(0, 3) if is_large else 0),
        "files_renamed": float(rng.randint(0, 6) if is_large else 0),
        # change type
        "source_files_changed": float(source_files),
        "test_files_changed": float(test_files),
        "touches_tests": 1.0 if touches_tests else 0.0,
        "test_to_source_ratio": (
            test_churn / max(1.0, total_churn - test_churn) if touches_tests else 0.0
        ),
        "config_files_changed": float(config_files),
        "infra_files_changed": float(infra_files),
        "docs_only_change": 1.0 if is_docs_only else 0.0,
        "generated_files_changed": float(1 if is_dependency else 0),
        "adds_todo_markers": 1.0 if rng.random() < 0.10 else 0.0,
        # dependency
        "dependency_manifest_changed": 1.0 if is_dependency else 0.0,
        "dependency_files_changed": float(dependency_files),
        "lockfile_churn": float(lockfile_churn),
        # data layer
        "migration_files_changed": float(migration_files),
        "has_destructive_sql": 1.0 if has_destructive_sql else 0.0,
        # api contract
        "touches_public_api": 1.0 if touches_public_api else 0.0,
        "public_api_files_changed": float(public_api_files),
        "touches_auth_or_secrets": 1.0 if touches_auth else 0.0,
        "removes_error_handling": 1.0 if removes_error_handling else 0.0,
        # blast radius
        "modules_touched": float(modules_touched),
        "cross_module_change": 1.0 if modules_touched > 1 else 0.0,
        "max_module_concentration": round(rng.uniform(0.25, 1.0), 4),
        "languages_touched": float(rng.randint(1, min(4, max(1, modules_touched)))),
        # process
        "has_description": 1.0 if has_description else 0.0,
        "description_length": float(description_length),
        "review_comments_count": float(review_comments),
        "is_draft": 1.0 if rng.random() < 0.08 else 0.0,
        "pr_age_hours": round(abs(rng.gauss(50, 90)), 2),
        # repository history
        "repo_median_pr_churn_30d": float(repo_median),
        "churn_vs_repo_median": round(total_churn / repo_median, 4),
        "repo_deployment_failure_rate_90d": round(max(0.0, min(1.0, rng.gauss(0.12, 0.12))), 4),
        "module_incident_history": round(max(0.0, min(1.0, rng.gauss(0.15, 0.20))), 4),
        "author_pr_count_90d": float(rng.randint(0, 40)),
        "author_module_familiarity": round(rng.uniform(0.0, 1.0), 4),
    }


def _label(row: dict[str, float], rng: random.Random, noise: float) -> int:
    """Label a synthetic row using the documented heuristic weights plus noise.

    This is the crux of the honesty argument in the module docstring: the target
    is a function of the stated weights, so the resulting model approximates the
    heuristic and nothing more.
    """
    # Uses the same attribution function the fallback scorer uses, so the
    # synthetic labels and the heuristic can never drift apart.
    logit = heuristic_logit(row) + rng.gauss(0.0, noise)
    probability = 1.0 / (1.0 + math.exp(-max(-60.0, min(60.0, logit))))
    return 1 if rng.random() < probability else 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate BugDNA's synthetic bootstrap training dataset."
    )
    parser.add_argument("--rows", type=int, default=12_000, help="number of rows to generate")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("data/bootstrap.csv"),
        help="output CSV path",
    )
    parser.add_argument("--seed", type=int, default=20260830, help="PRNG seed for reproducibility")
    parser.add_argument(
        "--noise",
        type=float,
        default=0.9,
        help=(
            "standard deviation of label noise in log-odds. Higher values make the "
            "relationship less deterministic, which stops the model memorising the "
            "heuristic exactly."
        ),
    )
    parser.add_argument("--target", default="caused_incident", help="name of the target column")
    args = parser.parse_args()

    if not CONTRACT.loaded:
        logger.error(
            "No feature contract found. Run `npm run contracts:generate` in backend/ first."
        )
        raise SystemExit(1)

    rng = random.Random(args.seed)
    keys = list(CONTRACT.keys)

    args.out.parent.mkdir(parents=True, exist_ok=True)

    positives = 0

    import csv

    with args.out.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow([*keys, args.target])

        for _ in range(args.rows):
            row = _sample_row(rng)
            label = _label(row, rng, args.noise)
            positives += label
            writer.writerow([row.get(key, 0.0) for key in keys] + [label])

    # Sidecar describing exactly what this is, so nobody downstream has to guess.
    manifest = {
        "synthetic": True,
        "generator": "training/generate_bootstrap_dataset.py",
        "rows": args.rows,
        "positives": positives,
        "positiveRate": round(positives / args.rows, 4),
        "seed": args.seed,
        "labelNoiseStdDev": args.noise,
        "target": args.target,
        "featureSetVersion": CONTRACT.feature_set_version,
        "featureCount": len(keys),
        "warning": (
            "SYNTHETIC DATA. Labels are generated from BugDNA's documented heuristic "
            "weights plus Gaussian noise, not from observed production incidents. A model "
            "trained on this approximates the heuristic and must not be presented as "
            "predicting real-world failures. Supply real labelled data via "
            "`train.py --data` to train a meaningful model."
        ),
    }

    manifest_path = args.out.with_suffix(".manifest.json")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    logger.info("Wrote %s", args.out)
    logger.info(
        "  %d rows, %d positive (%.1f%%), %d features, feature set v%s",
        args.rows,
        positives,
        100 * positives / args.rows,
        len(keys),
        CONTRACT.feature_set_version,
    )
    logger.info("Wrote %s", manifest_path)
    logger.info("")
    logger.info("  This dataset is SYNTHETIC. See the manifest and docs/ML_MODEL.md.")


if __name__ == "__main__":
    main()
