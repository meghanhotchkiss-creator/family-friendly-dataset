"""OpenWeather provider.

Weather is the live signal Scout Fox most obviously needs: the dataset already
classifies every activity as indoor, outdoor, or both, and that classification
is only useful if something knows what the weather is doing.

Configure with OPENWEATHER_API_KEY. A new key takes a couple of hours to
activate; until then OpenWeather returns 401, which surfaces here as a clear
message rather than a generic failure.

Free tier at time of writing: 60 calls/minute, 1,000,000 calls/month. The TTL
cache in base.py exists so a busy page cannot burn through that.
"""
from __future__ import annotations

import os
from typing import Any, Dict, Optional

from .base import LiveProvider, LiveProviderError, ProviderUnavailable

ENDPOINT = "https://api.openweathermap.org/data/2.5/weather"

# OpenWeather condition codes group by leading digit:
#   2xx thunderstorm, 3xx drizzle, 5xx rain, 6xx snow, 7xx atmosphere,
#   800 clear, 80x clouds.
BAD_FOR_OUTDOORS = {2, 3, 5, 6}

# Comfort bounds in Celsius for a family with young children outdoors.
# Deliberately conservative: the cost of a bad "go outside" call is a ruined
# afternoon, the cost of a bad "stay in" call is a museum.
COMFORTABLE_MIN_C = 5.0
COMFORTABLE_MAX_C = 32.0


class OpenWeatherProvider(LiveProvider):
    name = "openweather"
    entity_type = "weather"

    def __init__(self, api_key: Optional[str] = None, session=None, cache=None):
        super().__init__(cache=cache)
        self.api_key = (
            api_key if api_key is not None else os.getenv("OPENWEATHER_API_KEY", "")
        )
        self._session = session

    def available(self) -> bool:
        return bool(self.api_key)

    def unavailable_reason(self) -> str:
        return "OPENWEATHER_API_KEY is not set"

    def _fetch(self, entity_key: str, **kwargs: Any) -> Dict[str, Any]:
        """entity_key is a place query: "Austin,TX,US" or "London,uk"."""
        if not self.api_key:
            raise ProviderUnavailable(self.unavailable_reason())

        session = self._session
        if session is None:
            import requests

            session = requests

        response = session.get(
            ENDPOINT,
            params={"q": entity_key, "appid": self.api_key, "units": "metric"},
            timeout=10,
        )

        status = getattr(response, "status_code", 200)
        if status == 401:
            raise LiveProviderError(
                "OpenWeather rejected the key (401). A newly issued key takes "
                "a couple of hours to activate; if it is older than that, "
                "check OPENWEATHER_API_KEY."
            )
        if status == 404:
            raise LiveProviderError(f"OpenWeather does not recognise {entity_key!r}")
        if status == 429:
            raise LiveProviderError("OpenWeather rate limit reached")
        if status >= 400:
            raise LiveProviderError(f"OpenWeather returned HTTP {status}")

        return self._normalise(response.json(), entity_key)

    @staticmethod
    def _normalise(raw: Dict[str, Any], entity_key: str) -> Dict[str, Any]:
        """Reduce the response to the fields Scout Fox reasons about.

        Storing the whole payload would mean the rest of the system depends on
        OpenWeather's shape, which defeats the point of the adapter.
        """
        weather = (raw.get("weather") or [{}])[0]
        main = raw.get("main") or {}
        wind = raw.get("wind") or {}

        code = int(weather.get("id", 800))
        temp_c = main.get("temp")

        return {
            "location": raw.get("name") or entity_key,
            "country": (raw.get("sys") or {}).get("country", ""),
            "condition": weather.get("main", ""),
            "description": weather.get("description", ""),
            "condition_code": code,
            "temp_c": temp_c,
            "feels_like_c": main.get("feels_like"),
            "humidity": main.get("humidity"),
            "wind_speed_ms": wind.get("speed"),
        }

    # --- the part the product actually uses --------------------------------

    def outdoor_verdict(self, entity_key: str, force: bool = False) -> Dict[str, Any]:
        """Should a family be outdoors here right now?

        Returns the recommendation plus the reason, because a bare yes/no that
        a user cannot sanity-check is worse than useless when it is wrong.
        """
        result = self.get(entity_key, force=force)
        payload = result.payload

        code = payload.get("condition_code", 800)
        temp = payload.get("feels_like_c")
        if temp is None:
            temp = payload.get("temp_c")

        reasons = []
        good = True

        if code // 100 in BAD_FOR_OUTDOORS:
            good = False
            reasons.append(payload.get("description") or "poor conditions")

        if isinstance(temp, (int, float)):
            if temp < COMFORTABLE_MIN_C:
                good = False
                reasons.append(f"feels like {round(temp)}°C — cold for young children")
            elif temp > COMFORTABLE_MAX_C:
                good = False
                reasons.append(f"feels like {round(temp)}°C — hot for young children")

        if good:
            reasons.append(payload.get("description") or "settled conditions")

        return {
            "location": payload.get("location"),
            "recommend": "outdoor" if good else "indoor",
            "good_for_outdoors": good,
            "because": "; ".join(reasons),
            "conditions": payload,
            # Provenance travels with the answer so the caller can decide how
            # much to lean on it.
            "freshness": {
                "provider": result.provider,
                "retrieved_at": result.retrieved_at,
                "age_seconds": round(result.age_seconds, 1),
                "stale": result.stale,
                "confidence": result.confidence,
            },
        }
