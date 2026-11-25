"""Turn SHAP contributions into the top risk factors and what to do about them.

A factor is reported only if its SHAP value pushes risk *up* for this PR, so
every remediation step answers "why is this PR risky", never "why is it safe".
Each step quotes the PR's own value next to the dataset median, so the advice
is specific to this PR and can be checked.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping
from dataclasses import asdict, dataclass

from .features import SPEC_BY_NAME


@dataclass(frozen=True)
class Factor:
    feature: str
    label: str
    value: float | None
    median: float | None
    shap: float
    finding: str
    remediation: str

    def to_dict(self) -> dict:
        return asdict(self)


def _n(v: float) -> str:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "n/a"
    return f"{v:,.0f}" if abs(v) >= 10 or float(v).is_integer() else f"{v:.2f}"


def _pct(v: float) -> str:
    return "n/a" if v is None or math.isnan(v) else f"{v * 100:.0f}%"


def _areas(ctx: Mapping) -> str:
    subs = ctx.get("subsystems") or []
    return ", ".join(f"`{s}/`" for s in subs[:3]) if subs else "the areas this PR touches"


def _top_file(ctx: Mapping) -> str:
    files = ctx.get("top_files") or []
    return f" (`{files[0]}`)" if files else ""


Template = Callable[[float, float, Mapping], tuple[str, str]]

TEMPLATES: dict[str, Template] = {
    "lines_added": lambda v, m, c: (
        f"Adds {_n(v)} lines; the median PR adds {_n(m)}.",
        "Split it: land refactors, the behaviour change and clean-up as separate PRs so each gets a focused review."),
    "lines_deleted": lambda v, m, c: (
        f"Removes {_n(v)} lines; the median PR removes {_n(m)}.",
        "Search for remaining callers, imports and config that still reference the removed code, and confirm tests cover the paths that replaced it."),
    "files_changed": lambda v, m, c: (
        f"Touches {_n(v)} files; the median PR touches {_n(m)}.",
        "Split by concern, or walk reviewers through the change file by file in the description."),
    "dirs_changed": lambda v, m, c: (
        f"Spans {_n(v)} directories; the median PR spans {_n(m)}.",
        "Ask for a reviewer who owns each directory (CODEOWNERS) instead of one generalist."),
    "subsystems_changed": lambda v, m, c: (
        f"Crosses {_n(v)} top-level areas ({_areas(c)}).",
        "Changes that cross module boundaries break contracts between them: get a reviewer from each area and run every area's test suite."),
    "change_entropy": lambda v, m, c: (
        f"Changes are scattered across files (entropy {_n(v)} vs median {_n(m)}).",
        "Move mechanical edits (renames, formatting, imports) into their own PR so the behavioural change is easy to see."),
    "max_file_churn_share": lambda v, m, c: (
        f"{_pct(v)} of the change sits in one file{_top_file(c)}." if v >= (m or 0)
        else f"No single file dominates: the largest holds only {_pct(v)} of the change.",
        "Review the dominant file line by line and make sure its tests exercise every changed branch." if v >= (m or 0)
        else "Explain in the description how the scattered edits fit together, so reviewers can check them as one change."),
    "deletion_ratio": lambda v, m, c: (
        f"{_pct(v)} of the changed lines are deletions (median {_pct(m)}).",
        "Mostly-deleting changes remove behaviour as easily as dead code: confirm with a search that nothing still depends on it."
        if v >= (m or 0) else "This is mostly new code with no production history: cover the new paths with tests before merging."),
    "files_added": lambda v, m, c: (
        f"Adds {_n(v)} new files.",
        "New files have no history and no existing tests: add tests for each and make sure they are wired into CI and packaging."),
    "files_deleted": lambda v, m, c: (
        f"Deletes {_n(v)} files.",
        "Search for imports, build config and docs that still point at the deleted files."),
    "source_files_changed": lambda v, m, c: (
        f"Changes {_n(v)} source files; the median PR changes {_n(m)}.",
        "Split it so each PR changes one behaviour, or list the files reviewers should read first."),
    "test_files_changed": lambda v, m, c: (
        f"Touches {_n(v)} test files.",
        "Add a test that fails without this change and passes with it."),
    "test_churn_ratio": lambda v, m, c: (
        f"Only {_pct(v)} of the changed lines are tests (median {_pct(m)}).",
        "Add tests for the new or changed behaviour before merging."),
    "untested_source_change": lambda v, m, c: (
        "Source code changed but no test file did." if v else "Tests changed alongside the source.",
        "Add or update a test that exercises the changed code path."),
    "config_files_changed": lambda v, m, c: (
        f"Changes {_n(v)} configuration files.",
        "Config takes effect at deploy time and is rarely tested: validate it in staging or behind a flag, and write down the rollback."),
    "dependency_files_changed": lambda v, m, c: (
        f"Changes {_n(v)} dependency manifests or lockfiles.",
        "Read the upstream changelogs for breaking changes and run the full integration suite, not just unit tests."),
    "languages_changed": lambda v, m, c: (
        f"Spans {_n(v)} programming languages.",
        "Make sure someone fluent in each language reviews their part."),
    "is_fix": lambda v, m, c: (
        "This is a bug fix." if v else "This is not described as a bug fix.",
        "Bug fixes are a common source of new bugs: add a regression test that reproduces the original failure and check sibling code paths for the same mistake."),
    "prior_changes_365d": lambda v, m, c: (
        f"These files changed {_n(v)} times in the past year (median {_n(m)}).",
        "This code is actively moving: rebase on the latest base branch and re-run the full suite right before merging."),
    "recent_changes_90d": lambda v, m, c: (
        f"These files changed {_n(v)} times in the last 90 days (median {_n(m)}).",
        "Check recently merged PRs to the same files for conflicting assumptions, then rebase and re-test."),
    "prior_authors_365d": lambda v, m, c: (
        f"{_n(v)} different people edited these files in the past year (median {_n(m)}).",
        "Ownership is diffuse: ask the most frequent recent contributor to these files to review."),
    "prior_fixes_365d": lambda v, m, c: (
        f"These files needed {_n(v)} bug fixes in the past year (median {_n(m)}).",
        "This code is historically fragile: ask someone who fixed it recently to review, and add tests around the previously fixed areas."),
    "mean_file_age_days": lambda v, m, c: (
        f"The touched files were last changed about {_n(v)} days ago on average (median {_n(m)}).",
        "Code that has been quiet for longer than usual may have callers relying on behaviour nobody remembers: add characterization tests before changing it."
        if v >= (m or 0) else "This code is still settling from recent changes: confirm those changes are finished before building on them."),
    "author_prior_changes": lambda v, m, c: (
        f"The author has {_n(v)} earlier changes in this repository (median {_n(m)}).",
        "Pair with a maintainer for review; ask them to check for project conventions and hidden coupling."),
    "author_recent_changes_90d": lambda v, m, c: (
        f"The author landed {_n(v)} changes here in the last 90 days.",
        "The codebase may have moved since the author last worked in it: review recent changes to these files before merging."),
    "author_subsystem_changes": lambda v, m, c: (
        f"The author has {_n(v)} earlier changes in {_areas(c)} (median {_n(m)}).",
        "Request review from someone who regularly works in these areas."),
    "author_file_familiarity": lambda v, m, c: (
        f"The author has previously changed {_pct(v)} of these files (median {_pct(m)}).",
        "Add a reviewer who has worked on these files before."),
    "author_ownership_share": lambda v, m, c: (
        f"The author made {_pct(v)} of last year's changes to these files (median {_pct(m)}).",
        "Loop in the files' main contributors; they know the invariants the code depends on."),
}
assert set(TEMPLATES) == set(SPEC_BY_NAME), set(SPEC_BY_NAME) ^ set(TEMPLATES)


def top_factors(values: Mapping[str, float], contributions: Mapping[str, float],
                medians: Mapping[str, float], context: Mapping | None = None, k: int = 3) -> list[Factor]:
    """The k features pushing risk up the most, each with a finding and a remediation step."""
    ctx = context or {}
    def known(name: str) -> bool:
        v = values.get(name)
        return v is not None and not (isinstance(v, float) and math.isnan(v))

    # A missing value can still carry SHAP weight, but there is nothing to act on, so skip it.
    risky = sorted(((f, s) for f, s in contributions.items() if s > 0 and known(f)), key=lambda fs: -fs[1])[:k]
    factors = []
    for name, shap_value in risky:
        v = values.get(name)
        m = medians.get(name)
        v_f = float("nan") if v is None else float(v)
        m_f = None if m is None or (isinstance(m, float) and math.isnan(m)) else float(m)
        finding, remediation = TEMPLATES[name](v_f, m_f, ctx)
        factors.append(Factor(feature=name, label=SPEC_BY_NAME[name].label,
                              value=None if math.isnan(v_f) else v_f, median=m_f,
                              shap=round(float(shap_value), 4), finding=finding, remediation=remediation))
    return factors
