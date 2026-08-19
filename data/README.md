# Seed data

Everything the API, bots, dashboard and widgets read starts here.

```
data/
  seeds/                              <- source of truth, edit these
    activities.json                   120 family-friendly places
    users.json                          6 API-key holders (tier + balance)
    families.json                      12 families with members and budgets
    trips.json                         20 trips with day-by-day itineraries
    feedback.json                      20 trip ratings and comments
    global_patterns.json                5 travel-behaviour clusters
    points_ledger.json                103 points events behind each balance
  processed/                          <- generated, do not edit
    family_friendly_dataset.csv       what api/server.py loads
    family_friendly_dataset.json      same rows for JS consumers
    scoutfox.db                       SQLite build (git-ignored)
```

## Build it

```bash
make seed          # validate + build everything
```

or step by step:

```bash
python scripts/validate_seeds.py      # consistency checks
python scripts/build_dataset.py       # seeds -> processed CSV + JSON
python scripts/seed_db.py --sqlite    # seeds -> data/processed/scoutfox.db
python scripts/seed_db.py --sql       # seeds -> db/seed.sql (PostgreSQL)
```

The tooling is standard library only, so it works before `api/requirements.txt`
is installed. That matters: the API cannot start without the generated CSV.

## Load it into PostgreSQL

```bash
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/seed.sql
```

`db/schema.sql` supersedes the sketch in the repo-root `Uberliketasks` file. It
keeps those four tables (`families`, `trips`, `feedback`, `global_patterns`)
unchanged and adds the three the application needs: `activities`, `users` and
`points_ledger`. `db/schema.sqlite.sql` is the column-for-column SQLite
equivalent; `tests/test_seed_data.py` fails if the two drift apart.

## Query it without a server

```bash
sqlite3 data/processed/scoutfox.db \
  "SELECT name, city, price_tier FROM activities WHERE state='IL' AND indoor_or_outdoor='indoor';"
```

## activities.json

| field | notes |
|---|---|
| `id` | `<state>-<nnn>`, e.g. `ca-001` |
| `name`, `type` | shown by the bots and the dashboard |
| `category` | one of `museum park zoo aquarium library beach landmark theme_park historic_site` |
| `city`, `state` | `state` is the two-letter code the `/recommend` filter matches |
| `indoor_or_outdoor` | exactly `indoor` or `outdoor` — `/recommend?indoor=` compares literally |
| `price_tier` | `free`, `$`, `$$` or `$$$`, matching what `bots/nlu_parser.py` produces |
| `min_age`, `max_age` | suitable age range; `99` means no upper bound |
| `avg_duration_hours`, `rating` | planning hints |
| `tags` | list in JSON, `;`-joined in the CSV |
| `description` | one line |

Coverage is 15 activities in each of the eight states the dashboard selector and
`bots/nlu_parser.py` support (CA, TX, FL, NY, AZ, OH, GA, IL), each with both
indoor and outdoor options so no filter combination comes back empty.

## What is real and what is not

Names, types, cities and states refer to **real, public** family attractions, so
the data reads sensibly in a demo. Everything else is **synthetic demo data**:
ratings, durations, age ranges, and all of `users`, `families`, `trips`,
`feedback`, `global_patterns` and `points_ledger` are invented. Do not present
the ratings as real review scores, and do not treat the families as real people.
There is no admission-price, opening-hours or booking data here — the affiliate
links in `api/points.py` are placeholders.

## Rules the validator enforces

`scripts/validate_seeds.py` exits non-zero if any of these break:

- unique ids across activities, users, families, trips, feedback, patterns, ledger
- `category`, `price_tier`, `indoor_or_outdoor`, `tier` all use known values
- every supported state has at least one indoor *and* one outdoor activity
- every itinerary entry points at an activity that exists
- every trip and feedback row points at a family that exists, and feedback
  points at a trip owned by that same family
- ratings are 1–5, `min_age <= max_age`, `start_date <= end_date`
- **each user's `points` equals the sum of their `points_ledger` entries**, so
  `/points/points_balance` and `/points/points_history` never disagree

## Changing the data

Edit the JSON under `data/seeds/`, then run `make seed && make test`. The test
suite fails if the committed CSV is stale, so regenerate before committing.
