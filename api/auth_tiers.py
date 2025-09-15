"""Utilities for tier-based API key authorization."""
from __future__ import annotations

from typing import Callable

from fastapi import Depends, HTTPException, status
from fastapi.security import APIKeyHeader

# Header used by the API to transmit the client's key.
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

# Mapping of demo API keys to the tier of features that key has access to.
USER_TIERS = {
    "demo_free_key": "free",
    "demo_pro_key": "pro",
    "demo_business_key": "business",
}

# Hierarchy of tiers so that higher plans can access lower level endpoints.
_TIER_LEVELS = {"free": 0, "pro": 1, "business": 2}


def verify_tier(required_tier: str) -> Callable[..., str]:
    """Create a dependency ensuring the requester meets the required tier.

    The dependency validates the ``X-API-Key`` header and compares the
    associated tier with the ``required_tier``. Keys that are missing,
    unknown, or belong to a lower tier result in an HTTP error. When the
    validation succeeds the API key itself is returned so endpoints can
    attribute actions to the caller.
    """

    required_level = _TIER_LEVELS.get(required_tier)
    if required_level is None:
        raise ValueError(f"Unknown required tier: {required_tier}")

    async def dependency(api_key: str = Depends(api_key_header)) -> str:
        if not api_key:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing API key",
            )

        tier = USER_TIERS.get(api_key)
        if tier is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Invalid API key",
            )

        if _TIER_LEVELS[tier] < required_level:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient tier for this endpoint",
            )

        return api_key

    return dependency


__all__ = ["USER_TIERS", "verify_tier"]
