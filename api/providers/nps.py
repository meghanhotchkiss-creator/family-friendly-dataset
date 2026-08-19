"""National Park Service provider.

The first live source worth wiring: the data is free, the key is free and
issued instantly at https://developer.nps.gov/get-started/, the content is
genuinely family-relevant, and there is no redistribution fight of the kind
Google Places and Yelp bring.

Set NPS_API_KEY to enable it.
"""
from __future__ import annotations

import os
from typing import Any, Dict, Iterable, List, Optional

from .base import ActivityProvider, ProviderError, US_STATES

NPS_ENDPOINT = "https://developer.nps.gov/api/v1/parks"

# NPS designations that make sense to show a family, mapped to our `type`.
DESIGNATION_TYPES = {
    "national park": "park",
    "national monument": "historic_site",
    "national historic site": "historic_site",
    "national historical park": "historic_site",
    "national seashore": "beach",
    "national lakeshore": "beach",
    "national recreation area": "park",
    "national preserve": "park",
    "national battlefield": "historic_site",
    "national memorial": "historic_site",
    "national scenic trail": "trail",
    "national river": "park",
}

# Page size the NPS API accepts per request.
PAGE_LIMIT = 50


class NPSProvider(ActivityProvider):
    name = "nps"
    description = "US National Park Service. Free key from developer.nps.gov."

    def __init__(self, api_key: Optional[str] = None, session=None):
        self.api_key = api_key if api_key is not None else os.getenv("NPS_API_KEY", "")
        self._session = session

    def available(self) -> bool:
        return bool(self.api_key)

    def unavailable_reason(self) -> str:
        return "NPS_API_KEY is not set (free key: https://developer.nps.gov/get-started/)"

    def _get(self, params: Dict[str, Any]) -> Dict[str, Any]:
        session = self._session
        if session is None:
            import requests  # imported lazily so the module loads without it

            session = requests

        response = session.get(NPS_ENDPOINT, params=params, timeout=20)
        response.raise_for_status()
        return response.json()

    def fetch(self, states: Optional[Iterable[str]] = None) -> List[Dict[str, Any]]:
        if not self.api_key:
            raise ProviderError(self.unavailable_reason())

        codes = sorted({s.strip().upper() for s in states}) if states else sorted(US_STATES)
        rows: List[Dict[str, Any]] = []

        # The API accepts a comma-separated stateCode list; chunk it so the
        # query string stays reasonable and one bad state cannot fail the lot.
        for chunk_start in range(0, len(codes), 10):
            chunk = codes[chunk_start : chunk_start + 10]
            start = 0

            while True:
                payload = self._get(
                    {
                        "stateCode": ",".join(chunk),
                        "limit": PAGE_LIMIT,
                        "start": start,
                        "api_key": self.api_key,
                    }
                )

                data = payload.get("data", [])
                if not data:
                    break

                rows.extend(self._to_rows(data))

                start += PAGE_LIMIT
                if start >= int(payload.get("total", 0)):
                    break

        if not rows:
            raise ProviderError("NPS returned no parks for the requested states")

        return rows

    def _to_rows(self, parks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        rows: List[Dict[str, Any]] = []

        for park in parks:
            # A park can span several states; emit one row per state so that
            # filtering by ?state= finds it in each.
            state_codes = [
                code.strip().upper()
                for code in str(park.get("states", "")).split(",")
                if code.strip().upper() in US_STATES
            ]

            designation = str(park.get("designation", "")).strip().lower()
            place_type = DESIGNATION_TYPES.get(designation, "park")

            for code in state_codes:
                rows.append(
                    {
                        "name": park.get("fullName") or park.get("name", ""),
                        "state": code,
                        "city": self._city(park),
                        "type": place_type,
                        # NPS units are outdoor destinations; most also have an
                        # indoor visitor centre, so "both" is the honest value.
                        "indoor_or_outdoor": "both",
                        "min_age": 0,
                        "max_age": 99,
                        # Entrance fees vary per unit and change; the NPS site
                        # is the source of truth, so no band is asserted here.
                        "price_band": "",
                        "url": park.get("url", ""),
                        # Live from the NPS API, so trustworthy as fetched.
                        "verified": "true",
                    }
                )

        return rows

    @staticmethod
    def _city(park: Dict[str, Any]) -> str:
        addresses = park.get("addresses") or []
        for address in addresses:
            city = str(address.get("city", "")).strip()
            if city:
                return city
        return ""
