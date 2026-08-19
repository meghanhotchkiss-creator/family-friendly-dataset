"""Regression tests for the security fixes.

Each test corresponds to a defect that was demonstrated as exploitable against
the previous implementation.
"""
import importlib
import os
import sys
from pathlib import Path

import pytest

API_DIR = str(Path(__file__).resolve().parents[1] / "api")
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)


@pytest.fixture
def configured_env(monkeypatch):
    monkeypatch.setenv("FAMILY_API_KEY", "test-api-key")
    monkeypatch.setenv("JWT_SECRET", "test-jwt-secret")
    monkeypatch.delenv("USE_BIGQUERY", raising=False)
    return monkeypatch


# --- Secrets -------------------------------------------------------------

def test_server_refuses_to_start_without_api_key(monkeypatch):
    monkeypatch.delenv("FAMILY_API_KEY", raising=False)
    monkeypatch.setenv("JWT_SECRET", "x")
    sys.modules.pop("server", None)
    with pytest.raises(RuntimeError, match="FAMILY_API_KEY is not set"):
        importlib.import_module("server")


def test_server_refuses_to_start_without_jwt_secret(monkeypatch):
    monkeypatch.setenv("FAMILY_API_KEY", "x")
    monkeypatch.delenv("JWT_SECRET", raising=False)
    sys.modules.pop("server", None)
    with pytest.raises(RuntimeError, match="JWT_SECRET is not set"):
        importlib.import_module("server")


def test_no_default_credentials_remain_in_source():
    source = (Path(API_DIR) / "server.py").read_text()
    assert "supersecretkey" not in source
    assert "jwtsecret" not in source


# --- SQL injection -------------------------------------------------------

def test_bigquery_query_is_parameterised(configured_env, monkeypatch):
    """A malicious ?state= must travel as a bound parameter, not as SQL."""
    monkeypatch.setenv("USE_BIGQUERY", "true")
    monkeypatch.setenv("BQ_TABLE", "proj.ds.activities")

    captured = {}

    class FakeJob:
        def to_dataframe(self):
            import pandas as pd
            return pd.DataFrame([{"name": "x", "state": "FL"}])

    class FakeClient:
        def query(self, query, job_config=None):
            captured["query"] = query
            captured["params"] = job_config.query_parameters if job_config else []
            return FakeJob()

    class FakeBigQuery:
        Client = FakeClient

        class ScalarQueryParameter:
            def __init__(self, name, type_, value):
                self.name, self.type_, self.value = name, type_, value

        class QueryJobConfig:
            def __init__(self, query_parameters=None):
                self.query_parameters = query_parameters or []

    fake_module = type(sys)("google.cloud.bigquery")
    for attr in ("Client", "ScalarQueryParameter", "QueryJobConfig"):
        setattr(fake_module, attr, getattr(FakeBigQuery, attr))

    # `from google.cloud import bigquery` resolves by attribute on the parent
    # package, so the parents have to exist in sys.modules as well.
    fake_google = type(sys)("google")
    fake_cloud = type(sys)("google.cloud")
    fake_google.cloud = fake_cloud
    fake_cloud.bigquery = fake_module
    monkeypatch.setitem(sys.modules, "google", fake_google)
    monkeypatch.setitem(sys.modules, "google.cloud", fake_cloud)
    monkeypatch.setitem(sys.modules, "google.cloud.bigquery", fake_module)

    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    server.bq_client = FakeClient()

    attack = "FL' OR '1'='1"
    server.get_data(attack, "indoor'--", 10)

    assert attack not in captured["query"], "user input was interpolated into SQL"
    assert "OR '1'='1" not in captured["query"]
    assert "@state" in captured["query"]
    values = [p.value for p in captured["params"]]
    assert attack in values, "input should travel as a bound parameter"


# --- Tiered API keys -----------------------------------------------------

def test_demo_keys_are_not_active_by_default(monkeypatch):
    monkeypatch.delenv("API_KEY_TIERS", raising=False)
    monkeypatch.delenv("ALLOW_DEMO_KEYS", raising=False)
    sys.modules.pop("auth_tiers", None)
    auth_tiers = importlib.import_module("auth_tiers")
    assert auth_tiers.USER_TIERS == {}, "must be closed by default"


def test_demo_keys_absent_from_source_as_literals():
    source = (Path(API_DIR) / "auth_tiers.py").read_text()
    # They may appear only inside the explicitly opt-in dev branch.
    assert source.count("demo_business_key") <= 1


def test_tiers_load_from_environment(monkeypatch):
    monkeypatch.setenv("API_KEY_TIERS", '{"k-pro": "pro"}')
    sys.modules.pop("auth_tiers", None)
    auth_tiers = importlib.import_module("auth_tiers")
    assert auth_tiers.USER_TIERS == {"k-pro": "pro"}
    assert auth_tiers._lookup_tier("k-pro") == "pro"
    assert auth_tiers._lookup_tier("wrong") is None


def test_unknown_tier_in_config_is_rejected(monkeypatch):
    monkeypatch.setenv("API_KEY_TIERS", '{"k": "superadmin"}')
    sys.modules.pop("auth_tiers", None)
    with pytest.raises(RuntimeError, match="unknown tier"):
        importlib.import_module("auth_tiers")


# --- Points --------------------------------------------------------------

@pytest.fixture
def points(monkeypatch):
    monkeypatch.setenv("API_KEY_TIERS", '{"k-free": "free"}')
    sys.modules.pop("auth_tiers", None)
    sys.modules.pop("points", None)
    module = importlib.import_module("points")
    module.user_points.clear()
    module.user_history.clear()
    module.last_checkin.clear()
    return module


def test_leaderboard_never_returns_api_keys(points):
    points.user_points["k-free"] = 50
    rows = points.leaderboard(api_key="k-free")
    assert rows, "expected a leaderboard row"
    for row in rows:
        assert row["user"] != "k-free"
        assert row["user"].startswith("scout_")


def test_privileged_events_cannot_be_self_reported(points):
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        points.earn_points(event="upgrade_business", api_key="k-free")
    assert exc.value.status_code == 403
    assert points.user_points.get("k-free", 0) == 0


def test_unknown_event_is_rejected(points):
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        points.earn_points(event="not_a_real_event", api_key="k-free")
    assert exc.value.status_code == 400


def test_daily_checkin_cannot_be_replayed(points):
    from fastapi import HTTPException
    first = points.earn_points(event="daily_checkin", api_key="k-free")
    assert first["earned"] == 10
    with pytest.raises(HTTPException) as exc:
        points.earn_points(event="daily_checkin", api_key="k-free")
    assert exc.value.status_code == 409
    assert points.user_points["k-free"] == 10


def test_negative_redemption_cannot_mint_points(points):
    from fastapi import HTTPException
    points.user_points["k-free"] = 10
    with pytest.raises(HTTPException) as exc:
        points.redeem_points(cost=-500, api_key="k-free")
    assert exc.value.status_code == 400
    assert points.user_points["k-free"] == 10


def test_redemption_beyond_balance_is_rejected(points):
    from fastapi import HTTPException
    points.user_points["k-free"] = 10
    with pytest.raises(HTTPException):
        points.redeem_points(cost=11, api_key="k-free")
    assert points.user_points["k-free"] == 10
