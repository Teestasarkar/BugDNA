"""The 28 features, computed from a pull request's diff plus the history before it.

`compute_features` is the only implementation. The miner feeds it a
`LocalHistory` built from a git clone; the live API feeds it a history backed by
the GitHub REST API. Both must answer the `History` protocol with the same
semantics, which are spelled out on each method.

Nothing here may look at anything that happened after the pull request merged.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Protocol

from . import paths

DAY = 86_400
FILE_HISTORY_DEPTH = 100   # most recent changes per file considered (= one GitHub API page)
HISTORY_FILE_LIMIT = 10    # largest pre-existing files whose history is examined
SUBSYSTEM_LIMIT = 5        # largest top-level directories checked for author experience
NAN = float("nan")


@dataclass(frozen=True)
class FileChange:
    path: str
    additions: int
    deletions: int
    status: str = "modified"          # added | deleted | modified | renamed
    old_path: str | None = None

    @property
    def churn(self) -> int:
        return self.additions + self.deletions

    @property
    def history_path(self) -> str:
        """Where this file's history lives on the base branch (renames: the old name)."""
        return self.old_path if self.status == "renamed" and self.old_path else self.path


@dataclass(frozen=True)
class PRChange:
    title: str
    authors: frozenset[str]           # identity keys for the author (email and/or login)
    timestamp: int                    # unix seconds; only history strictly before counts
    files: tuple[FileChange, ...]


@dataclass(frozen=True)
class Event:
    """One past change to a file on the base branch."""
    sha: str
    timestamp: int
    author: str
    is_fix: bool


class History(Protocol):
    def file_events(self, path: str, before: int) -> Sequence[Event]:
        """Up to FILE_HISTORY_DEPTH most recent changes to `path` before `before`, newest first.
        No rename following (matches `git log -- path` and GitHub's `commits?path=`)."""

    def author_changes(self, authors: frozenset[str], before: int, since: int | None = None) -> int:
        """Changes on the base branch by this author before `before` (and at/after `since`)."""

    def author_path_changes(self, authors: frozenset[str], path: str, before: int) -> int:
        """Changes by this author under top-level directory `path` before `before`."""


@dataclass(frozen=True)
class FeatureSpec:
    name: str
    group: str
    label: str
    description: str


FEATURES: tuple[FeatureSpec, ...] = (
    # Size and diffusion
    FeatureSpec("lines_added", "size", "Lines added", "Lines added across the diff."),
    FeatureSpec("lines_deleted", "size", "Lines deleted", "Lines removed across the diff."),
    FeatureSpec("files_changed", "size", "Files changed", "Number of files the PR touches."),
    FeatureSpec("dirs_changed", "diffusion", "Directories changed", "Distinct directories touched."),
    FeatureSpec("subsystems_changed", "diffusion", "Subsystems changed",
                "Distinct top-level directories touched (root files count as one)."),
    FeatureSpec("change_entropy", "diffusion", "Change entropy",
                "Shannon entropy of churn across files; high means scattered, low means focused."),
    FeatureSpec("max_file_churn_share", "diffusion", "Largest file's share",
                "Share of total churn in the single most-changed file."),
    FeatureSpec("deletion_ratio", "size", "Deletion ratio", "Deleted lines as a share of churn."),
    FeatureSpec("files_added", "size", "Files added", "New files created."),
    FeatureSpec("files_deleted", "size", "Files deleted", "Files removed entirely."),
    # What kind of files
    FeatureSpec("source_files_changed", "content", "Source files changed",
                "Application source files touched (not tests, docs, config or generated)."),
    FeatureSpec("test_files_changed", "content", "Test files changed", "Test files touched."),
    FeatureSpec("test_churn_ratio", "content", "Test churn ratio", "Test churn as a share of all churn."),
    FeatureSpec("untested_source_change", "content", "Source changed without tests",
                "1 if source files changed and no test file did."),
    FeatureSpec("config_files_changed", "content", "Config files changed",
                "CI, Docker, YAML/TOML/JSON and similar configuration files touched."),
    FeatureSpec("dependency_files_changed", "content", "Dependency files changed",
                "Package manifests and lockfiles touched."),
    FeatureSpec("languages_changed", "content", "Languages changed",
                "Distinct programming languages among changed source and test files."),
    FeatureSpec("is_fix", "purpose", "Is a bug fix", "1 if the title describes fixing a defect."),
    # History of the files being changed
    FeatureSpec("prior_changes_365d", "history", "Prior changes (1y)",
                "Distinct past changes to the touched files in the last year."),
    FeatureSpec("recent_changes_90d", "history", "Recent changes (90d)",
                "Distinct past changes to the touched files in the last 90 days."),
    FeatureSpec("prior_authors_365d", "history", "Prior authors (1y)",
                "Distinct people who changed the touched files in the last year."),
    FeatureSpec("prior_fixes_365d", "history", "Prior bug fixes (1y)",
                "Past bug-fix changes to the touched files in the last year."),
    FeatureSpec("mean_file_age_days", "history", "Days since files last changed",
                "Mean days since each touched file was last modified."),
    # Author experience
    FeatureSpec("author_prior_changes", "experience", "Author's prior changes",
                "Changes the author previously landed in this repository."),
    FeatureSpec("author_recent_changes_90d", "experience", "Author's recent changes (90d)",
                "Changes the author landed in the last 90 days."),
    FeatureSpec("author_subsystem_changes", "experience", "Author's changes in these areas",
                "Prior changes by the author in the top-level directories this PR touches."),
    FeatureSpec("author_file_familiarity", "experience", "Author familiarity with files",
                "Share of the touched files the author has changed before."),
    FeatureSpec("author_ownership_share", "experience", "Author ownership share",
                "Share of last year's changes to the touched files that the author made."),
)
FEATURE_NAMES: tuple[str, ...] = tuple(f.name for f in FEATURES)
SPEC_BY_NAME = {f.name: f for f in FEATURES}
assert len(FEATURE_NAMES) == 28, len(FEATURE_NAMES)


def _ratio(num: float, den: float) -> float:
    return num / den if den else NAN


def _entropy(weights: Iterable[int]) -> float:
    ws = [w for w in weights if w > 0]
    total = sum(ws)
    if not total:
        return 0.0
    return max(0.0, -sum((w / total) * math.log2(w / total) for w in ws))


def diff_features(change: PRChange) -> dict[str, float]:
    files = change.files
    kinds = [paths.classify(f.path) for f in files]
    added = sum(f.additions for f in files)
    deleted = sum(f.deletions for f in files)
    churn = added + deleted
    test_churn = sum(f.churn for f, k in zip(files, kinds) if k == paths.TEST)
    n_source = kinds.count(paths.SOURCE)
    n_test = kinds.count(paths.TEST)
    languages = {
        lang for f, k in zip(files, kinds)
        if k in (paths.SOURCE, paths.TEST) and (lang := paths.language(f.path))
    }
    return {
        "lines_added": added,
        "lines_deleted": deleted,
        "files_changed": len(files),
        "dirs_changed": len({paths.directory(f.path) for f in files}),
        "subsystems_changed": len({paths.subsystem(f.path) for f in files}),
        "change_entropy": _entropy(f.churn for f in files),
        "max_file_churn_share": _ratio(max((f.churn for f in files), default=0), churn),
        "deletion_ratio": _ratio(deleted, churn),
        "files_added": sum(f.status == "added" for f in files),
        "files_deleted": sum(f.status == "deleted" for f in files),
        "source_files_changed": n_source,
        "test_files_changed": n_test,
        "test_churn_ratio": _ratio(test_churn, churn),
        "untested_source_change": int(n_source > 0 and n_test == 0),
        "config_files_changed": kinds.count(paths.CONFIG),
        "dependency_files_changed": kinds.count(paths.DEPENDENCY),
        "languages_changed": len(languages),
        "is_fix": NAN,  # filled by compute_features (needs the title)
    }


def history_files(change: PRChange) -> list[str]:
    """Pre-existing files whose history is examined: the largest by churn, ties by path."""
    existing = [f for f in change.files if f.status != "added"]
    existing.sort(key=lambda f: (-f.churn, f.path))
    seen: list[str] = []
    for f in existing:
        if f.history_path not in seen:
            seen.append(f.history_path)
        if len(seen) == HISTORY_FILE_LIMIT:
            break
    return seen


def author_subsystems(change: PRChange) -> list[str]:
    churn_by_sub: Counter[str] = Counter()
    for f in change.files:
        sub = paths.subsystem(f.path)
        if sub:
            churn_by_sub[sub] += f.churn + 1
    return [s for s, _ in sorted(churn_by_sub.items(), key=lambda kv: (-kv[1], kv[0]))][:SUBSYSTEM_LIMIT]


def history_features(change: PRChange, history: History) -> dict[str, float]:
    t = change.timestamp
    year, quarter = t - 365 * DAY, t - 90 * DAY
    files = history_files(change)

    changes_1y: set[str] = set()
    changes_90d: set[str] = set()
    fixes_1y: set[str] = set()
    authors_1y: set[str] = set()
    ages: list[float] = []
    familiar = 0
    with_history = 0
    own_1y: set[str] = set()

    for path in files:
        events = history.file_events(path, before=t)
        if not events:
            continue
        with_history += 1
        ages.append(max(0, t - events[0].timestamp) / DAY)
        if any(e.author in change.authors for e in events):
            familiar += 1
        for e in events:
            if e.timestamp >= year:
                changes_1y.add(e.sha)
                authors_1y.add(e.author)
                if e.is_fix:
                    fixes_1y.add(e.sha)
                if e.author in change.authors:
                    own_1y.add(e.sha)
                if e.timestamp >= quarter:
                    changes_90d.add(e.sha)

    subsystems = author_subsystems(change)
    return {
        "prior_changes_365d": len(changes_1y),
        "recent_changes_90d": len(changes_90d),
        "prior_authors_365d": len(authors_1y),
        "prior_fixes_365d": len(fixes_1y),
        "mean_file_age_days": sum(ages) / len(ages) if ages else NAN,
        "author_prior_changes": history.author_changes(change.authors, before=t),
        "author_recent_changes_90d": history.author_changes(change.authors, before=t, since=quarter),
        "author_subsystem_changes": (
            sum(history.author_path_changes(change.authors, s, before=t) for s in subsystems)
            if subsystems else NAN
        ),
        "author_file_familiarity": _ratio(familiar, with_history),
        "author_ownership_share": _ratio(len(own_1y), len(changes_1y)),
    }


def compute_features(change: PRChange, history: History) -> dict[str, float]:
    from .text import is_bug_fix

    values = diff_features(change)
    values["is_fix"] = int(is_bug_fix(change.title))
    values.update(history_features(change, history))
    return {name: float(values[name]) for name in FEATURE_NAMES}
