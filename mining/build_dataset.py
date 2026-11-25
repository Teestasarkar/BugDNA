"""Build the labelled PR dataset from bare clones.

    python -m mining.build_dataset --repos mining/repos.txt --clones ../pr-risk-radar-mining/repos

Per repository:
  1. read the first-parent history of the default branch;
  2. a "PR" is a GitHub squash-merge commit ("Title (#123)");
  3. keep human-authored PRs that change at least one source file and merged
     before the label cutoff, then take the most recent --per-repo of them;
  4. replay history oldest-first, computing each kept PR's features from the
     state *before* it merged;
  5. run SZZ over every later bug fix (up to the clone's HEAD) to label which
     kept PRs introduced lines a fix had to change.

The cutoff leaves every labelled PR at least (clone date - cutoff) of follow-up
for its defects to be found and fixed. PRs without a traced fix are labelled
clean, which is the main source of label noise and is stated in the README.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from riskradar import paths
from riskradar.features import FEATURE_NAMES, PRChange, compute_features
from riskradar.text import is_bot, is_bug_fix, squash_pr_number, strip_pr_suffix

from .gitlog import first_parent_commits
from .history import LocalHistory
from .szz import run_szz

DEFAULT_CUTOFF = "2025-09-01"
META_COLUMNS = ["repo", "number", "sha", "merged_at", "author_hash", "title", "top_files",
                "label", "fixed_by"]


def _ts(date: str) -> int:
    return int(datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=UTC).timestamp())


def _author_hash(email: str) -> str:
    return hashlib.sha256(email.encode()).hexdigest()[:12]


def process_repo(slug: str, clone: Path, cutoff: int, per_repo: int, workers: int) -> tuple[list[dict], dict]:
    t0 = time.time()
    commits = first_parent_commits(clone)
    by_sha = {c.sha: i for i, c in enumerate(commits)}

    pr_number: dict[int, int] = {}
    for i, c in enumerate(commits):
        n = squash_pr_number(c.subject)
        if n is not None:
            pr_number[i] = n

    before_cutoff = [i for i, c in enumerate(commits) if c.timestamp < cutoff]
    recent = before_cutoff[-1000:]
    squash_share = sum(i in pr_number for i in recent) / max(1, len(recent))

    def eligible(i: int) -> bool:
        c = commits[i]
        return (i in pr_number and c.timestamp < cutoff and not is_bot(c.author_email, c.author_name)
                and any(paths.classify(f.path) == paths.SOURCE for f in c.files))

    selected = [i for i in sorted(pr_number) if eligible(i)][-per_repo:]
    stats: dict = {"repo": slug, "first_parent_commits": len(commits),
                   "squash_share_last_1000": round(squash_share, 3),
                   "eligible_prs": sum(eligible(i) for i in pr_number), "selected": len(selected)}
    if not selected:
        return [], stats

    sel = set(selected)
    hist = LocalHistory()
    features: dict[int, dict[str, float]] = {}
    for i, c in enumerate(commits):
        if i in sel:
            change = PRChange(title=strip_pr_suffix(c.subject), authors=frozenset({c.author_email}),
                              timestamp=c.timestamp, files=c.files)
            features[i] = compute_features(change, hist)
        hist.apply(c)

    first = selected[0]
    fixes = [c for i, c in enumerate(commits)
             if i > first and not c.subject.startswith("Merge ")
             and not is_bot(c.author_email, c.author_name)
             and is_bug_fix(strip_pr_suffix(c.subject))]
    # Paths a labelled PR wrote, carried forward through later renames (git blame follows renames).
    interest: set[str] = set()
    for i in range(first, len(commits)):
        for f in commits[i].files:
            if i in sel or f.status == "renamed" and f.old_path in interest:
                interest.add(f.path)
    blamed, szz = run_szz(clone, fixes, set(by_sha), workers=workers, paths_of_interest=interest,
                          boundary=commits[first].parent)

    fixed_by: dict[int, list[str]] = {}
    for fix_sha, shas in blamed.items():
        fix_i = by_sha[fix_sha]
        ref = f"#{pr_number[fix_i]}" if fix_i in pr_number else fix_sha[:10]
        for s in shas:
            j = by_sha.get(s)
            if j is not None and j in sel and j < fix_i:
                fixed_by.setdefault(j, []).append(ref)

    rows = []
    for i in selected:
        c = commits[i]
        top = sorted(c.files, key=lambda f: (-f.churn, f.path))[:3]
        rows.append({
            "repo": slug, "number": pr_number[i], "sha": c.sha,
            "merged_at": datetime.fromtimestamp(c.timestamp, UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "author_hash": _author_hash(c.author_email), "title": strip_pr_suffix(c.subject),
            "top_files": ";".join(f.path for f in top),
            "label": int(i in fixed_by), "fixed_by": " ".join(sorted(set(fixed_by.get(i, [])))),
            **{k: ("" if v != v else v) for k, v in features[i].items()},   # NaN -> empty cell
        })
    stats.update({
        "first_selected_merged_at": rows[0]["merged_at"], "last_selected_merged_at": rows[-1]["merged_at"],
        "head_committed_at": datetime.fromtimestamp(commits[-1].timestamp, UTC).strftime("%Y-%m-%d"),
        "fix_commits_after_window_start": len(fixes), "szz": szz.__dict__,
        "defect_inducing": sum(r["label"] for r in rows), "seconds": round(time.time() - t0, 1),
    })
    return rows, stats


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repos", type=Path, default=Path("mining/repos.txt"))
    ap.add_argument("--clones", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=Path("data/raw"))
    ap.add_argument("--cutoff", default=DEFAULT_CUTOFF)
    ap.add_argument("--per-repo", type=int, default=400)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)

    args.out.mkdir(parents=True, exist_ok=True)
    slugs = [s.strip() for s in args.repos.read_text().splitlines() if s.strip() and not s.startswith("#")]
    for slug in slugs:
        name = slug.replace("/", "__")
        csv_path, stats_path = args.out / f"{name}.csv", args.out / f"{name}.json"
        if csv_path.exists() and not args.force:
            print(f"skip  {slug} (done)", flush=True)
            continue
        clone = args.clones / f"{name}.git"
        if not clone.exists():
            print(f"MISSING clone for {slug}", flush=True)
            continue
        try:
            rows, stats = process_repo(slug, clone, _ts(args.cutoff), args.per_repo, args.workers)
        except Exception as exc:  # noqa: BLE001 - one broken repo must not stop the run
            print(f"FAIL  {slug}: {exc}", flush=True)
            continue
        stats["cutoff"] = args.cutoff
        stats_path.write_text(json.dumps(stats, indent=2))
        tmp = csv_path.with_suffix(".tmp")
        with tmp.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=META_COLUMNS + list(FEATURE_NAMES))
            w.writeheader()
            w.writerows(rows)
        tmp.replace(csv_path)
        pos = stats.get("defect_inducing", 0)
        print(f"done  {slug}: {len(rows)} PRs, {pos} defect-inducing "
              f"({pos / max(1, len(rows)):.0%}), squash {stats['squash_share_last_1000']:.0%}, "
              f"{stats.get('seconds', 0)}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
