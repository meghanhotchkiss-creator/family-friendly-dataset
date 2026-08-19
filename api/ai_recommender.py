"""Semantic search over the family-friendly activity dataset.

The model, dataset and vector index are built on first use rather than at
import time. Doing this work at import meant that importing the module -- for a
test, a health check, or any other endpoint in the same process -- executed a
CSV read and downloaded a sentence-transformer model, and raised if either was
unavailable.

The embedding backend is pluggable (see embeddings.py). The default is a real
semantic model; an offline lexical fallback exists so the pipeline can be run
and tested without downloading model weights. Results report which backend
produced them, because the two are not equivalent in quality.
"""

from pathlib import Path
from threading import Lock
import os

from embeddings import EmbeddingBackendUnavailable, build_index, get_embedder

DEFAULT_DATASET_PATH = Path(__file__).resolve().parents[1] / "data" / "processed" / "family_friendly_dataset.csv"
DATASET_URL = os.getenv("FAMILY_DATASET_URL", str(DEFAULT_DATASET_PATH))

# Columns this module needs. `name` is what gets embedded.
REQUIRED_COLUMNS = ("name",)

# Additional columns folded into the embedded text when present. More context
# gives the embedder more to match against -- a row that mentions "indoor" and
# "children's museum" is reachable from more queries than a bare name.
DESCRIPTIVE_COLUMNS = ("category", "indoor_or_outdoor", "city", "state", "description")

_lock = Lock()
_state = None


class DatasetUnavailable(RuntimeError):
    """Raised when the activity dataset cannot be loaded."""


def _embeddable_text(row):
    """Build the text embedded for one activity."""
    parts = [str(row["name"])]
    for column in DESCRIPTIVE_COLUMNS:
        value = row.get(column)
        if value is not None and str(value).strip() and str(value).lower() != "nan":
            parts.append(str(value))
    return " ".join(parts)


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

    embedder = get_embedder()
    texts = [_embeddable_text(row) for _, row in df.iterrows()]
    embeddings = embedder.encode(texts, convert_to_numpy=True)
    index = build_index(embeddings)
    return embedder, df, index


def _get_state():
    global _state
    if _state is None:
        with _lock:
            if _state is None:
                _state = _build()
    return _state


def reset():
    """Drop cached state so the next search rebuilds. Used by tests."""
    global _state
    with _lock:
        _state = None


def backend_info():
    """Describe the active backend without running a search."""
    embedder, df, _ = _get_state()
    return {
        "backend": embedder.name,
        "semantic": embedder.semantic,
        "activities_indexed": len(df),
        "dataset": DATASET_URL,
    }


def apply_constraints(df, constraints):
    """Filter a frame down to rows satisfying every hard constraint.

    Constraints are filters applied BEFORE ranking, never scoring signals. A
    similarity score must not be able to reintroduce a row that a constraint
    excluded: "free" returning a $27 venue because the text matched well is the
    failure this prevents.

    Unrecognised constraint keys raise rather than being ignored, so a typo
    cannot silently widen the result set.
    """
    if not constraints:
        return df

    known = {"max_price", "setting", "suits_age"}
    unknown = set(constraints) - known
    if unknown:
        raise ValueError(
            f"Unknown constraint(s): {', '.join(sorted(unknown))}. "
            f"Expected any of: {', '.join(sorted(known))}"
        )

    filtered = df

    max_price = constraints.get("max_price")
    if max_price is not None:
        if "price_usd" not in filtered.columns:
            raise ValueError("max_price requires a price_usd column in the dataset")
        prices = filtered["price_usd"]
        # A row with an unknown price cannot be shown to satisfy a budget, so
        # it is excluded rather than assumed free.
        filtered = filtered[prices.notna() & (prices <= float(max_price))]

    setting = constraints.get("setting")
    if setting is not None:
        if "indoor_or_outdoor" not in filtered.columns:
            raise ValueError("setting requires an indoor_or_outdoor column in the dataset")
        filtered = filtered[
            filtered["indoor_or_outdoor"].astype(str).str.lower() == str(setting).lower()
        ]

    suits_age = constraints.get("suits_age")
    if suits_age is not None:
        for column in ("min_age", "max_age"):
            if column not in filtered.columns:
                raise ValueError(f"suits_age requires a {column} column in the dataset")
        age = float(suits_age)
        filtered = filtered[
            filtered["min_age"].notna()
            & filtered["max_age"].notna()
            & (filtered["min_age"] <= age)
            & (filtered["max_age"] >= age)
        ]

    return filtered


def semantic_search(query, top_k=5, constraints=None):
    """Return the ``top_k`` activities most similar to ``query``.

    ``constraints`` are hard filters applied before ranking (see
    ``apply_constraints``). Ranking happens only among rows that already
    satisfy them, so a strong similarity score can never reintroduce a row a
    constraint excluded.

    Each result carries the backend that produced it. A caller must be able to
    tell a semantic match from a lexical one, because the fallback backend does
    not understand meaning.
    """
    embedder, df, index = _get_state()

    if constraints:
        eligible = apply_constraints(df, constraints).reset_index(drop=True)
        if eligible.empty:
            return []
        # Constraints change which rows are eligible, so the index built over
        # the whole dataset cannot be reused. The eligible subset is
        # re-embedded. If this becomes slow on a larger dataset, build indexes
        # per constraint bucket -- do not demote the constraint to a scoring
        # signal to avoid the cost.
        texts = [_embeddable_text(row) for _, row in eligible.iterrows()]
        subset_index = build_index(embedder.encode(texts, convert_to_numpy=True))
        frame, search_index = eligible, subset_index
    else:
        frame, search_index = df, index

    top_k = max(1, min(int(top_k), len(frame)))
    query_vector = embedder.encode([query], convert_to_numpy=True)
    distances, indices = search_index.search(query_vector, top_k)
    return _assemble(frame, embedder, distances, indices)


def _assemble(frame, embedder, distances, indices):
    """Turn index hits into JSON-safe result records."""
    results = []
    for position, row_index in enumerate(indices[0]):
        record = frame.iloc[int(row_index)].to_dict()
        # NaN is not JSON-serialisable and must not reach a response body.
        record = {k: (None if _is_nan(v) else v) for k, v in record.items()}
        record["_match"] = {
            "rank": position + 1,
            "distance": float(distances[0][position]),
            "backend": embedder.name,
            "semantic": embedder.semantic,
        }
        results.append(record)
    return results


def _is_nan(value):
    return isinstance(value, float) and value != value


__all__ = [
    "semantic_search",
    "apply_constraints",
    "backend_info",
    "reset",
    "DatasetUnavailable",
    "EmbeddingBackendUnavailable",
]
