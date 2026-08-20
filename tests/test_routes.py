"""The API serves the endpoints its clients call.

The widgets in widgets/ and the mobile app call these paths. Before this file
existed, points and payments were written, unit-tested and never mounted: every
one of those calls returned 404 in production while the suite stayed green.
These tests assert against the app the server actually builds.
"""

import importlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))


@pytest.fixture
def app(monkeypatch):
    monkeypatch.setenv("FAMILY_API_KEY", "test-key")
    monkeypatch.setenv("JWT_SECRET", "test-secret")
    for module in ("server", "points", "auth_tiers", "seed_loader"):
        sys.modules.pop(module, None)
    return importlib.import_module("server").app


def served(app):
    from fastapi.testclient import TestClient

    return set(TestClient(app).get("/openapi.json").json()["paths"])


# The paths widgets/ScoutFoxWidget.js and widgets/LeaderboardWidget.js request.
WIDGET_PATHS = {
    "/points/points_balance",
    "/points/points_history",
    "/points/leaderboard",
    "/points/book_activity",
    "/recommend",
}


def test_every_path_the_widgets_call_is_served(app):
    missing = WIDGET_PATHS - served(app)
    assert not missing, f"widgets call these, but the app does not serve them: {sorted(missing)}"


def test_points_router_is_mounted_under_its_prefix(app):
    assert any(p.startswith("/points/") for p in served(app))


def test_health_is_reachable_without_a_credential(app):
    from fastapi.testclient import TestClient

    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json()["status"] in {"ok", "degraded"}


def test_health_does_not_disclose_the_dataset_path(app):
    from fastapi.testclient import TestClient

    body = TestClient(app).get("/health").text
    assert "/data/" not in body and "\\data\\" not in body


def test_non_ascii_api_key_is_rejected_not_a_server_error(app):
    """A latin-1 key reaching compare_digest raised TypeError, so an
    unauthenticated caller could produce 500s at will."""
    from fastapi.testclient import TestClient

    response = TestClient(app).get(
        "/recommend?state=CA", headers={"X-API-Key": "ké".encode("latin-1")}
    )
    assert response.status_code == 401
