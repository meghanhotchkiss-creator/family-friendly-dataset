"""Provider framework for activity data.

Every source of activities -- the curated seed, the National Park Service,
Google Places, IMLS libraries -- is a provider that returns rows in one shared
schema. The rest of the system only ever sees that schema, so adding a source
is a new file here rather than a change to the API.

The previous pipeline (recovered from `family-friendly-dataset.zip` in git
history) had each script write its own column names: one produced `STATE`, the
API read `state`, and nothing produced `indoor_or_outdoor` at all. Normalising
and validating in one place is what stops that happening again.
"""
from __future__ import annotations

import re
import unicodedata
from abc import ABC, abstractmethod
from typing import Any, Dict, Iterable, List, Optional

# The canonical column order of data/processed/family_friendly_dataset.csv.
COLUMNS = (
    "id",
    "name",
    "state",
    "city",
    "type",
    "indoor_or_outdoor",
    "min_age",
    "max_age",
    "price_band",
    "url",
    "source",
    "verified",
)

REQUIRED = ("name", "state", "indoor_or_outdoor", "source")

INDOOR_VALUES = {"indoor", "outdoor", "both"}

PRICE_BANDS = {"free", "$", "$$", "$$$"}

TYPES = {
    "park",
    "museum",
    "zoo",
    "aquarium",
    "library",
    "playground",
    "science_center",
    "historic_site",
    "beach",
    "trail",
    "garden",
    "other",
}

US_STATES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI",
    "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
    "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
    "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
    "WV", "WI", "WY", "PR", "VI", "GU", "AS", "MP",
}


class ProviderError(RuntimeError):
    """A provider could not produce rows.

    The builder treats this as "skip this source and carry on", so one missing
    API key never blocks a dataset build.
    """


class RowValidationError(ValueError):
    """A provider returned a row that does not satisfy the schema."""


def slugify(value: str) -> str:
    """Reduce text to a lowercase ascii slug usable in an id."""
    normalised = unicodedata.normalize("NFKD", value)
    ascii_only = normalised.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "-", ascii_only.lower()).strip("-")


def make_id(source: str, name: str, state: str) -> str:
    """Build the stable de-duplication key for a row.

    Two providers describing the same place produce different ids (the source
    is part of the key) but the same `dedupe_key`, which is what the builder
    collapses on. Keeping the source in the id means a row can always be traced
    back to where it came from.
    """
    return f"{slugify(source)}:{slugify(state)}:{slugify(name)}"


def dedupe_key(row: Dict[str, Any]) -> str:
    """Identity of a place, independent of which provider reported it."""
    return f"{slugify(str(row.get('state', '')))}:{slugify(str(row.get('name', '')))}"


def _clean_age(value: Any, default: int) -> int:
    if value in (None, ""):
        return default
    try:
        age = int(value)
    except (TypeError, ValueError):
        return default
    return max(0, min(age, 99))


def normalise_row(row: Dict[str, Any], source: str) -> Dict[str, Any]:
    """Coerce one provider row into the canonical schema.

    Raises RowValidationError rather than silently writing a row the API cannot
    filter on -- a row missing `state` or `indoor_or_outdoor` is invisible to
    every query the API supports, so it is worse than absent.
    """
    name = str(row.get("name", "")).strip()
    if not name:
        raise RowValidationError(f"{source}: row has no name: {row!r}")

    state = str(row.get("state", "")).strip().upper()
    if state not in US_STATES:
        raise RowValidationError(f"{source}: {name!r} has unknown state {state!r}")

    indoor = str(row.get("indoor_or_outdoor", "")).strip().lower()
    if indoor not in INDOOR_VALUES:
        raise RowValidationError(
            f"{source}: {name!r} has indoor_or_outdoor={indoor!r}, "
            f"expected one of {sorted(INDOOR_VALUES)}"
        )

    place_type = str(row.get("type", "other")).strip().lower() or "other"
    if place_type not in TYPES:
        place_type = "other"

    price = str(row.get("price_band", "")).strip().lower()
    if price not in PRICE_BANDS:
        price = ""

    url = str(row.get("url", "")).strip()
    if url and not url.startswith(("http://", "https://")):
        url = ""

    min_age = _clean_age(row.get("min_age"), 0)
    max_age = _clean_age(row.get("max_age"), 99)
    if max_age < min_age:
        min_age, max_age = 0, 99

    verified = str(row.get("verified", "false")).strip().lower() in {"true", "1", "yes"}

    normalised = {
        "id": row.get("id") or make_id(source, name, state),
        "name": name,
        "state": state,
        "city": str(row.get("city", "")).strip(),
        "type": place_type,
        "indoor_or_outdoor": indoor,
        "min_age": min_age,
        "max_age": max_age,
        "price_band": price,
        "url": url,
        "source": source,
        "verified": "true" if verified else "false",
    }

    # Preserve any extra columns a provider supplies; /recommend returns whole
    # rows, so they reach clients for free.
    for key, value in row.items():
        if key not in normalised:
            normalised[key] = value

    return normalised


class ActivityProvider(ABC):
    """One source of activity rows."""

    #: Short machine name, written into every row's `source` column.
    name: str = "unnamed"

    #: Human description, shown by `build_dataset.py --list-sources`.
    description: str = ""

    def available(self) -> bool:
        """Whether this provider can run right now.

        Providers needing an API key override this to check for it, so the
        builder can skip them with a clear message instead of failing.
        """
        return True

    def unavailable_reason(self) -> str:
        return f"{self.name} is not available"

    @abstractmethod
    def fetch(self, states: Optional[Iterable[str]] = None) -> List[Dict[str, Any]]:
        """Return raw rows for the given states (all states when None)."""

    def rows(self, states: Optional[Iterable[str]] = None) -> List[Dict[str, Any]]:
        """Fetch, normalise, and validate. This is what the builder calls.

        A single bad row is dropped with a warning rather than losing the whole
        source; a provider that returns nothing usable raises.
        """
        raw = self.fetch(states)
        good: List[Dict[str, Any]] = []
        errors: List[str] = []

        for row in raw:
            try:
                good.append(normalise_row(row, self.name))
            except RowValidationError as exc:
                errors.append(str(exc))

        if errors and not good:
            raise ProviderError(
                f"{self.name}: every row failed validation. First: {errors[0]}"
            )

        for message in errors[:5]:
            print(f"  ! dropped row -- {message}")
        if len(errors) > 5:
            print(f"  ! {len(errors) - 5} further rows dropped")

        return good
