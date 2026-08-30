"""Shared dependencies.

The service is internal-only: in every deployment described in
docs/DEPLOYMENT.md it listens on a private network and is never mapped through
Nginx. The shared-secret check here is defence in depth for the case where that
assumption is wrong.
"""

from __future__ import annotations

import hmac
import logging

from fastapi import Header, HTTPException, status

from .config import settings

logger = logging.getLogger(__name__)


async def require_internal_token(
    x_internal_token: str | None = Header(default=None),
) -> None:
    """Verify the backend's shared secret.

    Compared in constant time so the token cannot be recovered by timing. When
    no token is configured the check is skipped — which is correct for local
    development, and is refused at startup in production (see main.py).
    """
    if not settings.service_token:
        return

    provided = x_internal_token or ""

    if not hmac.compare_digest(provided, settings.service_token):
        logger.warning(
            "rejected request with an invalid internal token",
            extra={"token_supplied": bool(x_internal_token)},
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "INVALID_INTERNAL_TOKEN",
                "message": "A valid x-internal-token header is required.",
            },
        )
