"""Google Places provider.

Enrichment for the places public data does not cover -- indoor play centres,
children's cafes, trampoline parks. This is the expensive source: it bills per
request, and its terms restrict how long results may be cached and what may be
stored. Read those terms before turning it on at volume.

Set GOOGLE_PLACES_API_KEY to enable it. Restrict the key by IP or referrer and
set a quota cap in the Google Cloud console before it goes anywhere near
production.
"""
from __future__ import annotations

import os
from typing import Any, Dict, Iterable, List, Optional

from .base import ActivityProvider, ProviderError, US_STATES

TEXT_SEARCH = "https://places.googleapis.com/v1/places:searchText"

# Google place types mapped to ours. Anything unmapped becomes "other".
TYPE_MAP = {
    "amusement_park": "park",
    "aquarium": "aquarium",
    "art_gallery": "museum",
    "botanical_garden": "garden",
    "childrens_camp": "other",
    "hiking_area": "trail",
    "historical_place": "historic_site",
    "library": "library",
    "museum": "museum",
    "national_park": "park",
    "park": "park",
    "playground": "playground",
    "state_park": "park",
    "tourist_attraction": "other",
    "water_park": "park",
    "zoo": "zoo",
}

# Google price levels to our bands.
PRICE_MAP = {
    "PRICE_LEVEL_FREE": "free",
    "PRICE_LEVEL_INEXPENSIVE": "$",
    "PRICE_LEVEL_MODERATE": "$$",
    "PRICE_LEVEL_EXPENSIVE": "$$$",
    "PRICE_LEVEL_VERY_EXPENSIVE": "$$$",
}

# Types we treat as indoor when Google does not tell us.
INDOOR_TYPES = {"museum", "aquarium", "library", "science_center"}

FIELD_MASK = ",".join(
    [
        "places.displayName",
        "places.formattedAddress",
        "places.types",
        "places.priceLevel",
        "places.websiteUri",
        "places.primaryType",
    ]
)


class PlacesProvider(ActivityProvider):
    name = "places"
    description = "Google Places text search. Billed per request; needs a quota cap."

    def __init__(self, api_key: Optional[str] = None, session=None, queries=None):
        self.api_key = (
            api_key if api_key is not None else os.getenv("GOOGLE_PLACES_API_KEY", "")
        )
        self._session = session
        self.queries = queries or [
            "indoor play centre for kids",
            "children's museum",
            "family friendly attraction",
        ]

    def available(self) -> bool:
        return bool(self.api_key)

    def unavailable_reason(self) -> str:
        return "GOOGLE_PLACES_API_KEY is not set"

    def _post(self, body: Dict[str, Any]) -> Dict[str, Any]:
        session = self._session
        if session is None:
            import requests

            session = requests

        response = session.post(
            TEXT_SEARCH,
            json=body,
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": self.api_key,
                "X-Goog-FieldMask": FIELD_MASK,
            },
            timeout=20,
        )
        response.raise_for_status()
        return response.json()

    def fetch(self, states: Optional[Iterable[str]] = None) -> List[Dict[str, Any]]:
        if not self.api_key:
            raise ProviderError(self.unavailable_reason())

        codes = sorted({s.strip().upper() for s in states}) if states else []
        if not codes:
            raise ProviderError(
                "places requires an explicit state list -- a nationwide sweep "
                "would be a very large bill. Pass --states."
            )

        rows: List[Dict[str, Any]] = []

        for code in codes:
            for query in self.queries:
                payload = self._post({"textQuery": f"{query} in {code}, USA"})
                for place in payload.get("places", []):
                    row = self._to_row(place, code)
                    if row:
                        rows.append(row)

        if not rows:
            raise ProviderError("Places returned no results for the requested states")

        return rows

    def _to_row(self, place: Dict[str, Any], state: str) -> Optional[Dict[str, Any]]:
        name = (place.get("displayName") or {}).get("text", "").strip()
        if not name:
            return None

        google_types = place.get("types") or []
        primary = place.get("primaryType") or ""
        place_type = TYPE_MAP.get(primary, "other")
        if place_type == "other":
            for candidate in google_types:
                if candidate in TYPE_MAP:
                    place_type = TYPE_MAP[candidate]
                    break

        return {
            "name": name,
            "state": state,
            "city": self._city(place.get("formattedAddress", "")),
            "type": place_type,
            "indoor_or_outdoor": "indoor" if place_type in INDOOR_TYPES else "both",
            "min_age": 0,
            "max_age": 99,
            "price_band": PRICE_MAP.get(place.get("priceLevel", ""), ""),
            "url": place.get("websiteUri", ""),
            # Machine-classified from a commercial listing: a human has not
            # judged whether it is actually suitable for children.
            "verified": "false",
        }

    @staticmethod
    def _city(formatted_address: str) -> str:
        # "123 Main St, Austin, TX 78701, USA" -> "Austin"
        parts = [part.strip() for part in formatted_address.split(",")]
        return parts[1] if len(parts) >= 3 else ""
