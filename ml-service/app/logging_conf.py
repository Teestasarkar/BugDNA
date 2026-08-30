"""Logging setup.

Emits JSON by default so the risk service's logs are queryable in the same way
as the Node services' pino output — one shape across the whole system rather
than three formats to grep differently. ``LOG_FORMAT=pretty`` gives readable
lines for local development.

Written against the standard library rather than adding a dependency: the whole
requirement is "one JSON object per line, with request context", which is about
forty lines.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any, ClassVar

from .config import settings

# Attributes present on every LogRecord; anything else was passed via `extra`
# and is worth including in the structured output.
_RESERVED = {
    "args", "asctime", "created", "exc_info", "exc_text", "filename", "funcName",
    "levelname", "levelno", "lineno", "module", "msecs", "message", "msg", "name",
    "pathname", "process", "processName", "relativeCreated", "stack_info",
    "thread", "threadName", "taskName",
}

_REDACT_KEYS = {
    "token", "service_token", "authorization", "x_internal_token",
    "password", "secret", "api_key",
}


class JsonFormatter(logging.Formatter):
    """One JSON object per line."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "time": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname.lower(),
            "service": "bugdna-ml",
            "env": settings.environment,
            "logger": record.name,
            "msg": record.getMessage(),
        }

        for key, value in record.__dict__.items():
            if key in _RESERVED or key.startswith("_"):
                continue
            payload[key] = "[redacted]" if key.lower() in _REDACT_KEYS else value

        if record.exc_info:
            payload["error"] = self.formatException(record.exc_info)

        return json.dumps(payload, default=str)


class PrettyFormatter(logging.Formatter):
    """Human-readable lines, with any `extra` fields appended."""

    _COLOURS: ClassVar[dict[str, str]] = {
        "DEBUG": "\033[36m",
        "INFO": "\033[32m",
        "WARNING": "\033[33m",
        "ERROR": "\033[31m",
        "CRITICAL": "\033[35m",
    }
    _RESET = "\033[0m"

    def format(self, record: logging.LogRecord) -> str:
        colour = self._COLOURS.get(record.levelname, "")
        stamp = datetime.fromtimestamp(record.created, tz=UTC).strftime("%H:%M:%S.%f")[:-3]

        extras = {
            k: ("[redacted]" if k.lower() in _REDACT_KEYS else v)
            for k, v in record.__dict__.items()
            if k not in _RESERVED and not k.startswith("_")
        }
        suffix = f"  {json.dumps(extras, default=str)}" if extras else ""

        line = (
            f"{stamp} {colour}{record.levelname:<8}{self._RESET} "
            f"{record.name:<24} {record.getMessage()}{suffix}"
        )

        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)

        return line


def configure_logging() -> None:
    """Install the formatter on the root logger and align uvicorn with it."""
    formatter: logging.Formatter = (
        PrettyFormatter() if settings.log_format == "pretty" else JsonFormatter()
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(settings.log_level)

    # uvicorn installs its own handlers; replacing them keeps one log format.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        target = logging.getLogger(name)
        target.handlers.clear()
        target.propagate = True

    # These libraries are extremely chatty at INFO and say nothing useful here.
    for name in ("numba", "shap", "matplotlib", "urllib3"):
        logging.getLogger(name).setLevel(logging.WARNING)
