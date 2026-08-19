"""Tests for the activity data pipeline.

These cover the defects that left the API with no data at all: providers
writing inconsistent column names, rows missing the fields the API filters on,
and a build that silently produced an empty dataset.
"""
import csv
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from api.providers import REGISTRY, SeedProvider, dedupe_key, normalise_row  # noqa: E402
from api.providers.base import (  # noqa: E402
    COLUMNS,
    INDOOR_VALUES,
    ProviderError,
    RowValidationError,
    make_id,
)
from api.providers.nps import NPSProvider  # noqa: E402

DATASET = REPO_ROOT / "data" / "processed" / "family_friendly_dataset.csv"
SEED = REPO_ROOT / "data" / "seed" / "curated_activities.csv"


# --- the built dataset ----------------------------------------------------

def read_dataset():
    with DATASET.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def test_dataset_exists_and_is_not_empty():
    """The original failure: every endpoint read a file that was never there."""
    assert DATASET.exists(), f"{DATASET} is missing -- run scripts/build_dataset.py"
    assert read_dataset(), "dataset has no rows"


def test_dataset_has_the_columns_the_api_filters_on():
    rows = read_dataset()
    for column in ("name", "state", "indoor_or_outdoor"):
        assert column in rows[0], f"API filters on {column!r} but it is not a column"


def test_dataset_column_order_matches_schema():
    with DATASET.open(newline="", encoding="utf-8") as handle:
        header = next(csv.reader(handle))
    assert header[: len(COLUMNS)] == list(COLUMNS)


def test_every_row_is_filterable():
    """A row the API cannot filter on is invisible, which is worse than absent."""
    for row in read_dataset():
        assert row["name"].strip()
        assert len(row["state"]) == 2 and row["state"].isupper()
        assert row["indoor_or_outdoor"] in INDOOR_VALUES


def test_no_duplicate_places():
    seen = {}
    for row in read_dataset():
        key = dedupe_key(row)
        assert key not in seen, f"duplicate place: {row['name']} ({row['state']})"
        seen[key] = row


def test_ids_are_unique():
    ids = [row["id"] for row in read_dataset()]
    assert len(ids) == len(set(ids))


def test_urls_are_https_or_absent():
    for row in read_dataset():
        if row["url"]:
            assert row["url"].startswith("https://"), row["url"]


def test_seed_rows_are_marked_unverified():
    """Seed content has not been human-checked; the UI tells users so."""
    for row in read_dataset():
        if row["source"] == "seed_curated":
            assert row["verified"] == "false"


# --- normalisation --------------------------------------------------------

def test_normalise_uppercases_state_and_lowercases_indoor():
    row = normalise_row(
        {"name": "Test Park", "state": "ca", "indoor_or_outdoor": "OUTDOOR"}, "unit"
    )
    assert row["state"] == "CA"
    assert row["indoor_or_outdoor"] == "outdoor"


def test_normalise_rejects_a_row_with_no_state():
    with pytest.raises(RowValidationError):
        normalise_row({"name": "Nowhere", "indoor_or_outdoor": "indoor"}, "unit")


def test_normalise_rejects_an_unknown_state():
    with pytest.raises(RowValidationError):
        normalise_row(
            {"name": "Nowhere", "state": "XX", "indoor_or_outdoor": "indoor"}, "unit"
        )


def test_normalise_rejects_a_bad_indoor_value():
    """The old pipeline produced no indoor_or_outdoor column at all."""
    with pytest.raises(RowValidationError):
        normalise_row({"name": "X", "state": "CA", "indoor_or_outdoor": "maybe"}, "unit")


def test_normalise_drops_a_non_http_url():
    row = normalise_row(
        {
            "name": "X",
            "state": "CA",
            "indoor_or_outdoor": "indoor",
            "url": "javascript:alert(1)",
        },
        "unit",
    )
    assert row["url"] == ""


def test_normalise_repairs_an_inverted_age_range():
    row = normalise_row(
        {
            "name": "X",
            "state": "CA",
            "indoor_or_outdoor": "indoor",
            "min_age": 12,
            "max_age": 3,
        },
        "unit",
    )
    assert row["min_age"] == 0 and row["max_age"] == 99


def test_normalise_keeps_extra_columns():
    row = normalise_row(
        {"name": "X", "state": "CA", "indoor_or_outdoor": "indoor", "wheelchair": "yes"},
        "unit",
    )
    assert row["wheelchair"] == "yes"


def test_unknown_type_falls_back_to_other():
    row = normalise_row(
        {"name": "X", "state": "CA", "indoor_or_outdoor": "indoor", "type": "casino"},
        "unit",
    )
    assert row["type"] == "other"


def test_dedupe_key_ignores_source_but_id_does_not():
    a = {"name": "Balboa Park", "state": "CA"}
    b = {"name": "balboa  park", "state": "ca"}
    assert dedupe_key(a) == dedupe_key(b)
    assert make_id("seed_curated", "Balboa Park", "CA") != make_id("nps", "Balboa Park", "CA")


# --- providers ------------------------------------------------------------

def test_seed_provider_is_available_and_returns_rows():
    provider = SeedProvider()
    assert provider.available()
    rows = provider.rows()
    assert len(rows) > 50
    assert all(row["source"] == "seed_curated" for row in rows)


def test_seed_provider_filters_by_state():
    rows = SeedProvider().rows(states=["TX"])
    assert rows
    assert {row["state"] for row in rows} == {"TX"}


def test_seed_provider_raises_when_the_file_is_missing(tmp_path):
    provider = SeedProvider(path=tmp_path / "nope.csv")
    assert not provider.available()
    with pytest.raises(ProviderError):
        provider.rows()


def test_nps_provider_is_skipped_without_a_key():
    """A missing key must skip the source, never fail the build."""
    provider = NPSProvider(api_key="")
    assert not provider.available()
    assert "NPS_API_KEY" in provider.unavailable_reason()


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class FakeSession:
    """Stands in for `requests`, so the NPS mapping is tested without network."""

    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def get(self, url, params=None, timeout=None):
        self.calls.append(params)
        if len(self.calls) > 1:
            return FakeResponse({"data": [], "total": "0"})
        return FakeResponse(self.payload)


def test_nps_provider_maps_a_park_into_the_schema():
    session = FakeSession(
        {
            "total": "1",
            "data": [
                {
                    "fullName": "Yosemite National Park",
                    "states": "CA",
                    "designation": "National Park",
                    "url": "https://www.nps.gov/yose",
                    "addresses": [{"city": "Yosemite Valley"}],
                }
            ],
        }
    )

    rows = NPSProvider(api_key="test-key", session=session).rows(states=["CA"])

    assert len(rows) == 1
    row = rows[0]
    assert row["name"] == "Yosemite National Park"
    assert row["state"] == "CA"
    assert row["city"] == "Yosemite Valley"
    assert row["type"] == "park"
    assert row["source"] == "nps"
    assert row["verified"] == "true"


def test_nps_key_is_sent_and_a_multi_state_park_appears_in_each_state():
    session = FakeSession(
        {
            "total": "1",
            "data": [
                {
                    "fullName": "Great Smoky Mountains National Park",
                    "states": "TN,NC",
                    "designation": "National Park",
                    "url": "https://www.nps.gov/grsm",
                }
            ],
        }
    )

    rows = NPSProvider(api_key="secret", session=session).rows(states=["TN", "NC"])

    assert session.calls[0]["api_key"] == "secret"
    assert {row["state"] for row in rows} == {"TN", "NC"}


def test_every_registered_provider_declares_a_name_and_description():
    for name, provider in REGISTRY.items():
        assert provider.name == name
        assert provider.description, f"{name} has no description"
