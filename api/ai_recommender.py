import os

from sentence_transformers import SentenceTransformer
import faiss
import pandas as pd


_DATASET_ENV_VAR = "FAMILY_FRIENDLY_DATASET_PATH"

_model = None
_index = None
_df = None


def _initialize():
    """Lazily load the model, dataset, and FAISS index."""
    global _model, _index, _df

    if _model is not None:
        return

    dataset_path = os.getenv(_DATASET_ENV_VAR)
    if not dataset_path:
        raise RuntimeError(
            f"Environment variable {_DATASET_ENV_VAR} must be set to the dataset CSV path."
        )

    if not os.path.exists(dataset_path):
        raise FileNotFoundError(
            f"Dataset file specified by {_DATASET_ENV_VAR} does not exist: {dataset_path}"
        )

    _model = SentenceTransformer("all-MiniLM-L6-v2")

    _df = pd.read_csv(dataset_path)
    embeddings = _model.encode(_df["name"].fillna("").tolist(), convert_to_numpy=True)
    _index = faiss.IndexFlatL2(embeddings.shape[1])
    _index.add(embeddings)


def semantic_search(query, top_k=5):
    _initialize()

    q_vec = _model.encode([query], convert_to_numpy=True)
    distances, indices = _index.search(q_vec, top_k)
    results = _df.iloc[indices[0]].to_dict(orient="records")
    return results
