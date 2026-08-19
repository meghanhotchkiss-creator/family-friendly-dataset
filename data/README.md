# Activity dataset

The API reads a CSV of family-friendly activities. **The file is not committed
to this repository** — it is data, not code, and it is not currently published
anywhere in this repo's history.

## Location

By default the API looks for:

    data/processed/family_friendly_dataset.csv

Override with the `FAMILY_DATASET_URL` environment variable. It accepts a local
path or an `http(s)://` URL:

    export FAMILY_DATASET_URL=/srv/scoutfox/activities.csv
    export FAMILY_DATASET_URL=https://example.org/activities.csv

Alternatively set `USE_BIGQUERY=true` and `BQ_TABLE` to read from BigQuery
instead of a CSV. In that mode the CSV is not used.

## Required columns

These are the columns the code actually reads today. They were derived from the
source, not from a specification:

| Column | Required by | Used for |
| --- | --- | --- |
| `name` | `api/ai_recommender.py` | The text that gets embedded for semantic search. Required; search cannot run without it. |
| `state` | `api/server.py` | Filtering on the `?state=` query parameter. Compared case-insensitively. |
| `indoor_or_outdoor` | `api/server.py` | Filtering on the optional `?indoor=` query parameter. Matched exactly. |

Any additional columns are passed through untouched — the `/recommend`
endpoints return whole rows — so extra fields such as address, price, or age
range are preserved in responses without code changes.

## Minimal example

    name,state,indoor_or_outdoor
    Riverside Park Playground,FL,outdoor
    County Science Museum,FL,indoor

## Behaviour when the dataset is missing

- `api/ai_recommender.py` raises `DatasetUnavailable` with the path it tried.
  The module still imports cleanly; the error surfaces on first search.
- `api/server.py` returns HTTP 500 with a generic message. The path is written
  to the server log rather than the response body.
