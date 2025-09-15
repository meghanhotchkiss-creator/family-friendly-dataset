"""Utilities for enforcing API access tiers."""
from __future__ import annotations

from typing import Callable

from fastapi import Depends, HTTPException, status
from fastapi.security import APIKeyHeader

# Demo API keys that map to their allowed subscription tier.
USER_TIERS = {
    "demo_free_key": "free",
    "demo_pro_key": "pro",
    "demo_business_key": "business",
}

# Define the hierarchy of tiers so we can compare access levels.
_TIER_RANK = {"free": 0, "pro": 1, "business": 2}

_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def verify_tier(required_tier: str) -> Callable[..., str]:
    """FastAPI dependency ensuring the caller meets the required tier.

    Args:
        required_tier: The minimum tier necessary to access the endpoint.

    Returns:
        A dependency callable that validates the incoming API key and returns it
        when the requirements are satisfied.
    """

    if required_tier not in _TIER_RANK:
        raise ValueError(f"Unknown tier '{required_tier}'.")

    def dependency(api_key: str = Depends(_api_key_header)) -> str:
        if not api_key:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Missing API key.",
            )

        user_tier = USER_TIERS.get(api_key)
        if not user_tier:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Invalid API key.",
            )

        if _TIER_RANK[user_tier] < _TIER_RANK[required_tier]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient tier for this operation.",
            )

        return api_key

    return dependency


__all__ = ["USER_TIERS", "verify_tier"]
