"""Activity data providers.

Import the registry, not the individual classes:

    from api.providers import REGISTRY, get_provider
"""
from __future__ import annotations

from typing import Dict, List

from .base import (
    COLUMNS,
    ActivityProvider,
    ProviderError,
    RowValidationError,
    dedupe_key,
    normalise_row,
)
from .nps import NPSProvider
from .places import PlacesProvider
from .seed import SeedProvider

#: Order matters: earlier providers win when two report the same place, so the
#: hand-checked seed takes precedence over a machine-classified Places row.
REGISTRY: Dict[str, ActivityProvider] = {
    provider.name: provider
    for provider in (SeedProvider(), NPSProvider(), PlacesProvider())
}


def get_provider(name: str) -> ActivityProvider:
    try:
        return REGISTRY[name]
    except KeyError:
        raise KeyError(
            f"unknown source {name!r}. Available: {', '.join(sorted(REGISTRY))}"
        ) from None


def provider_names() -> List[str]:
    return list(REGISTRY)


__all__ = [
    "COLUMNS",
    "REGISTRY",
    "ActivityProvider",
    "NPSProvider",
    "PlacesProvider",
    "ProviderError",
    "RowValidationError",
    "SeedProvider",
    "dedupe_key",
    "get_provider",
    "normalise_row",
    "provider_names",
]
