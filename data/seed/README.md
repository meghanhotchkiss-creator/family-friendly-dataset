# Seed data

**This data is fictional.** Every venue, price and age range in
`family_friendly_seed.csv` is invented by `scripts/generate_seed_data.py`. No
row describes a real place. Do not show it to a family, publish it, or use it
to evaluate recommendation quality.

It exists so the API and recommender can be run and tested before real data is
available, and so that failures surface in development.

## Why it is not at the default dataset path

The API defaults to `data/processed/family_friendly_dataset.csv`. This file is
deliberately somewhere else, so that seed data cannot quietly become "the
dataset" by being in the place the code already looks. Point at it explicitly:

    FAMILY_DATASET_URL=data/seed/family_friendly_seed.csv \
    FAMILY_API_KEY=dev-key JWT_SECRET=dev-secret \
    uvicorn server:app --app-dir api

## Regenerating

    python scripts/generate_seed_data.py

Deterministic — the same seed produces the same 134 rows. Coverage is 16 cities
across 12 states/regions, including `Greater London` and `Ontario`, which are
not two-letter US state codes. That is intentional: logic assuming a US state
code should fail here rather than in production.

Every row carries `source=synthetic-seed` and `is_seed_data=true`, so seed rows
can always be told apart from real ones if the two ever share a store.
