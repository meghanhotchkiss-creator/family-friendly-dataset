import os

import faiss
import pandas as pd
from sentence_transformers import SentenceTransformer

DATASET_PATH_ENV_VAR = "FAMILY_FRIENDLY_DATASET_PATH"

_model = None
_df = None
_index = None


def _initialize():
    global _model, _df, _index
    if _model is not None and _df is not None and _index is not None:
        return

    dataset_path = os.environ.get(DATASET_PATH_ENV_VAR)
    if not dataset_path:
        raise RuntimeError(
            f"Environment variable {DATASET_PATH_ENV_VAR} must be set to the dataset CSV path."
        )

    _model = SentenceTransformer("all-MiniLM-L6-v2")
    _df = pd.read_csv(dataset_path)

    embeddings = _model.encode(
        _df["name"].fillna("").tolist(), convert_to_numpy=True
    )
    _index = faiss.IndexFlatL2(embeddings.shape[1])
    _index.add(embeddings)


def semantic_search(query, top_k=5):
    _initialize()

    q_vec = _model.encode([query], convert_to_numpy=True)
    distances, indices = _index.search(q_vec, top_k)
    results = _df.iloc[indices[0]].to_dict(orient="records")
    return results
