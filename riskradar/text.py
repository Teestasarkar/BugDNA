"""Title and author heuristics shared by the miner and the live scorer."""

from __future__ import annotations

import re

_FIX = re.compile(
    r"\b(fix|fixes|fixed|fixing|bug|bugs|bugfix|hotfix|regression|crash|crashes|crashing"
    r"|broken|incorrect|wrong|fault|defect|panic|segfault|leak|deadlock|race)\b",
    re.IGNORECASE,
)
# A "fix" that only touches prose, tooling or tests is not a defect fix.
_NOT_DEFECT = re.compile(
    r"\b(typo|typos|spelling|grammar|wording|lint|linting|linter|clippy|mypy|ruff|eslint"
    r"|prettier|pyright|tsc|typecheck|typos?-check|docs?|documentation|readme|changelog"
    r"|comment|comments|docstrings?|ci|workflows?|flake|flaky|format|formatting|style"
    r"|whitespace|link|links|badge|tests?|examples?|benchmarks?|coverage|deps|release"
    r"|warnings?|deprecations?|typing|typings"
    r"|type[- ]?(annotations?|hints?|checks?|checking|errors?))\b"
    r"|^(docs|chore|ci|style|test|build|refactor)(\(|:|!)",
    re.IGNORECASE,
)
_SQUASH_PR = re.compile(r"\s*\(#(\d+)\)\s*$")
_BOT = re.compile(
    r"\[bot\]|dependabot|renovate|github-actions|pre-commit-ci|allcontributors|greenkeeper"
    r"|snyk-bot|mergify|copilot|codegen|release-please|changeset|^bot@|noreply@github\.com$",
    re.IGNORECASE,
)


_FEATURE = re.compile(
    r"^(feat|feature)(\(|:|!)|\b(add|adds|added|adding|implement|implements|implemented|introduce|introduces"
    r"|support|supports|new)\b", re.IGNORECASE)
_REFACTOR = re.compile(
    r"^refactor(\(|:|!)|\b(refactor|refactors|refactoring|refactored|cleanup|clean up|simplify|simplifies"
    r"|restructure|reorgani[sz]e|rename|renames|extract|extracts|move|moves|migrate|migrates|consolidate)\b",
    re.IGNORECASE)
_BREAKING = re.compile(r"^\w+(\([^)]*\))?!:|\bbreaking\b", re.IGNORECASE)


def is_feature(title: str) -> bool:
    return bool(_FEATURE.search(title))


def is_refactor(title: str) -> bool:
    return bool(_REFACTOR.search(title))


def is_breaking(title: str) -> bool:
    return bool(_BREAKING.search(title))


def is_bug_fix(title: str) -> bool:
    """True when a PR title describes fixing a defect (the Kamei et al. FIX signal)."""
    return bool(_FIX.search(title)) and not _NOT_DEFECT.search(title)


def squash_pr_number(subject: str) -> int | None:
    """PR number from a GitHub squash-merge subject such as 'Fix parser (#123)'."""
    m = _SQUASH_PR.search(subject)
    return int(m.group(1)) if m else None


def strip_pr_suffix(subject: str) -> str:
    return _SQUASH_PR.sub("", subject).strip()


def is_bot(*identities: str | None) -> bool:
    return any(i and _BOT.search(i) for i in identities)
