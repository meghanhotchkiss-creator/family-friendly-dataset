"""Tests for the recommender: constraints, backends, and offline operation."""
import sys
from pathlib import Path

import pytest

API_DIR = str(Path(__file__).resolve().parents[1] / "api")
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

SEED = str(Path(__file__).resolve().parents[1] / "data" / "seed" / "family_friendly_seed.csv")


@pytest.fixture
def brain(monkeypatch):
    monkeypatch.setenv("FAMILY_DATASET_URL", SEED)
    monkeypatch.setenv("EMBEDDING_BACKEND", "hashing")
    import ai_recommender
    ai_recommender.DATASET_URL = SEED
    ai_recommender.reset()
    yield ai_recommender
    ai_recommender.reset()


# --- Offline operation ---------------------------------------------------

def test_module_imports_without_network_or_model():
    """Importing must not download weights or read the dataset."""
    sys.modules.pop("ai_recommender", None)
    import ai_recommender  # noqa: F401


def test_hashing_backend_is_deterministic(brain):
    first = [r["activity_id"] for r in brain.semantic_search("indoor museum", top_k=5)]
    brain.reset()
    second = [r["activity_id"] for r in brain.semantic_search("indoor museum", top_k=5)]
    assert first == second


def test_results_disclose_which_backend_ranked_them(brain):
    """A lexical match must not be mistakable for a semantic one."""
    result = brain.semantic_search("playground", top_k=1)[0]
    assert result["_match"]["backend"] == "hashing"
    assert result["_match"]["semantic"] is False


def test_unknown_backend_is_rejected(monkeypatch):
    monkeypatch.setenv("EMBEDDING_BACKEND", "nonsense")
    from embeddings import EmbeddingBackendUnavailable, get_embedder
    with pytest.raises(EmbeddingBackendUnavailable, match="Unknown EMBEDDING_BACKEND"):
        get_embedder()


# --- Constraints filter BEFORE ranking -----------------------------------

def test_constraint_cannot_be_overridden_by_a_strong_text_match(brain):
    """The core guarantee: similarity never reintroduces an excluded row."""
    results = brain.semantic_search(
        "indoor play centre", top_k=10, constraints={"setting": "outdoor"}
    )
    assert results, "expected outdoor activities to exist"
    assert {r["indoor_or_outdoor"] for r in results} == {"outdoor"}


def test_budget_constraint_excludes_everything_above_it(brain):
    results = brain.semantic_search("anything at all", top_k=20, constraints={"max_price": 0})
    assert results
    assert all(r["price_usd"] == 0 for r in results)


def test_age_constraint_respects_both_bounds(brain):
    results = brain.semantic_search("something fun", top_k=20, constraints={"suits_age": 3})
    assert results
    for r in results:
        assert r["min_age"] <= 3 <= r["max_age"]


def test_constraints_combine(brain):
    results = brain.semantic_search(
        "outside", top_k=20,
        constraints={"setting": "outdoor", "max_price": 0, "suits_age": 5},
    )
    for r in results:
        assert r["indoor_or_outdoor"] == "outdoor"
        assert r["price_usd"] == 0
        assert r["min_age"] <= 5 <= r["max_age"]


def test_unsatisfiable_constraints_return_nothing_not_a_near_miss(brain):
    results = brain.semantic_search("anything", constraints={"max_price": -1})
    assert results == []


def test_unknown_constraint_key_raises_rather_than_being_ignored(brain):
    """A typo must not silently widen the result set."""
    with pytest.raises(ValueError, match="Unknown constraint"):
        brain.semantic_search("x", constraints={"maxprice": 0})


def test_unknown_price_is_not_treated_as_free(brain, tmp_path, monkeypatch):
    """A row with no price cannot be shown to satisfy a budget."""
    csv = tmp_path / "gaps.csv"
    csv.write_text(
        "name,state,indoor_or_outdoor,price_usd\n"
        "Priced Park,FL,outdoor,0\n"
        "Unknown Price Park,FL,outdoor,\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("FAMILY_DATASET_URL", str(csv))
    brain.DATASET_URL = str(csv)
    brain.reset()
    names = [r["name"] for r in brain.semantic_search("park", top_k=10,
                                                      constraints={"max_price": 5})]
    assert "Priced Park" in names
    assert "Unknown Price Park" not in names


# --- Dataset handling ----------------------------------------------------

def test_missing_dataset_reports_the_path_it_tried(brain, monkeypatch):
    monkeypatch.setenv("FAMILY_DATASET_URL", "/nope/missing.csv")
    brain.DATASET_URL = "/nope/missing.csv"
    brain.reset()
    with pytest.raises(brain.DatasetUnavailable, match="/nope/missing.csv"):
        brain.semantic_search("anything")
