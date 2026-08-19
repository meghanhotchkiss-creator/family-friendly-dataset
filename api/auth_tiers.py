"""Utilities for tier-based API key verification."""

from __future__ import annotations

import hmac
import json
import os
from typing import Callable, Dict, Optional

from fastapi import Depends, HTTPException
from fastapi.security import APIKeyHeader

# Hierarchy of tiers for comparison when enforcing access levels.
_TIER_LEVELS = {"free": 0, "pro": 1, "business": 2}


def _load_user_tiers() -> Dict[str, str]:
    """Build the API-key -> tier mapping from the environment.

    Keys are credentials. Holding them as literals in this file published
    working credentials for every tier, including ``business``, to anyone who
    could read the repository.

    ``API_KEY_TIERS`` is a JSON object of {api_key: tier}. When it is unset the
    mapping is empty and every request is rejected, which is the safe default:
    a deployment that forgot to configure keys denies access rather than
    accepting well-known ones. Set ``ALLOW_DEMO_KEYS=true`` to restore the
    documented demo keys for local development only.
    """
    raw = os.getenv("API_KEY_TIERS")
    if raw:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError("API_KEY_TIERS is not valid JSON") from exc
        if not isinstance(parsed, dict):
            raise RuntimeError("API_KEY_TIERS must be a JSON object of {api_key: tier}")
        for key, tier in parsed.items():
            if tier not in _TIER_LEVELS:
                raise RuntimeError(f"API_KEY_TIERS contains unknown tier: {tier!r}")
        return dict(parsed)

    if os.getenv("ALLOW_DEMO_KEYS", "false").lower() == "true":
        return {
            "demo_free_key": "free",
            "demo_pro_key": "pro",
            "demo_business_key": "business",
        }

    return {}


def _lookup_tier(api_key: str) -> Optional[str]:
    """Return the tier for ``api_key`` using a constant-time comparison.

    A plain dict lookup compares keys in a way that can leak through timing.
    The mapping is small, so scanning it is cheap.
    """
    matched = None
    for known_key, tier in USER_TIERS.items():
        if hmac.compare_digest(api_key, known_key):
            matched = tier
    return matched

USER_TIERS: Dict[str, str] = _load_user_tiers()

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

        user_tier = _lookup_tier(api_key)
        if user_tier is None:
            raise HTTPException(status_code=403, detail="Invalid API key")

        if _TIER_LEVELS[user_tier] < _TIER_LEVELS[required_tier]:
            raise HTTPException(status_code=403, detail="Insufficient access tier")

        return api_key

    return dependency


__all__ = ["USER_TIERS", "verify_tier"]
