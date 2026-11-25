"""Concatenate per-repository outputs into data/prs.csv.gz and data/repos.json.

    python -m mining.assemble
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

from riskradar.dataset import read_prs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repos", type=Path, default=Path("mining/repos.txt"))
    ap.add_argument("--raw", type=Path, default=Path("data/raw"))
    ap.add_argument("--out", type=Path, default=Path("data"))
    args = ap.parse_args(argv)

    slugs = [s.strip() for s in args.repos.read_text().splitlines() if s.strip() and not s.startswith("#")]
    frames, stats = [], []
    for slug in slugs:
        name = slug.replace("/", "__")
        csv_path, stats_path = args.raw / f"{name}.csv", args.raw / f"{name}.json"
        if not csv_path.exists():
            print(f"missing {slug}; run mining.build_dataset first", file=sys.stderr)
            return 1
        frames.append(read_prs(csv_path))
        stats.append(json.loads(stats_path.read_text()))

    df = pd.concat(frames, ignore_index=True)
    args.out.mkdir(parents=True, exist_ok=True)
    df.to_csv(args.out / "prs.csv.gz", index=False, compression="gzip")
    (args.out / "repos.json").write_text(json.dumps(stats, indent=2))
    print(f"{len(df):,} PRs from {df['repo'].nunique()} repositories, "
          f"{df['label'].mean():.1%} defect-inducing -> {args.out / 'prs.csv.gz'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
