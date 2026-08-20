"""Tests for the live data layer.

The behaviours that matter here are the anti-hallucination ones: never invent
a forecast, never present expired data as current, and never let a provider
outage take out the endpoint.
"""
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
API_DIR = REPO_ROOT / "api"
for path in (str(REPO_ROOT), str(API_DIR)):
    if path not in sys.path:
        sys.path.insert(0, path)

from live.base import (  # noqa: E402
    DEFAULT_TTL,
    LiveCache,
    LiveProviderError,
    LiveResult,
    ProviderUnavailable,
)
from live.weather import OpenWeatherProvider  # noqa: E402


def sample(code=800, description="clear sky", temp=21.0, name="Austin"):
    return {
        "name": name,
        "sys": {"country": "US"},
        "weather": [{"id": code, "main": "Clear", "description": description}],
        "main": {"temp": temp, "feels_like": temp, "humidity": 50},
        "wind": {"speed": 3.1},
    }


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


class FakeSession:
    """Records calls so we can assert the cache actually prevents them."""

    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code
        self.calls = []

    def get(self, url, params=None, timeout=None):
        self.calls.append(params)
        return FakeResponse(self.payload, self.status_code)


def provider(payload=None, status=200, key="test-key"):
    return OpenWeatherProvider(
        api_key=key,
        session=FakeSession(payload if payload is not None else sample(), status),
        cache=LiveCache(),
    )


# --- configuration --------------------------------------------------------

def test_provider_without_a_key_is_unavailable():
    p = OpenWeatherProvider(api_key="", cache=LiveCache())
    assert not p.available()
    assert "OPENWEATHER_API_KEY" in p.unavailable_reason()


def test_unconfigured_provider_raises_rather_than_guessing():
    p = OpenWeatherProvider(api_key="", cache=LiveCache())
    with pytest.raises(ProviderUnavailable):
        p.get("Austin,TX,US")


def test_the_api_key_is_sent_and_never_appears_in_the_payload():
    p = provider()
    result = p.get("Austin,TX,US")
    assert p._session.calls[0]["appid"] == "test-key"
    assert "test-key" not in str(result.payload)


# --- normalisation --------------------------------------------------------

def test_response_is_reduced_to_our_own_shape():
    result = provider().get("Austin,TX,US")
    assert set(result.payload) == {
        "location", "country", "condition", "description", "condition_code",
        "temp_c", "feels_like_c", "humidity", "wind_speed_ms",
    }


# --- caching --------------------------------------------------------------

def test_second_call_is_served_from_cache():
    p = provider()
    p.get("Austin,TX,US")
    p.get("Austin,TX,US")
    assert len(p._session.calls) == 1, "cache did not prevent the second call"


def test_force_bypasses_the_cache():
    p = provider()
    p.get("Austin,TX,US")
    p.get("Austin,TX,US", force=True)
    assert len(p._session.calls) == 2


def test_expired_entry_triggers_a_refetch():
    p = provider()
    first = p.get("Austin,TX,US")
    # Reach into the cache and age the entry past its TTL.
    first.expires_at = time.time() - 1
    p.cache.put(first)
    p.get("Austin,TX,US")
    assert len(p._session.calls) == 2


def test_weather_ttl_is_short():
    """A long weather TTL would mean recommending a picnic during a storm."""
    assert DEFAULT_TTL["weather"] <= 900


def test_cache_keys_are_case_insensitive():
    p = provider()
    p.get("Austin,TX,US")
    p.get("austin,tx,us")
    assert len(p._session.calls) == 1


# --- failure behaviour ----------------------------------------------------

def test_a_401_explains_the_activation_delay():
    p = provider(status=401)
    with pytest.raises(LiveProviderError, match="couple of hours"):
        p.get("Austin,TX,US")


def test_unknown_place_is_reported_clearly():
    p = provider(status=404)
    with pytest.raises(LiveProviderError, match="does not recognise"):
        p.get("Nowheresville,ZZ")


def test_rate_limit_is_reported():
    p = provider(status=429)
    with pytest.raises(LiveProviderError, match="rate limit"):
        p.get("Austin,TX,US")


def test_outage_falls_back_to_cache_but_marks_it_stale():
    """The key anti-hallucination behaviour: old data is allowed, lying is not."""
    p = provider()
    fresh = p.get("Austin,TX,US")
    assert fresh.stale is False

    fresh.expires_at = time.time() - 1
    p.cache.put(fresh)
    p._session.status_code = 500

    stale = p.get("Austin,TX,US")
    assert stale.stale is True
    assert stale.confidence < fresh.confidence
    assert stale.payload == fresh.payload


def test_falling_back_does_not_corrupt_the_cached_entry():
    p = provider()
    original = p.get("Austin,TX,US")
    original.expires_at = time.time() - 1
    p.cache.put(original)
    p._session.status_code = 500
    p.get("Austin,TX,US")

    still_cached = p.cache.get("weather", "Austin,TX,US")
    assert still_cached.stale is False, "the cache entry itself was mutated"


def test_no_cache_and_an_outage_raises_rather_than_inventing():
    p = provider(status=500)
    with pytest.raises(LiveProviderError):
        p.get("Austin,TX,US")


# --- the product decision -------------------------------------------------

def test_clear_and_mild_recommends_outdoors():
    v = provider(sample(code=800, temp=21)).outdoor_verdict("Austin,TX,US")
    assert v["good_for_outdoors"] is True
    assert v["recommend"] == "outdoor"


@pytest.mark.parametrize("code,label", [(202, "thunderstorm"), (312, "drizzle"), (502, "rain"), (601, "snow")])
def test_wet_conditions_recommend_indoors(code, label):
    v = provider(sample(code=code, description=label)).outdoor_verdict("Austin,TX,US")
    assert v["good_for_outdoors"] is False
    assert v["recommend"] == "indoor"
    assert label in v["because"]


def test_freezing_recommends_indoors_for_young_children():
    v = provider(sample(code=800, temp=-4)).outdoor_verdict("Chicago,IL,US")
    assert v["good_for_outdoors"] is False
    assert "cold" in v["because"]


def test_extreme_heat_recommends_indoors():
    v = provider(sample(code=800, temp=38)).outdoor_verdict("Phoenix,AZ,US")
    assert v["good_for_outdoors"] is False
    assert "hot" in v["because"]


def test_verdict_always_explains_itself():
    v = provider().outdoor_verdict("Austin,TX,US")
    assert v["because"], "a verdict with no reason cannot be sanity-checked"


def test_verdict_carries_provenance():
    v = provider().outdoor_verdict("Austin,TX,US")
    freshness = v["freshness"]
    assert freshness["provider"] == "openweather"
    assert freshness["stale"] is False
    assert freshness["age_seconds"] < 5


def test_missing_temperature_does_not_crash_the_verdict():
    payload = sample()
    payload["main"] = {}
    v = provider(payload).outdoor_verdict("Austin,TX,US")
    assert v["recommend"] in {"indoor", "outdoor"}


# --- LiveResult -----------------------------------------------------------

def test_live_result_reports_expiry():
    now = time.time()
    r = LiveResult("p", "weather", "k", {}, retrieved_at=now, expires_at=now - 1)
    assert r.is_expired()
    assert not LiveResult("p", "weather", "k", {}, now, now + 60).is_expired()
