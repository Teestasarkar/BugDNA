"""Check that live scoring (GitHub API) reproduces the offline features (git clone).

    GITHUB_TOKEN=... python -m training.parity_check --n 10

Samples merged PRs from data/prs.csv.gz, re-derives their 28 features through
the GitHub REST API exactly as /api/analyze does, and reports every feature that
differs. Each PR costs about 20 API requests (60/hour without a token).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

from api.github import Client, GitHubError, analyze_pr
from riskradar.dataset import read_prs
from riskradar.features import FEATURE_NAMES

ROOT = Path(__file__).resolve().parent.parent


def same(a: float, b: float) -> bool:
    if math.isnan(a) or math.isnan(b):
        return math.isnan(a) and math.isnan(b)
    return abs(a - b) <= 1e-6 * max(1.0, abs(b))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, default=ROOT / "data" / "prs.csv.gz")
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--prs", nargs="*", help="explicit owner/repo#number entries instead of a sample")
    ap.add_argument("--out", type=Path, default=ROOT / "artifacts" / "parity.json")
    args = ap.parse_args(argv)

    df = read_prs(args.data)
    if args.prs:
        keys = [(p.split("#")[0], int(p.split("#")[1])) for p in args.prs]
        sample = df.set_index(["repo", "number"]).loc[keys].reset_index()
    else:
        sample = df.sample(n=args.n, random_state=args.seed)

    client = Client()
    results, mismatched = [], 0
    for _, row in sample.iterrows():
        url = f"https://github.com/{row.repo}/pull/{row.number}"
        try:
            live = analyze_pr(url, client)
        except GitHubError as exc:
            print(f"{url}: {exc}")
            break
        diffs = {n: {"live": live["features"][n], "mined": float(row[n])}
                 for n in FEATURE_NAMES if not same(float(live["features"][n]), float(row[n]))}
        mismatched += bool(diffs)
        results.append({"pr": f"{row.repo}#{row.number}", "differing": diffs})
        verdict = (f"all {len(FEATURE_NAMES)} features match" if not diffs
                   else f"{len(diffs)} differ: " + ", ".join(diffs))
        print(f"{url}: {verdict}")
    summary = {"checked": len(results), "identical": len(results) - mismatched, "results": results,
               "github_requests": client.calls}
    args.out.write_text(json.dumps(summary, indent=2))
    print(f"\n{summary['identical']}/{summary['checked']} PRs reproduced exactly ({client.calls} API requests)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
