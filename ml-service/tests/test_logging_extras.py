"""
Guards against a class of bug that cost a silent fallback to the heuristic
scorer.

`logging` refuses to let an `extra={...}` key shadow a built-in LogRecord
attribute and raises `KeyError: Attempt to overwrite 'name' in LogRecord`. The
raise happens at the call site, so it propagates like any other exception — and
in app/model.py it was caught by the `except Exception` guarding the model load.
The service reported "model load failed" and served the transparent fallback
while a fully loaded XGBoost booster sat in memory.

A unit test cannot easily reach every logging call, so this scans the source
instead. It is a lint expressed as a test: cheap, total, and it fails on the
next collision rather than on the next deploy.
"""

from __future__ import annotations

import ast
from pathlib import Path

# logging.LogRecord's own attributes, which `extra` may not shadow.
# Mirrors the check in logging.Logger.makeRecord.
RESERVED_LOGRECORD_KEYS = frozenset(
    {
        "args", "asctime", "created", "exc_info", "exc_text", "filename",
        "funcName", "levelname", "levelno", "lineno", "module", "msecs",
        "message", "msg", "name", "pathname", "process", "processName",
        "relativeCreated", "stack_info", "thread", "threadName", "taskName",
    }
)

SOURCE_ROOTS = ("app", "training")


def _python_files() -> list[Path]:
    root = Path(__file__).resolve().parent.parent
    return [f for d in SOURCE_ROOTS for f in (root / d).rglob("*.py")]


def _reserved_extra_keys(path: Path) -> list[tuple[int, str]]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        for keyword in node.keywords:
            if keyword.arg != "extra" or not isinstance(keyword.value, ast.Dict):
                continue
            for key in keyword.value.keys:
                if isinstance(key, ast.Constant) and key.value in RESERVED_LOGRECORD_KEYS:
                    found.append((key.lineno, str(key.value)))
    return found


def test_no_logging_extra_shadows_a_logrecord_attribute() -> None:
    offenders = [
        f"{path.name}:{lineno} uses reserved key {key!r}"
        for path in _python_files()
        for lineno, key in _reserved_extra_keys(path)
    ]
    assert not offenders, (
        "logging `extra` keys must not shadow LogRecord attributes; "
        "stdlib logging raises KeyError at the call site:\n  "
        + "\n  ".join(offenders)
    )


def test_the_scan_actually_detects_a_collision(tmp_path: Path) -> None:
    """A scan that can never fail is not a test. Prove it catches the real case."""
    sample = tmp_path / "sample.py"
    sample.write_text('logger.info("x", extra={"name": 1})\n', encoding="utf-8")
    assert _reserved_extra_keys(sample) == [(1, "name")]
