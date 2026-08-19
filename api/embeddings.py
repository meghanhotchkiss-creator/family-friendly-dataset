"""Embedding backends for the recommender.

Two backends are provided, and which one is active matters a great deal for
result quality:

``sentence-transformers`` (default)
    Real semantic embeddings. Understands that "somewhere dry for a toddler"
    and "indoor play centre" are related without sharing words. Requires
    downloading model weights on first use, so it needs network access to the
    model host.

``hashing``
    A deterministic bag-of-words fallback with NO network dependency and no
    heavyweight libraries. It matches on shared words and character n-grams,
    NOT on meaning: it will not connect "rainy day" to "indoor" unless those
    words co-occur in the text.

    It exists so the pipeline can be run and tested in environments that
    cannot download model weights -- CI, air-gapped machines, contributor
    laptops. It is a development and test backend. Do NOT ship it as the
    production ranking path and do not evaluate recommendation quality
    against it.

Selected with the EMBEDDING_BACKEND environment variable.
"""

import hashlib
import os
import re

import numpy as np

DEFAULT_BACKEND = "sentence-transformers"
HASHING_DIMENSIONS = 512

_TOKEN = re.compile(r"[a-z0-9]+")


class EmbeddingBackendUnavailable(RuntimeError):
    """Raised when the requested backend cannot be initialised."""


class HashingEmbedder:
    """Deterministic lexical embedder. No network, no model download.

    Tokens and character trigrams are hashed into a fixed-width vector, which
    is then L2-normalised so that inner product equals cosine similarity.

    This captures lexical overlap only. It is not a semantic model.
    """

    semantic = False
    name = "hashing"

    def __init__(self, dimensions=HASHING_DIMENSIONS):
        self.dimensions = dimensions

    def _features(self, text):
        text = (text or "").lower()
        tokens = _TOKEN.findall(text)
        # Whole tokens carry most of the signal; trigrams add tolerance for
        # plurals and minor spelling differences.
        for token in tokens:
            yield token, 1.0
            padded = f" {token} "
            for i in range(len(padded) - 2):
                yield padded[i:i + 3], 0.3

    def encode(self, texts, convert_to_numpy=True):
        matrix = np.zeros((len(texts), self.dimensions), dtype="float32")
        for row, text in enumerate(texts):
            for feature, weight in self._features(text):
                digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
                bucket = int.from_bytes(digest, "big") % self.dimensions
                # Sign derived from the same digest keeps unrelated features
                # from systematically accumulating in the same direction.
                sign = 1.0 if digest[0] & 1 else -1.0
                matrix[row, bucket] += weight * sign
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return matrix / norms


class SentenceTransformerEmbedder:
    """Real semantic embeddings. Downloads model weights on first use."""

    semantic = True
    name = "sentence-transformers"

    def __init__(self, model_name):
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as exc:
            raise EmbeddingBackendUnavailable(
                "sentence-transformers is not installed. Install it, or set "
                "EMBEDDING_BACKEND=hashing to use the offline fallback "
                "(lexical matching only, not semantic)."
            ) from exc

        try:
            self._model = SentenceTransformer(model_name)
        except Exception as exc:
            raise EmbeddingBackendUnavailable(
                f"Could not load embedding model {model_name!r}: {exc}. This "
                "usually means the model weights could not be downloaded. Set "
                "EMBEDDING_BACKEND=hashing to run without network access "
                "(lexical matching only, not semantic)."
            ) from exc

    def encode(self, texts, convert_to_numpy=True):
        return self._model.encode(list(texts), convert_to_numpy=convert_to_numpy)


def get_embedder():
    """Return the configured embedding backend."""
    backend = os.getenv("EMBEDDING_BACKEND", DEFAULT_BACKEND).strip().lower()

    if backend == "hashing":
        return HashingEmbedder()

    if backend in ("sentence-transformers", "sentence_transformers", "st"):
        model_name = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
        return SentenceTransformerEmbedder(model_name)

    raise EmbeddingBackendUnavailable(
        f"Unknown EMBEDDING_BACKEND {backend!r}. "
        "Expected 'sentence-transformers' or 'hashing'."
    )


def build_index(embeddings):
    """Build a similarity index, using faiss when it is available.

    Falls back to brute-force numpy so the pipeline runs without faiss. The
    seed dataset is small enough that the difference is not observable; the
    fallback exists for portability, not performance.
    """
    try:
        import faiss
    except ImportError:
        return _NumpyIndex(embeddings)

    index = faiss.IndexFlatL2(embeddings.shape[1])
    index.add(embeddings)
    return index


class _NumpyIndex:
    """Brute-force nearest-neighbour search matching the faiss interface."""

    def __init__(self, embeddings):
        self._embeddings = embeddings

    def search(self, queries, top_k):
        # Squared euclidean distance, same ordering as faiss IndexFlatL2.
        diff = self._embeddings[None, :, :] - queries[:, None, :]
        distances = np.sum(diff * diff, axis=2)
        indices = np.argsort(distances, axis=1)[:, :top_k]
        gathered = np.take_along_axis(distances, indices, axis=1)
        return gathered, indices
