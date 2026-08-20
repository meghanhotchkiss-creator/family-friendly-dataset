"""Live (Tier 3) data providers — fetched at decision time, never assumed.

    from live import WEATHER, CACHE

Bulk, slow-changing data lives in api/providers/. Anything volatile enough
that a stale answer would mislead a traveller lives here.
"""
from __future__ import annotations

from typing import Dict

from .base import (
    CACHE,
    DEFAULT_TTL,
    TIER_BASE,
    TIER_LIVE,
    TIER_PERIODIC,
    LiveCache,
    LiveProvider,
    LiveProviderError,
    LiveResult,
    ProviderUnavailable,
)
from .weather import OpenWeatherProvider

WEATHER = OpenWeatherProvider()

REGISTRY: Dict[str, LiveProvider] = {WEATHER.name: WEATHER}

__all__ = [
    "CACHE",
    "DEFAULT_TTL",
    "REGISTRY",
    "TIER_BASE",
    "TIER_LIVE",
    "TIER_PERIODIC",
    "WEATHER",
    "LiveCache",
    "LiveProvider",
    "LiveProviderError",
    "LiveResult",
    "OpenWeatherProvider",
    "ProviderUnavailable",
]
