"""Recompute features for already-labelled PRs without re-running SZZ.

    python -m mining.refeaturize --clones ../pr-risk-radar-mining/repos

Labels depend only on which PRs later fixes blamed, not on the feature set, so
when features change only the history replay needs to run again (minutes, not
the hour SZZ takes). Every PR in data/raw/<repo>.csv is matched by commit sha.
"""

from __future__ import annotations

import argparse
import csv
import sys
import time
from pathlib import Path

from riskradar.dataset import read_prs
from riskradar.features import ALL_FEATURE_NAMES

from .build_dataset import META_COLUMNS, feature_cells, featurize
from .gitlog import first_parent_commits


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repos", type=Path, default=Path("mining/repos.txt"))
    ap.add_argument("--clones", type=Path, required=True)
    ap.add_argument("--raw", type=Path, default=Path("data/raw"))
    args = ap.parse_args(argv)

    slugs = [s.strip() for s in args.repos.read_text().splitlines() if s.strip() and not s.startswith("#")]
    for slug in slugs:
        t0 = time.time()
        name = slug.replace("/", "__")
        path = args.raw / f"{name}.csv"
        old = read_prs(path)
        commits = first_parent_commits(args.clones / f"{name}.git")
        index = {c.sha: i for i, c in enumerate(commits)}
        missing = set(old.sha) - set(index)
        if missing:
            print(f"FAIL  {slug}: {len(missing)} labelled PRs not found in the clone", file=sys.stderr)
            return 1
        features = featurize(commits, {index[s] for s in old.sha})
        rows = []
        for _, r in old.iterrows():
            meta = {c: r[c] for c in META_COLUMNS}
            rows.append({**meta, **feature_cells(features[index[r.sha]])})
        tmp = path.with_suffix(".tmp")
        with tmp.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=META_COLUMNS + list(ALL_FEATURE_NAMES))
            w.writeheader()
            w.writerows(rows)
        tmp.replace(path)
        print(f"done  {slug}: {len(rows)} PRs re-featurized in {time.time() - t0:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
