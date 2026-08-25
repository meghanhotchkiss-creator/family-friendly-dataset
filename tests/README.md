# Tests

- `test_security.py` — regression tests for the security fixes. Each test
  corresponds to a defect that was demonstrated as exploitable against the
  previous implementation.
- `test_recommender.py` — constraints, embedding backends, and offline
  operation of the semantic search pipeline.
- `test_dataset_source.py` — how `api/dataset.py` resolves the dataset
  location, and that the server and the recommender both follow it.

## Running

    python -m venv .venv
    .venv/bin/pip install fastapi pandas python-jose pytest httpx
    .venv/bin/python -m pytest tests/ -q

The heavy optional dependencies (`sentence-transformers`, `faiss-cpu`,
`google-cloud-bigquery`, `stripe`, `firebase-admin`) are not needed: BigQuery is
stubbed in the test that covers query parameterisation, and the recommender now
imports its model lazily.
