# Activity dataset

The API reads a CSV of family-friendly activities. **The file is not committed
to this repository** — it is data, not code, and it is not currently published
anywhere in this repo's history.

## Location

By default both the API server and the semantic search pipeline look for:

    data/processed/family_friendly_dataset.csv

Override with the `FAMILY_DATASET_URL` environment variable. It accepts a local
path or an `http(s)://` URL:

    export FAMILY_DATASET_URL=/srv/scoutfox/activities.csv
    export FAMILY_DATASET_URL=https://example.org/activities.csv

Set it to blank and the default applies — a variable exported as `""` is
treated as unset rather than as a file named `""`.

Resolution lives in one place, `api/dataset.py`, so the server and the
recommender can never disagree about where the data is. It reads the variable
each time the dataset is loaded rather than once at import, which means:

- A process that sets the variable after importing the modules (a test, a
  worker forked after config is read) gets the location it asked for, not the
  default.
- Moving the data is a configuration change. Repoint the variable and the
  server serves the new file on the next request; the recommender rebuilds its
  index on the next search. The index is only rebuilt when the location
  actually changes, so ordinary searches do not re-embed.

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

Both paths report the same underlying `dataset.DatasetUnavailable`, which names
the location that was tried and the variable that overrides it:

- `api/ai_recommender.py` lets it propagate. The module still imports cleanly;
  the error surfaces on first search.
- `api/server.py` converts it to HTTP 500 with a generic message. The path is
  written to the server log rather than the response body, because it is
  deployment configuration and discloses internal layout.
