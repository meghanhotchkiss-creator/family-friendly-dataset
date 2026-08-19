"""Tests for the API surface.

The regression that matters most here: /points/* routes existed in the source
from the first commit but were never mounted, so every call the web widgets
made returned 404 in production.
"""
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
API_DIR = REPO_ROOT / "api"
for path in (str(REPO_ROOT), str(API_DIR)):
    if path not in sys.path:
        sys.path.insert(0, path)

fastapi_testclient = pytest.importorskip("fastapi.testclient")

API_KEY = "test-api-key"


@pytest.fixture(scope="module")
def client():
    import os

    os.environ.setdefault("FAMILY_API_KEY", API_KEY)
    os.environ.setdefault("JWT_SECRET", "test-jwt-secret")
    os.environ.pop("USE_BIGQUERY", None)

    import server

    return fastapi_testclient.TestClient(server.app)


@pytest.fixture
def auth():
    return {"X-API-Key": API_KEY}


# --- routes are actually mounted -----------------------------------------

POINTS_PATHS = [
    "/points/earn_points",
    "/points/book_activity",
    "/points/points_balance",
    "/points/points_history",
    "/points/redeem_points",
    "/points/leaderboard",
]


@pytest.mark.parametrize("path", POINTS_PATHS)
def test_points_routes_are_mounted(client, path):
    """Each of these was a 404 before the routers were included."""
    assert path in client.app.openapi()["paths"], f"{path} is not mounted"


def test_points_route_answers_rather_than_404ing(client):
    response = client.get("/points/points_balance", headers={"X-API-Key": "demo_pro_key"})
    assert response.status_code != 404


def test_healthz_needs_no_credentials_and_no_dataset(client):
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


# --- recommendations ------------------------------------------------------

def test_recommend_returns_real_rows(client, auth):
    response = client.get("/recommend", params={"state": "CA", "limit": 5}, headers=auth)
    assert response.status_code == 200

    rows = response.json()
    assert rows, "no rows returned -- is the dataset built?"
    assert len(rows) <= 5
    assert all(row["state"] == "CA" for row in rows)
    assert all(row["name"] for row in rows)


def test_recommend_is_case_insensitive_on_state(client, auth):
    lower = client.get("/recommend", params={"state": "ca"}, headers=auth).json()
    upper = client.get("/recommend", params={"state": "CA"}, headers=auth).json()
    assert [r["id"] for r in lower] == [r["id"] for r in upper]


def test_recommend_filters_indoor(client, auth):
    rows = client.get(
        "/recommend", params={"state": "TX", "indoor": "indoor", "limit": 20}, headers=auth
    ).json()
    assert rows
    assert {row["indoor_or_outdoor"] for row in rows} == {"indoor"}


def test_recommend_respects_limit(client, auth):
    rows = client.get("/recommend", params={"state": "CA", "limit": 2}, headers=auth).json()
    assert len(rows) == 2


def test_recommend_rejects_a_missing_key(client):
    assert client.get("/recommend", params={"state": "CA"}).status_code == 401


def test_recommend_rejects_a_wrong_key(client):
    response = client.get(
        "/recommend", params={"state": "CA"}, headers={"X-API-Key": "not-the-key"}
    )
    assert response.status_code == 401


def test_unknown_state_returns_an_empty_list_not_an_error(client, auth):
    response = client.get("/recommend", params={"state": "ZZ"}, headers=auth)
    assert response.status_code == 200
    assert response.json() == []


# --- meta and search ------------------------------------------------------

def test_meta_reports_what_the_dataset_holds(client, auth):
    payload = client.get("/meta", headers=auth).json()
    assert payload["rows"] > 0
    assert "CA" in payload["states"]
    assert set(payload["indoor_or_outdoor"]) <= {"indoor", "outdoor", "both"}


def test_meta_requires_a_key(client):
    assert client.get("/meta").status_code == 401


def test_search_finds_by_name(client, auth):
    payload = client.get("/search", params={"q": "aquarium", "limit": 5}, headers=auth).json()
    assert payload["results"]
    assert any("aquarium" in row["name"].lower() for row in payload["results"])


def test_search_for_nonsense_returns_no_results_not_an_error(client, auth):
    response = client.get("/search", params={"q": "zzzzznotathing"}, headers=auth)
    assert response.status_code == 200
    assert response.json()["results"] == []


def test_search_limit_is_capped(client, auth):
    """An uncapped limit is an easy way to make the API do unbounded work."""
    assert client.get("/search", params={"q": "a", "limit": 5000}, headers=auth).status_code == 422


def test_search_requires_a_key(client):
    assert client.get("/search", params={"q": "zoo"}).status_code == 401
