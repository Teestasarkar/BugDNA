"""SZZ: label the pull requests whose lines a later bug fix had to change.

For each bug-fix commit F on the base branch:
  1. take the source-code lines F deleted or modified (ignoring blank and
     comment-only lines),
  2. `git blame` those lines at F's parent, ignoring whitespace and any
     revisions listed in the repository's .git-blame-ignore-revs,
  3. every commit blamed is a candidate "fix-inducing" change.

Known noise, stated rather than hidden: fixes that only add lines cannot be
traced; a line blamed may have been correct when written; and title keywords
miss fixes that do not say "fix". Fixes touching more than MAX_FIX_SOURCE_FILES
source files are skipped, because sweeping changes titled "fix" blame almost
everything they touch.
"""

from __future__ import annotations

import re
import subprocess
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from riskradar import paths

from .gitlog import Commit, git

MAX_FIX_SOURCE_FILES = 50
MAX_RANGES_PER_FILE = 150
BLAME_TIMEOUT_S = 180
_HUNK = re.compile(rb"^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@")
_BLAME_LINE = re.compile(rb"^([0-9a-f]{40}) \d+ \d+", re.MULTILINE)
_SHA = re.compile(r"^[0-9a-f]{40}$")


@dataclass
class SzzStats:
    fixes_considered: int = 0
    fixes_skipped_too_large: int = 0
    fixes_without_traceable_lines: int = 0
    fixes_outside_labelled_files: int = 0
    blame_calls: int = 0
    blame_failures: int = 0
    lines_blamed: int = 0
    notes: list[str] = field(default_factory=list)


def deleted_source_lines(repo: Path, fix: Commit) -> dict[str, list[int]]:
    """Old-side line numbers of meaningful deleted/modified lines, per source file."""
    out = git(repo, "-c", "core.quotePath=false", "diff", "-U0", "-M", "--no-color",
              "--no-ext-diff", fix.parent or "", fix.sha, timeout=120)
    result: dict[str, list[int]] = {}
    old_path: str | None = None
    line_no = 0
    in_header = False
    for raw in out.split(b"\n"):
        if raw.startswith(b"diff --git"):
            in_header, old_path = True, None
            continue
        if in_header:
            # Header lines sit between "diff --git" and "+++"; only here can "---" be a path.
            if raw.startswith(b"--- "):
                p = raw[4:].decode("utf-8", errors="replace").rstrip("\t")
                old_path = p[2:] if p.startswith("a/") else None
                if old_path and paths.classify(old_path) != paths.SOURCE:
                    old_path = None
            elif raw.startswith(b"+++ "):
                in_header = False
            continue
        m = _HUNK.match(raw)
        if m:
            line_no = int(m.group(1))
            continue
        if old_path and raw.startswith(b"-"):
            if paths.is_meaningful_line(raw[1:].decode("utf-8", errors="replace")):
                result.setdefault(old_path, []).append(line_no)
            line_no += 1
    return result


def _ranges(lines: Iterable[int]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for n in sorted(set(lines)):
        if out and n == out[-1][1] + 1:
            out[-1] = (out[-1][0], n)
        else:
            out.append((n, n))
    return out


def ignore_revs(repo: Path, known: set[str]) -> list[str]:
    raw = git(repo, "show", "HEAD:.git-blame-ignore-revs", check=False).decode(errors="replace")
    revs = []
    for line in raw.splitlines():
        token = line.split("#", 1)[0].strip()
        if _SHA.match(token) and token in known:
            revs.append(token)
    return revs[:200]


def blame(repo: Path, rev: str, path: str, lines: list[int], ignore: list[str],
          boundary: str | None = None) -> set[str]:
    """Commits that last touched `lines` of `path` at `rev`.

    With `boundary`, blame walks only `boundary..rev`: older lines are attributed
    to the boundary commit instead of being chased through all of history.
    """
    rngs = _ranges(lines)[:MAX_RANGES_PER_FILE]
    args = ["git", "-C", str(repo), "blame", "--porcelain", "-w"]
    for r in ignore:
        args += ["--ignore-rev", r]
    for a, b in rngs:
        args += ["-L", f"{a},{b}"]
    args += [f"{boundary}..{rev}" if boundary else rev, "--", path]
    proc = subprocess.run(args, capture_output=True, timeout=BLAME_TIMEOUT_S)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode(errors="replace")[:200])
    return {m.decode() for m in _BLAME_LINE.findall(proc.stdout)}


def run_szz(repo: Path, fixes: list[Commit], known_shas: set[str], workers: int = 4,
            paths_of_interest: set[str] | None = None, boundary: str | None = None
            ) -> tuple[dict[str, set[str]], SzzStats]:
    """Map each fix sha to the set of commit shas it blames.

    `paths_of_interest` (every path a labelled PR wrote, plus later rename targets)
    and `boundary` (the commit before the first labelled PR) only skip work whose
    result could never be a labelled PR; they do not change any label.
    """
    stats = SzzStats()
    ignore = ignore_revs(repo, known_shas)
    if ignore:
        stats.notes.append(f"ignored {len(ignore)} revisions from .git-blame-ignore-revs")

    candidates: list[Commit] = []
    for fix in fixes:
        if fix.parent is None:
            continue
        source = [f for f in fix.files if paths.classify(f.path) == paths.SOURCE]
        if not source:
            continue
        stats.fixes_considered += 1
        if len(source) > MAX_FIX_SOURCE_FILES:
            stats.fixes_skipped_too_large += 1
            continue
        if paths_of_interest is not None and not any(
                (f.old_path if f.status == "renamed" and f.old_path else f.path) in paths_of_interest
                for f in source):
            stats.fixes_outside_labelled_files += 1
            continue
        candidates.append(fix)

    def lines_of(fix: Commit) -> tuple[Commit, dict[str, list[int]] | None, str | None]:
        try:
            return fix, deleted_source_lines(repo, fix), None
        except Exception as exc:  # noqa: BLE001 - a bad diff loses one fix, not the repo
            return fix, None, str(exc)

    def blame_one(task: tuple[Commit, str, list[int]]) -> tuple[str, set[str] | None]:
        fix, path, lines = task
        try:
            return fix.sha, blame(repo, fix.parent or "", path, lines, ignore, boundary)
        except Exception:  # noqa: BLE001 - counted below
            return fix.sha, None

    tasks: list[tuple[Commit, str, list[int]]] = []
    blamed: dict[str, set[str]] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for fix, per_file, err in pool.map(lines_of, candidates):
            if err is not None:
                stats.notes.append(f"diff failed for {fix.sha[:10]}: {err}")
                continue
            if paths_of_interest is not None:
                per_file = {p: ls for p, ls in (per_file or {}).items() if p in paths_of_interest}
            if not per_file:
                stats.fixes_without_traceable_lines += 1
                continue
            for path, lines in per_file.items():
                tasks.append((fix, path, lines))
                stats.lines_blamed += len(lines)

        for fix_sha, shas in pool.map(blame_one, tasks):
            stats.blame_calls += 1
            if shas is None:
                stats.blame_failures += 1
                continue
            blamed.setdefault(fix_sha, set()).update(shas)
    return blamed, stats
