from sentence_transformers import SentenceTransformer
import faiss
import pandas as pd

model = SentenceTransformer("all-MiniLM-L6-v2")

df = pd.read_csv("data/processed/family_friendly_dataset.csv")
embeddings = model.encode(df["name"].fillna("").tolist(), convert_to_numpy=True)
index = faiss.IndexFlatL2(embeddings.shape[1])
index.add(embeddings)

def semantic_search(query, top_k=5):
    q_vec = model.encode([query], convert_to_numpy=True)
    distances, indices = index.search(q_vec, top_k)
    results = df.iloc[indices[0]].to_dict(orient="records")
    return results
