# Tests

Regression tests for the security fixes. Each test corresponds to a defect that
was demonstrated as exploitable against the previous implementation.

## Running

    python -m venv .venv
    .venv/bin/pip install fastapi pandas python-jose pytest httpx
    .venv/bin/python -m pytest tests/ -q

The heavy optional dependencies (`sentence-transformers`, `faiss-cpu`,
`google-cloud-bigquery`, `stripe`, `firebase-admin`) are not needed: BigQuery is
stubbed in the test that covers query parameterisation, and the recommender now
imports its model lazily.
