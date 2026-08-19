# Activity dataset

The API reads a CSV of family-friendly activities from
`data/processed/family_friendly_dataset.csv`.

Override the location with `FAMILY_DATASET_URL` (a local path or an `http(s)://`
URL), or set `USE_BIGQUERY=true` with `BQ_TABLE` to read from BigQuery instead.

## How the file is produced

    python scripts/build_dataset.py --source seed          # no credentials needed
    python scripts/build_dataset.py --source seed,nps      # adds live NPS data
    python scripts/build_dataset.py --list-sources         # what is available

Each source is a provider in `api/providers/`. The builder normalises every
provider's output to the schema below, de-duplicates, validates, and writes the
CSV. Providers whose credentials are missing are skipped with a warning rather
than failing the build, so `--source seed,nps,places` works before every key
has been obtained.

## Schema

| Column | Required | Values | Notes |
| --- | --- | --- | --- |
| `id` | yes | slug | Stable key, derived from source + name + state. Used for de-duplication |
| `name` | yes | text | Embedded for semantic search |
| `state` | yes | 2-letter code | Uppercase. Filtered case-insensitively by `?state=` |
| `city` | no | text | |
| `type` | no | `park`, `museum`, `zoo`, `aquarium`, `library`, `playground`, `science_center`, `historic_site`, `beach`, `trail`, `garden`, `other` | |
| `indoor_or_outdoor` | yes | `indoor`, `outdoor`, `both` | Filtered exactly by `?indoor=` |
| `min_age` | no | integer | Youngest age the activity suits. `0` means all ages |
| `max_age` | no | integer | `99` means no upper bound |
| `price_band` | no | `free`, `$`, `$$`, `$$$` | Bands, not prices — prices change and we do not track them |
| `url` | no | https URL | Official site |
| `source` | yes | provider name | `seed_curated`, `nps`, `places`, `libraries` |
| `verified` | yes | `true` / `false` | Whether a human has checked this row |

Extra columns are passed through untouched — `/recommend` returns whole rows, so
additional fields reach clients without code changes.

## What is deliberately absent

**Opening hours, ticket prices, and phone numbers.** They change often, and
serving a stale price to a family planning a day out is worse than serving
nothing. `price_band` carries the rough cost; `url` sends people to the source
of truth.

## The current seed

`data/processed/family_friendly_dataset.csv` ships a curated seed of
well-known, long-lived public attractions so that the API returns real results
before any third-party account exists.

**Every seed row has `verified=false`.** The names, states, and categories are
reliable; the URLs and age bands are best-effort and have not been checked
one-by-one. Treat the seed as enough to build and demo against, not as
publishable content. Flip `verified` to `true` per row as they are checked.

## Adding a live source

1. Add a provider in `api/providers/` subclassing `ActivityProvider`.
2. Return rows in the schema above from `search()`; the base class validates.
3. Register it in `api/providers/__init__.py`.
4. Add its credential to `.env.example` and to `docs/CREDENTIAL_REGISTER.md`.

A provider that cannot reach its API must raise; the builder catches it, warns,
and continues with the other sources.
