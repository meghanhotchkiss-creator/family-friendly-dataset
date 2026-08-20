"""Live data providers and their cache.

Bulk sources (api/providers/) answer "what places exist" and change slowly.
This package answers "what is true right now" -- weather, opening status,
prices -- and must never be treated as static.

Three rules the rest of the system depends on:

1. A provider is an interface, not a vendor. Swapping OpenWeather for
   Weather.gov is a new class here, not a change anywhere else.
2. Nothing is called unless a decision needs it. A live fetch per POI per
   page-load is how these bills get out of hand.
3. Expired cache is never presented as live. A stale answer is returned only
   when it is labelled stale, so the caller can decide.
"""
from __future__ import annotations

import threading
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

# Freshness classes, matching the tiering used across Scout Fox.
TIER_BASE = "base"        # months  -- country data, coordinates, POI identity
TIER_PERIODIC = "periodic"  # days   -- metadata, hours, transit schedules
TIER_LIVE = "live"          # minutes -- weather, prices, availability


class LiveProviderError(RuntimeError):
    """A live provider could not answer. Callers degrade, they do not crash."""


class ProviderUnavailable(LiveProviderError):
    """The provider is not configured -- usually a missing API key."""


@dataclass
class LiveResult:
    """One live answer, with everything needed to judge how much to trust it.

    `stale` is the important field. A cached payload past its TTL is still
    returned when the provider cannot be reached, but flagged, so the UI can
    say "as of 40 minutes ago" instead of implying it is current.
    """

    provider: str
    entity_type: str
    entity_key: str
    payload: Dict[str, Any]
    retrieved_at: float
    expires_at: float
    confidence: float = 1.0
    stale: bool = False
    freshness_class: str = TIER_LIVE

    @property
    def age_seconds(self) -> float:
        return max(0.0, time.time() - self.retrieved_at)

    def is_expired(self, now: Optional[float] = None) -> bool:
        return (now if now is not None else time.time()) >= self.expires_at

    def to_dict(self) -> Dict[str, Any]:
        return {
            "provider": self.provider,
            "entity_type": self.entity_type,
            "entity_key": self.entity_key,
            "payload": self.payload,
            "retrieved_at": self.retrieved_at,
            "expires_at": self.expires_at,
            "confidence": self.confidence,
            "stale": self.stale,
            "age_seconds": round(self.age_seconds, 1),
            "freshness_class": self.freshness_class,
        }


# Default TTLs in seconds, by entity type. Short for anything a user acts on.
DEFAULT_TTL = {
    "weather": 600,          # 10 min -- forecasts do not move faster than this
    "place_status": 3600,    # 1 hr   -- open/closed
    "flight_offer": 300,     # 5 min  -- fares move constantly
    "hotel_offer": 300,
    "events": 1800,
}


@dataclass
class LiveCache:
    """In-process TTL cache.

    Deliberately simple and deliberately in-memory: this mirrors the
    `live_data_cache` table without requiring a database that does not exist
    yet. It is per-process, so it does not share between Cloud Run instances --
    acceptable for a rate-limit guard, not acceptable as a system of record.
    Swap the two methods for Postgres or Redis when that lands.
    """

    _entries: Dict[str, LiveResult] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    @staticmethod
    def key(entity_type: str, entity_key: str) -> str:
        return f"{entity_type}:{entity_key.strip().lower()}"

    def get(self, entity_type: str, entity_key: str) -> Optional[LiveResult]:
        """Return a cached entry if present, whether or not it has expired.

        Expiry is the caller's decision: a fresh entry is used directly, an
        expired one is a fallback when the provider is down.
        """
        with self._lock:
            return self._entries.get(self.key(entity_type, entity_key))

    def put(self, result: LiveResult) -> LiveResult:
        with self._lock:
            self._entries[self.key(result.entity_type, result.entity_key)] = result
        return result

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)


#: Process-wide cache shared by the providers.
CACHE = LiveCache()


class LiveProvider(ABC):
    """Base class for a live data source."""

    name: str = "unnamed"
    entity_type: str = "unknown"

    def __init__(self, cache: Optional[LiveCache] = None):
        self.cache = cache if cache is not None else CACHE

    def available(self) -> bool:
        return True

    def unavailable_reason(self) -> str:
        return f"{self.name} is not configured"

    def ttl(self) -> int:
        return DEFAULT_TTL.get(self.entity_type, 600)

    @abstractmethod
    def _fetch(self, entity_key: str, **kwargs: Any) -> Dict[str, Any]:
        """Call the upstream API. Raise LiveProviderError on failure."""

    def get(self, entity_key: str, force: bool = False, **kwargs: Any) -> LiveResult:
        """Cached fetch.

        Order: fresh cache, then upstream, then stale cache. Only the last of
        those is ever labelled stale, and it is preferred over an error because
        "the forecast from 20 minutes ago" beats no answer at all.
        """
        cached = self.cache.get(self.entity_type, entity_key)

        if cached is not None and not force and not cached.is_expired():
            return cached

        if not self.available():
            if cached is not None:
                return self._as_stale(cached)
            raise ProviderUnavailable(self.unavailable_reason())

        try:
            payload = self._fetch(entity_key, **kwargs)
        except LiveProviderError:
            if cached is not None:
                return self._as_stale(cached)
            raise
        except Exception as exc:  # noqa: BLE001 -- upstream can raise anything
            if cached is not None:
                return self._as_stale(cached)
            raise LiveProviderError(f"{self.name}: {type(exc).__name__}: {exc}") from exc

        now = time.time()
        return self.cache.put(
            LiveResult(
                provider=self.name,
                entity_type=self.entity_type,
                entity_key=entity_key,
                payload=payload,
                retrieved_at=now,
                expires_at=now + self.ttl(),
                freshness_class=TIER_LIVE,
            )
        )

    @staticmethod
    def _as_stale(cached: LiveResult) -> LiveResult:
        """Return a copy marked stale, with confidence reduced.

        A copy, not a mutation: the cache entry itself stays accurate, so a
        later successful call is not confused by a flag set during an outage.
        """
        return LiveResult(
            provider=cached.provider,
            entity_type=cached.entity_type,
            entity_key=cached.entity_key,
            payload=cached.payload,
            retrieved_at=cached.retrieved_at,
            expires_at=cached.expires_at,
            confidence=round(cached.confidence * 0.5, 3),
            stale=True,
            freshness_class=cached.freshness_class,
        )
