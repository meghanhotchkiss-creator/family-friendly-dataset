import os
from functools import lru_cache

import faiss
import pandas as pd
from sentence_transformers import SentenceTransformer

DEFAULT_DATA_SOURCE = "https://raw.githubusercontent.com/yourusername/family-friendly-dataset/main/data/processed/family_friendly_dataset.csv"
DATA_SOURCE = os.getenv("FAMILY_DATA_URL", DEFAULT_DATA_SOURCE)


@lru_cache(maxsize=1)
def load_dataset():
    try:
        return pd.read_csv(DATA_SOURCE)
    except FileNotFoundError as exc:
        raise FileNotFoundError(
            f"Dataset not found at '{DATA_SOURCE}'. "
            "Set the FAMILY_DATA_URL environment variable to a valid path or URL."
        ) from exc

model = SentenceTransformer("all-MiniLM-L6-v2")

df = load_dataset()
embeddings = model.encode(df["name"].fillna("").tolist(), convert_to_numpy=True)
index = faiss.IndexFlatL2(embeddings.shape[1])
index.add(embeddings)

def semantic_search(query, top_k=5):
    q_vec = model.encode([query], convert_to_numpy=True)
    distances, indices = index.search(q_vec, top_k)
    results = df.iloc[indices[0]].to_dict(orient="records")
    return results
