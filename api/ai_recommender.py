"""Semantic search over the family-friendly activity dataset.

The model, dataset and vector index are built on first use rather than at
import time. Doing this work at import meant that importing the module -- for a
test, a health check, or any other endpoint in the same process -- executed a
CSV read and downloaded a sentence-transformer model, and raised if the dataset
was absent. The dataset is not committed to this repository, so importing this
module always failed.
"""

from pathlib import Path
from threading import Lock
import os

DEFAULT_DATASET_PATH = Path(__file__).resolve().parents[1] / "data" / "processed" / "family_friendly_dataset.csv"
DATASET_URL = os.getenv("FAMILY_DATASET_URL", str(DEFAULT_DATASET_PATH))

# Columns this module needs. `name` is what gets embedded.
REQUIRED_COLUMNS = ("name",)

_lock = Lock()
_state = None


class DatasetUnavailable(RuntimeError):
    """Raised when the activity dataset cannot be loaded."""


def _build():
    """Load the dataset, embed it, and build the vector index."""
    import pandas as pd

    source = DATASET_URL
    is_remote = source.startswith(("http://", "https://"))

    if not is_remote and not Path(source).exists():
        raise DatasetUnavailable(
            f"Activity dataset not found at {source}. "
            "Set FAMILY_DATASET_URL to a readable CSV or place the file at that "
            "path. See data/README.md for the expected columns."
        )

    try:
        df = pd.read_csv(source)
    except Exception as exc:
        raise DatasetUnavailable(f"Could not read the activity dataset: {exc}") from exc

    missing = [column for column in REQUIRED_COLUMNS if column not in df.columns]
    if missing:
        raise DatasetUnavailable(
            f"Activity dataset is missing required column(s): {', '.join(missing)}. "
            "See data/README.md for the expected columns."
        )

    if df.empty:
        raise DatasetUnavailable("Activity dataset is empty; there is nothing to search.")

    # Imported here so that a caller who never runs a search does not pay the
    # cost of loading these libraries.
    from sentence_transformers import SentenceTransformer
    import faiss

    model = SentenceTransformer(os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2"))
    embeddings = model.encode(df["name"].fillna("").tolist(), convert_to_numpy=True)
    index = faiss.IndexFlatL2(embeddings.shape[1])
    index.add(embeddings)
    return model, df, index


def _get_state():
    global _state
    if _state is None:
        with _lock:
            if _state is None:
                _state = _build()
    return _state


def semantic_search(query, top_k=5):
    """Return the ``top_k`` activities most similar to ``query``."""
    model, df, index = _get_state()
    top_k = max(1, min(int(top_k), len(df)))
    q_vec = model.encode([query], convert_to_numpy=True)
    distances, indices = index.search(q_vec, top_k)
    return df.iloc[indices[0]].to_dict(orient="records")
