"""End-to-end check of mining + SZZ on a tiny synthetic repository with a known answer."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from mining.build_dataset import process_repo
from mining.gitlog import first_parent_commits

DAY = 86_400
T0 = 1_700_000_000


def _git(repo: Path, *args: str, when: int, author: str = "alice") -> None:
    env = {**os.environ, "GIT_AUTHOR_NAME": author, "GIT_AUTHOR_EMAIL": f"{author}@example.com",
           "GIT_COMMITTER_NAME": "GitHub", "GIT_COMMITTER_EMAIL": "noreply@github.com",
           "GIT_AUTHOR_DATE": f"{when} +0000", "GIT_COMMITTER_DATE": f"{when} +0000"}
    subprocess.run(["git", "-C", str(repo), *args], check=True, env=env, capture_output=True)


def _commit(repo: Path, files: dict[str, str | None], subject: str, when: int, author: str = "alice") -> None:
    for path, content in files.items():
        p = repo / path
        if content is None:
            _git(repo, "rm", "-q", path, when=when)
            continue
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8", newline="\n")
        _git(repo, "add", path, when=when)
    _git(repo, "commit", "-q", "-m", subject, when=when, author=author)


@pytest.fixture()
def repo(tmp_path: Path) -> Path:
    r = tmp_path / "demo"
    r.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main", str(r)], check=True)
    subprocess.run(["git", "-C", str(r), "config", "core.autocrlf", "false"], check=True)
    _commit(r, {"src/calc.py": "def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n"},
            "Initial calculator (#1)", T0)
    _commit(r, {"src/calc.py": "def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n\n\n"
                               "def mul(a, b):\n    # multiply\n    return a + b\n"},
            "Add mul (#2)", T0 + 1 * DAY, author="bob")
    _commit(r, {"README.md": "# demo\n"}, "Write a readme (#3)", T0 + 2 * DAY)
    _commit(r, {"src/util.py": "VALUE = 1\n", "tests/test_calc.py": "def test_add():\n    assert True\n"},
            "Add util and a test (#4)", T0 + 3 * DAY)
    _commit(r, {"src/calc.py": "def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n\n\n"
                               "def mul(a, b):\n    # multiply\n    return a * b\n"},
            "Fix mul returning a sum (#5)", T0 + 40 * DAY)
    _commit(r, {"src/util.py": "VALUE = 2\n"}, "Fix typo in util (#6)", T0 + 41 * DAY)
    return r


def test_first_parent_log_reads_status_and_counts(repo: Path) -> None:
    commits = first_parent_commits(repo)
    assert [c.subject for c in commits][:2] == ["Initial calculator (#1)", "Add mul (#2)"]
    add_mul = commits[1]
    assert add_mul.author_email == "bob@example.com"
    (f,) = add_mul.files
    assert (f.path, f.status, f.additions, f.deletions) == ("src/calc.py", "modified", 5, 0)
    assert {x.status for x in commits[3].files} == {"added"}


def test_szz_labels_the_pr_that_introduced_the_fixed_line(repo: Path) -> None:
    rows, stats = process_repo("demo/demo", repo, cutoff=T0 + 10 * DAY, per_repo=50, workers=2)
    by_number = {r["number"]: r for r in rows}
    # #3 changes only a README, so it is not eligible; #5 and #6 merged after the cutoff.
    assert sorted(by_number) == [1, 2, 4]
    assert by_number[2]["label"] == 1 and by_number[2]["fixed_by"] == "#5"
    # The comment line in #2 was not changed by the fix, and the "typo" fix is not a defect fix.
    assert by_number[1]["label"] == 0 and by_number[4]["label"] == 0
    assert stats["defect_inducing"] == 1


def test_features_only_see_the_past(repo: Path) -> None:
    rows, _ = process_repo("demo/demo", repo, cutoff=T0 + 10 * DAY, per_repo=50, workers=2)
    r2 = next(r for r in rows if r["number"] == 2)
    assert r2["author_prior_changes"] == 0           # bob's first change
    assert r2["prior_changes_365d"] == 1             # only #1 touched calc.py before
    assert r2["author_file_familiarity"] == 0
    assert r2["untested_source_change"] == 1
    assert r2["lines_added"] == 5 and r2["files_changed"] == 1
    r4 = next(r for r in rows if r["number"] == 4)
    assert r4["author_prior_changes"] == 2           # alice: #1 and #3
    assert r4["test_files_changed"] == 1 and r4["files_added"] == 2
