"""Semantic search over the seeded activity dataset.

The model, dataset and FAISS index are built lazily on the first search so
that importing this module is cheap and does not fail when the optional
sentence-transformers/faiss dependencies or the generated dataset are absent.
"""

from pathlib import Path
import os

DEFAULT_DATASET_PATH = Path(__file__).resolve().parents[1] / "data" / "processed" / "family_friendly_dataset.csv"
DATASET_URL = os.getenv("FAMILY_DATASET_URL", str(DEFAULT_DATASET_PATH))
MODEL_NAME = os.getenv("FAMILY_EMBEDDING_MODEL", "all-MiniLM-L6-v2")

# Fields blended into the text that gets embedded. Searching names alone misses
# queries like "somewhere indoors with dinosaurs", which the description and
# tags do answer.
EMBED_FIELDS = ("name", "type", "category", "city", "tags", "description")

_state = {}


def _build():
    """Load the model, dataset and index once, then memoise them."""
    if _state:
        return _state

    import faiss
    import pandas as pd
    from sentence_transformers import SentenceTransformer

    if not str(DATASET_URL).startswith(("http://", "https://")) and not Path(DATASET_URL).exists():
        raise FileNotFoundError(
            f"Dataset not found at {DATASET_URL}. "
            "Build it with: python scripts/build_dataset.py"
        )

    df = pd.read_csv(DATASET_URL)
    corpus = (
        df[[c for c in EMBED_FIELDS if c in df.columns]]
        .fillna("")
        .astype(str)
        .agg(". ".join, axis=1)
        .tolist()
    )

    model = SentenceTransformer(MODEL_NAME)
    embeddings = model.encode(corpus, convert_to_numpy=True)
    index = faiss.IndexFlatL2(embeddings.shape[1])
    index.add(embeddings)

    _state.update(model=model, df=df, index=index)
    return _state


def semantic_search(query, top_k=5):
    """Return the top_k activities most similar to `query`."""
    state = _build()
    q_vec = state["model"].encode([query], convert_to_numpy=True)
    distances, indices = state["index"].search(q_vec, top_k)
    results = state["df"].iloc[indices[0]].to_dict(orient="records")
    for result, distance in zip(results, distances[0]):
        result["score"] = float(distance)
    return results
