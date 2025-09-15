import os
from pathlib import Path

from sentence_transformers import SentenceTransformer
import faiss
import pandas as pd


def _resolve_data_source() -> str:
    """Return the configured dataset source as a path or URL."""
    configured_source = os.getenv("FAMILY_DATA_SOURCE") or os.getenv("FAMILY_DATA_URL")
    if configured_source:
        return configured_source

    default_path = Path(__file__).resolve().parents[1] / "data/processed/family_friendly_dataset.csv"
    return str(default_path)

model = SentenceTransformer("all-MiniLM-L6-v2")

df = pd.read_csv(_resolve_data_source())
embeddings = model.encode(df["name"].fillna("").tolist(), convert_to_numpy=True)
index = faiss.IndexFlatL2(embeddings.shape[1])
index.add(embeddings)

def semantic_search(query, top_k=5):
    q_vec = model.encode([query], convert_to_numpy=True)
    distances, indices = index.search(q_vec, top_k)
    results = df.iloc[indices[0]].to_dict(orient="records")
    return results
