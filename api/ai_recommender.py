from pathlib import Path
import os

from sentence_transformers import SentenceTransformer
import faiss
import pandas as pd

model = SentenceTransformer("all-MiniLM-L6-v2")

DEFAULT_DATASET_PATH = Path(__file__).resolve().parents[1] / "data" / "processed" / "family_friendly_dataset.csv"
DATASET_URL = os.getenv("FAMILY_DATASET_URL", str(DEFAULT_DATASET_PATH))

df = pd.read_csv(DATASET_URL)
embeddings = model.encode(df["name"].fillna("").tolist(), convert_to_numpy=True)
index = faiss.IndexFlatL2(embeddings.shape[1])
index.add(embeddings)

def semantic_search(query, top_k=5):
    q_vec = model.encode([query], convert_to_numpy=True)
    distances, indices = index.search(q_vec, top_k)
    results = df.iloc[indices[0]].to_dict(orient="records")
    return results
