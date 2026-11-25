"""Read a repository's first-parent history, with per-file line counts and status."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

from riskradar.features import FileChange

_STATUS = {"A": "added", "D": "deleted", "M": "modified", "R": "renamed", "C": "added", "T": "modified"}


@dataclass
class Commit:
    sha: str
    parent: str | None
    timestamp: int           # committer time (= merge time for squash merges)
    author_email: str
    author_name: str
    subject: str
    files: tuple[FileChange, ...]


def git(repo: Path, *args: str, timeout: float | None = None, check: bool = True) -> bytes:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, timeout=timeout,
    )
    if check and proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args[:3])} failed: {proc.stderr.decode(errors='replace')[:300]}")
    return proc.stdout


def _dec(b: bytes) -> str:
    return b.decode("utf-8", errors="replace")


def _parse_body(body: bytes) -> tuple[FileChange, ...]:
    """Parse the `--raw --numstat -z` section that follows one commit header."""
    tokens = body.split(b"\0")
    i, n = 0, len(tokens)
    raw: list[tuple[str, str, str | None]] = []     # (status, path, old_path)
    counts: dict[str, tuple[int, int]] = {}
    while i < n:
        tok = tokens[i].lstrip(b"\n")
        i += 1
        if not tok:
            continue
        if tok.startswith(b":"):
            letter = _dec(tok.split()[-1])[:1]
            if letter in ("R", "C"):
                old, new = _dec(tokens[i]), _dec(tokens[i + 1])
                i += 2
                raw.append((letter, new, old))
            else:
                raw.append((letter, _dec(tokens[i]), None))
                i += 1
            continue
        parts = tok.split(b"\t")
        if len(parts) != 3:
            continue
        a, d, path = parts
        if not path:                                 # rename: old and new paths follow
            path = tokens[i + 1]
            i += 2
        add = int(a) if a.isdigit() else 0           # '-' means binary
        dele = int(d) if d.isdigit() else 0
        counts[_dec(path)] = (add, dele)
    files = []
    for letter, path, old in raw:
        add, dele = counts.get(path, (0, 0))
        files.append(FileChange(path=path, additions=add, deletions=dele,
                                status=_STATUS.get(letter, "modified"), old_path=old))
    return tuple(files)


def first_parent_commits(repo: Path, rev: str = "HEAD") -> list[Commit]:
    """Oldest-first list of commits on the base branch, diffed against their first parent."""
    out = git(repo, "log", "--first-parent", "--diff-merges=first-parent", "-M", "--raw",
              "--numstat", "-z", "--no-abbrev", "--reverse",
              "--format=%x1e%H%x1f%P%x1f%ct%x1f%ae%x1f%an%x1f%s", rev)
    commits: list[Commit] = []
    for record in out.split(b"\x1e")[1:]:
        header, _, body = record.partition(b"\0")
        sha, parents, ct, ae, an, subject = _dec(header).split("\x1f", 5)
        parent = parents.split()[0] if parents.strip() else None
        commits.append(Commit(sha=sha, parent=parent, timestamp=int(ct), author_email=ae.strip().lower(),
                              author_name=an.strip(), subject=subject.strip(), files=_parse_body(body)))
    return commits
