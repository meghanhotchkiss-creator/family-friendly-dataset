"""Utilities for tier-based API key verification."""

from __future__ import annotations

from typing import Callable, Dict

from fastapi import Depends, HTTPException
from fastapi.security import APIKeyHeader

from seed_loader import user_tiers as _seeded_user_tiers

# Keys that exist even when data/seeds/users.json is unavailable, so the API
# is still usable on a bare checkout.
FALLBACK_USER_TIERS: Dict[str, str] = {
    "demo_free_key": "free",
    "demo_pro_key": "pro",
    "demo_business_key": "business",
}

# Mapping of API keys to their access tiers, seeded from data/seeds/users.json.
USER_TIERS: Dict[str, str] = {**FALLBACK_USER_TIERS, **_seeded_user_tiers()}

# Hierarchy of tiers for comparison when enforcing access levels.
_TIER_LEVELS = {"free": 0, "pro": 1, "business": 2}

_api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def verify_tier(required_tier: str) -> Callable[..., str]:
    """Return a FastAPI dependency that enforces the required tier.

    Parameters
    ----------
    required_tier:
        The minimum tier required to access the endpoint.

    Returns
    -------
    Callable[..., str]
        A dependency function returning the validated API key when the
        requester satisfies the tier requirement.
    """

    if required_tier not in _TIER_LEVELS:
        raise ValueError(f"Unknown tier: {required_tier}")

    def dependency(api_key: str = Depends(_api_key_header)) -> str:
        if not api_key:
            raise HTTPException(status_code=401, detail="API key missing")

        user_tier = USER_TIERS.get(api_key)
        if user_tier is None:
            raise HTTPException(status_code=403, detail="Invalid API key")

        if _TIER_LEVELS[user_tier] < _TIER_LEVELS[required_tier]:
            raise HTTPException(status_code=403, detail="Insufficient access tier")

        return api_key

    return dependency


__all__ = ["FALLBACK_USER_TIERS", "USER_TIERS", "verify_tier"]
