from __future__ import annotations

import math

import pytest

from riskradar import paths
from riskradar.explain import top_factors
from riskradar.features import (
    ALL_FEATURE_NAMES,
    DAY,
    FEATURE_NAMES,
    Event,
    FileChange,
    PRChange,
    compute_features,
    history_files,
)
from riskradar.text import is_bot, is_bug_fix, squash_pr_number, strip_pr_suffix

T = 1_750_000_000


class FakeHistory:
    def __init__(self, files: dict[str, list[Event]], author_counts: dict[str, int] | None = None) -> None:
        self.files = files
        self.author_counts = author_counts or {}
        self.queried: list[str] = []
        self.repo: list[Event] = []
        self.mine: list[Event] = []

    def file_events(self, path: str, before: int) -> list[Event]:
        self.queried.append(path)
        return [e for e in self.files.get(path, []) if e.timestamp < before]

    def author_changes(self, authors, before, since=None):
        return sum(self.author_counts.get(a, 0) for a in authors) if since is None else 1

    def author_path_changes(self, authors, path, before):
        return 3

    def repo_events(self, before):
        return self.repo

    def author_events(self, authors, before):
        return self.mine


@pytest.mark.parametrize(("path", "kind"), [
    ("src/app/main.py", paths.SOURCE),
    ("tests/test_main.py", paths.TEST),
    ("pkg/server_test.go", paths.TEST),
    ("web/src/Button.test.tsx", paths.TEST),
    ("docs/index.md", paths.DOC),
    ("README.md", paths.DOC),
    (".github/workflows/ci.yml", paths.CONFIG),
    ("Dockerfile", paths.CONFIG),
    ("package.json", paths.DEPENDENCY),
    ("uv.lock", paths.DEPENDENCY),
    ("requirements-dev.txt", paths.DEPENDENCY),
    ("dist/bundle.min.js", paths.GENERATED),
    ("crates/core/src/lib.rs", paths.SOURCE),
])
def test_classify(path: str, kind: str) -> None:
    assert paths.classify(path) == kind


@pytest.mark.parametrize(("title", "expected"), [
    ("Fix crash when headers are empty", True),
    ("fix(router): wrong redirect on 404", True),
    ("Resolve deadlock in pool shutdown", True),
    ("Fix typo in docs", False),
    ("fix(deps): update dependency foo", False),
    ("Fix ruff errors", False),
    ("Fix flaky test_retry", False),
    ("Add support for HTTP/3", False),
])
def test_is_bug_fix(title: str, expected: bool) -> None:
    assert is_bug_fix(title) is expected


def test_pr_suffix_and_bots() -> None:
    assert squash_pr_number("Speed up parser (#1234)") == 1234
    assert squash_pr_number("Merge branch 'main'") is None
    assert strip_pr_suffix("Speed up parser (#1234)") == "Speed up parser"
    assert is_bot("49699333+dependabot[bot]@users.noreply.github.com")
    assert not is_bot("12345+alice@users.noreply.github.com", "Alice")


def _change(files, title="Add thing", authors=("alice@x",)) -> PRChange:
    return PRChange(title=title, authors=frozenset(authors), timestamp=T, files=tuple(files))


def test_diff_features() -> None:
    change = _change([
        FileChange("src/a.py", 30, 10),
        FileChange("src/b.py", 10, 0, status="added"),
        FileChange("tests/test_a.py", 20, 0),
        FileChange("pyproject.toml", 1, 1),
    ])
    f = compute_features(change, FakeHistory({}))
    assert list(f) == list(ALL_FEATURE_NAMES) and set(FEATURE_NAMES) <= set(f)
    assert f["lines_added"] == 61 and f["lines_deleted"] == 11
    assert f["files_changed"] == 4 and f["files_added"] == 1
    assert f["subsystems_changed"] == 3            # src, tests, root
    assert f["source_files_changed"] == 2 and f["test_files_changed"] == 1
    assert f["dependency_files_changed"] == 1
    assert f["untested_source_change"] == 0
    assert f["test_churn_ratio"] == pytest.approx(20 / 72)
    assert f["max_file_churn_share"] == pytest.approx(40 / 72)
    assert f["is_fix"] == 0
    # No history anywhere: undefined ratios stay missing rather than becoming zero.
    assert math.isnan(f["mean_file_age_days"]) and math.isnan(f["author_file_familiarity"])


def test_history_features_use_windows_and_union() -> None:
    shared = Event("s1", T - 10 * DAY, "bob@x", is_fix=True)
    hist = FakeHistory({
        "src/a.py": [shared, Event("s2", T - 200 * DAY, "alice@x", False),
                     Event("s3", T - 400 * DAY, "carol@x", False)],
        "src/b.py": [shared, Event("s4", T - 100 * DAY, "dave@x", False)],
    }, author_counts={"alice@x": 7})
    f = compute_features(_change([FileChange("src/a.py", 5, 5), FileChange("src/b.py", 1, 1)]), hist)
    assert f["prior_changes_365d"] == 3            # s1 counted once; s3 is older than a year
    assert f["recent_changes_90d"] == 1
    assert f["prior_authors_365d"] == 3            # bob, alice, dave
    assert f["prior_fixes_365d"] == 1
    assert f["mean_file_age_days"] == pytest.approx(10)
    assert f["author_file_familiarity"] == pytest.approx(0.5)
    assert f["author_ownership_share"] == pytest.approx(1 / 3)
    assert f["author_prior_changes"] == 7
    assert f["author_subsystem_changes"] == 3


def test_history_files_skip_added_and_follow_renames() -> None:
    change = _change([
        FileChange("new.py", 500, 0, status="added"),
        FileChange("lib/renamed.py", 2, 2, status="renamed", old_path="lib/old.py"),
        FileChange("lib/big.py", 50, 50),
    ])
    assert history_files(change) == ["lib/big.py", "lib/old.py"]


def test_top_factors_only_report_risk_raising_features() -> None:
    values = {n: 1.0 for n in FEATURE_NAMES}
    values["lines_added"] = 900
    contribs = {n: 0.0 for n in FEATURE_NAMES}
    contribs.update({"lines_added": 0.8, "prior_fixes_365d": 0.3, "is_fix": -0.5, "files_changed": 0.1})
    factors = top_factors(values, contribs, {"lines_added": 40}, k=3)
    assert [f.feature for f in factors] == ["lines_added", "prior_fixes_365d", "files_changed"]
    assert "900" in factors[0].finding and "40" in factors[0].finding
    assert all(f.remediation for f in factors)


def test_v2_features_repo_author_and_title() -> None:
    hist = FakeHistory({
        "src/a.py": [Event("f1", T - 5 * DAY, "bob@x", True), Event("f2", T - 50 * DAY, "bob@x", True),
                     Event("c1", T - 60 * DAY, "alice@x", False)],
        "src/b.py": [Event("f3", T - 5 * DAY, "bob@x", True)],
    })
    hist.repo = [Event(f"r{i}", T - i * DAY, "x@x", i % 4 == 0) for i in range(1, 41)]   # 10 of 40 are fixes
    hist.mine = [Event("m1", T - DAY, "alice@x", True), Event("m2", T - 9 * DAY, "alice@x", False)]
    change = _change([FileChange("src/a.py", 30, 10), FileChange("src/b.py", 0, 20)],
                     title="feat(core)!: add streaming parser")
    f = compute_features(change, hist)
    assert f["churn_per_file"] == pytest.approx(30)
    assert (f["is_feature"], f["is_refactor"], f["is_breaking"], f["is_fix"]) == (1, 0, 1, 0)
    assert f["prior_fix_ratio_365d"] == pytest.approx(3 / 4)
    assert f["max_file_fixes_365d"] == 2
    assert f["repo_fix_share"] == pytest.approx(10 / 40)
    assert f["repo_changes_30d"] == 30
    assert f["author_fix_share"] == pytest.approx(0.5)
    assert (f["source_lines_added"], f["source_lines_deleted"]) == (30, 30)
    assert f["days_since_last_fix"] == pytest.approx(5)
    assert f["author_days_since_last_change"] == pytest.approx(1)


def test_v2_features_missing_history_is_missing_not_zero() -> None:
    f = compute_features(_change([FileChange("src/a.py", 1, 1)], authors=()), FakeHistory({}))
    assert math.isnan(f["repo_fix_share"]) and math.isnan(f["author_fix_share"])
    assert math.isnan(f["prior_fix_ratio_365d"])
    assert math.isnan(f["days_since_last_fix"]) and math.isnan(f["author_days_since_last_change"])
