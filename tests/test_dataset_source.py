"""Tests for how the dataset location is resolved and shared.

The server and the recommender must agree on where the data lives, and both
must take the answer from the environment at load time rather than from a
value frozen at import.
"""
import importlib
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
API_DIR = str(ROOT / "api")
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

import dataset  # noqa: E402


# --- Resolution ----------------------------------------------------------

def test_environment_variable_wins(monkeypatch):
    monkeypatch.setenv("FAMILY_DATASET_URL", "/srv/activities.csv")
    assert dataset.dataset_source() == "/srv/activities.csv"


def test_default_is_a_path_inside_the_checkout(monkeypatch):
    monkeypatch.delenv("FAMILY_DATASET_URL", raising=False)
    source = dataset.dataset_source()
    assert source == str(dataset.DEFAULT_DATASET_PATH)
    assert Path(source) == ROOT / "data" / "processed" / "family_friendly_dataset.csv"


def test_blank_variable_falls_back_rather_than_reading_a_file_named_nothing(monkeypatch):
    """An unset variable and one set to '' are the same misconfiguration."""
    for blank in ("", "   ", "\t"):
        monkeypatch.setenv("FAMILY_DATASET_URL", blank)
        assert dataset.dataset_source() == str(dataset.DEFAULT_DATASET_PATH)


def test_surrounding_whitespace_is_stripped(monkeypatch):
    monkeypatch.setenv("FAMILY_DATASET_URL", "  /srv/activities.csv\n")
    assert dataset.dataset_source() == "/srv/activities.csv"


def test_http_sources_are_recognised_as_remote():
    assert dataset.is_remote("https://example.org/activities.csv")
    assert dataset.is_remote("http://example.org/activities.csv")
    assert not dataset.is_remote("/srv/activities.csv")
    assert not dataset.is_remote(dataset.DEFAULT_DATASET_PATH)


def test_the_server_and_the_recommender_resolve_the_same_location(monkeypatch, tmp_path):
    """One dataset, one answer -- not two modules deriving it separately."""
    csv = tmp_path / "shared.csv"
    csv.write_text("name,state,indoor_or_outdoor\nA Park,FL,outdoor\n", encoding="utf-8")
    monkeypatch.setenv("FAMILY_DATASET_URL", str(csv))
    monkeypatch.setenv("FAMILY_API_KEY", "k")
    monkeypatch.setenv("JWT_SECRET", "s")
    monkeypatch.delenv("USE_BIGQUERY", raising=False)
    monkeypatch.setenv("EMBEDDING_BACKEND", "hashing")

    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    import ai_recommender
    ai_recommender.reset()

    assert server.load_dataset()["name"].tolist() == ["A Park"]
    assert ai_recommender.backend_info()["dataset"] == str(csv)
    ai_recommender.reset()


def test_server_follows_the_variable_without_being_reimported(monkeypatch, tmp_path):
    """Moving the data is deployment config, not a reason to restart imports."""
    first = tmp_path / "first.csv"
    first.write_text("name,state,indoor_or_outdoor\nFirst Park,FL,outdoor\n", encoding="utf-8")
    second = tmp_path / "second.csv"
    second.write_text("name,state,indoor_or_outdoor\nSecond Park,FL,outdoor\n", encoding="utf-8")

    monkeypatch.setenv("FAMILY_API_KEY", "k")
    monkeypatch.setenv("JWT_SECRET", "s")
    monkeypatch.setenv("FAMILY_DATASET_URL", str(first))
    monkeypatch.delenv("USE_BIGQUERY", raising=False)

    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    assert server.load_dataset()["name"].tolist() == ["First Park"]

    monkeypatch.setenv("FAMILY_DATASET_URL", str(second))
    assert server.load_dataset()["name"].tolist() == ["Second Park"]


def test_server_reports_a_missing_dataset_without_leaking_the_path(monkeypatch, tmp_path):
    from fastapi import HTTPException

    monkeypatch.setenv("FAMILY_API_KEY", "k")
    monkeypatch.setenv("JWT_SECRET", "s")
    monkeypatch.setenv("FAMILY_DATASET_URL", str(tmp_path / "absent.csv"))
    monkeypatch.delenv("USE_BIGQUERY", raising=False)

    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    with pytest.raises(HTTPException) as exc:
        server.load_dataset()
    assert exc.value.status_code == 500
    assert "absent.csv" not in str(exc.value.detail)


# --- Reading -------------------------------------------------------------

def test_missing_local_file_names_the_path_and_the_variable(tmp_path):
    missing = tmp_path / "absent.csv"
    with pytest.raises(dataset.DatasetUnavailable) as exc:
        dataset.read_dataset(str(missing))
    assert str(missing) in str(exc.value)
    assert "FAMILY_DATASET_URL" in str(exc.value)


def test_unreadable_csv_is_reported_as_unavailable(tmp_path):
    broken = tmp_path / "broken.csv"
    broken.write_text('name,state\n"unterminated,FL\n', encoding="utf-8")
    with pytest.raises(dataset.DatasetUnavailable, match=str(broken)):
        dataset.read_dataset(str(broken))


def test_read_dataset_defaults_to_the_configured_source(monkeypatch, tmp_path):
    csv = tmp_path / "activities.csv"
    csv.write_text("name,state\nA Park,FL\n", encoding="utf-8")
    monkeypatch.setenv("FAMILY_DATASET_URL", str(csv))
    assert dataset.read_dataset()["name"].tolist() == ["A Park"]
