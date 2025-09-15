from pathlib import Path
import os

from sentence_transformers import SentenceTransformer
import faiss
import pandas as pd


DEFAULT_DATASET_PATH = (
    Path(__file__).resolve().parents[1] / "data" / "processed" / "family_friendly_dataset.csv"
)
_DATASET_ENV_VAR = "FAMILY_DATASET_URL"

_model = None
_index = None
_df = None


def _initialize():
    """Lazily load the embedding model, dataset and FAISS index."""
    global _model, _index, _df

    if _model is not None:
        return

    dataset_location = os.getenv(_DATASET_ENV_VAR, str(DEFAULT_DATASET_PATH))

    try:
        _df = pd.read_csv(dataset_location)
    except Exception as exc:  # pragma: no cover - defensive, hard to trigger in tests
        raise RuntimeError(
            f"Failed to load dataset from {dataset_location}."
        ) from exc

    _model = SentenceTransformer("all-MiniLM-L6-v2")
    embeddings = _model.encode(_df["name"].fillna("").tolist(), convert_to_numpy=True)
    _index = faiss.IndexFlatL2(embeddings.shape[1])
    if len(embeddings):
        _index.add(embeddings)


def semantic_search(query, top_k=5):
    """Return the top-k most similar activities for a query."""
    if top_k <= 0:
        return []

    _initialize()

    if _index.ntotal == 0:
        return []

    query_vector = _model.encode([query], convert_to_numpy=True)
    k = min(top_k, _index.ntotal)
    _, indices = _index.search(query_vector, k)
    results = _df.iloc[indices[0]].to_dict(orient="records")
    return results
