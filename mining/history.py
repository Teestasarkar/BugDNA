"""`History` backed by an in-memory replay of a repository's first-parent log.

The miner walks commits oldest-first. Before a commit is applied, the state
holds exactly what was on the base branch before it merged, so features read
from it cannot see the future. `before` arguments are therefore only checked,
never used for filtering.
"""

from __future__ import annotations

import bisect
from collections import Counter, defaultdict, deque

from riskradar import paths
from riskradar.features import FILE_HISTORY_DEPTH, Event
from riskradar.text import is_bug_fix, strip_pr_suffix

from .gitlog import Commit


class LocalHistory:
    def __init__(self) -> None:
        self._files: dict[str, deque[Event]] = defaultdict(lambda: deque(maxlen=FILE_HISTORY_DEPTH))
        self._author_times: dict[str, list[int]] = defaultdict(list)
        self._author_subsystem: Counter[tuple[str, str]] = Counter()
        self._now = -1

    # -- replay -----------------------------------------------------------------
    def apply(self, commit: Commit) -> None:
        event = Event(sha=commit.sha, timestamp=commit.timestamp, author=commit.author_email,
                      is_fix=is_bug_fix(strip_pr_suffix(commit.subject)))
        touched = {f.path for f in commit.files}
        # A deleted or renamed-away path keeps its history (git log -- old/path still shows it).
        touched |= {f.old_path for f in commit.files if f.status == "renamed" and f.old_path}
        for path in touched:
            self._files[path].appendleft(event)
        bisect.insort(self._author_times[commit.author_email], commit.timestamp)
        for sub in {paths.subsystem(p) for p in touched}:
            if sub:
                self._author_subsystem[(commit.author_email, sub)] += 1
        self._now = max(self._now, commit.timestamp)

    # -- History protocol ---------------------------------------------------------
    def file_events(self, path: str, before: int) -> list[Event]:
        return list(self._files.get(path, ()))

    def author_changes(self, authors: frozenset[str], before: int, since: int | None = None) -> int:
        total = 0
        for a in authors:
            times = self._author_times.get(a)
            if times:
                total += len(times) - (bisect.bisect_left(times, since) if since is not None else 0)
        return total

    def author_path_changes(self, authors: frozenset[str], path: str, before: int) -> int:
        return sum(self._author_subsystem[(a, path)] for a in authors)
