# SourceMesh

CONNECT → UNDERSTAND → MAP → RESOLVE → VERIFY → DEDUPE → MONITOR → API

The engine that turns a messy external dataset into normalised, provenanced
records. **A new dataset is a spec, not code** — that is the whole claim, and
the test suite holds the line on it.

## The commercial gate

> If every new dataset still requires modifying importer code, it isn't the product yet.

Three datasets, three record shapes, one adapter, zero importer code:

| Source | Shape | Rows | Result |
|---|---|---|---|
| `restcountries` (world-countries, npm) | JSON array, nested `name.common` | 250 | 250 imported |
| `geonames-cities15000` (geonamescache, PyPI) | JSON **map keyed by id**, array field | 34,006 | 34,006 imported |
| `ourairports` (airportsdata, PyPI) | CSV, quoted commas | 28,291 | 28,291 imported |
| `optd-por` (OpenTravelData, GitHub) | CSV, `^`-delimited, mixed entities | 20,939 | 9,874 airports selected |

```bash
npm run sourcemesh -- list       # registered sources + required attribution
npm run sourcemesh -- inspect    # schema profile + proposed mapping
npm run sourcemesh -- validate   # check the spec against real data first
npm run sourcemesh -- ingest     # run the funnel
npm run sourcemesh -- report     # last run per source
```

## Three things OPTD forced, all generic

Adding OpenTravelData needed no per-source code, but it did expose three gaps
in the engine — each closed as a spec capability rather than a special case:

- **`delimiter`** — OPTD is `^`-separated. Feeds are not all comma-delimited.
- **`select`** — one file holds airports, cities and rail stations. Rows a spec
  is not about are *selected out*, not rejected: they are a terminal bucket in
  the accounting, distinct from `rejected`, which means the row was wanted and
  found wanting. Conflating the two makes the accounting meaningless.
- **`extract`** — a regex capture, because real feeds pack several facts into
  one column (`city_detail_list` is `LAX|5368361|Los Angeles|...`).

## Identity beats similarity

OPTD publishes the GeoNames id of the city each airport serves, and GeoNames
publishes the same id on the city. Where both exist there is nothing to infer,
so `sourcemesh resolve` links those first and name-and-distance matching never
second-guesses the result:

```
exact linkage — airports to cities by GeoNames id
  linked               4279
  already correct       462
  no matching city     4951      <- reported, never invented
```

## The anomaly demo

The airport bug, reproduced as a spec (`specs/_demo-ourairports-naive.json`)
that derives the region from the source's own `continent` column:

```
SOURCE ROWS      28291  ████████████████████████████
PARSED           28291  ████████████████████████████
MAPPED           28291  ████████████████████████████
COUNTRY MATCHED  28291  ████████████████████████████
REGION RESOLVED      0  ····························
IMPORTED             0  ····························  <- anomaly

[CRITICAL] 100.0% of otherwise-valid records were rejected at "REGION RESOLVED"
  (28,291 -> 0). Likely cause: continent is blank for 500 of 500 sampled
  rejects (~28,291 of 28,291 rejected).
  Suggested repair: Resolve the region from the existing countries table
  instead of the source's own column.
    source.iso_country -> countries.iso2 -> countries.region_code
    would recover ~28,291 rejected rows (500/500 of the examined sample)
```

Applying that repair is a **spec edit**, not a code change — and recovers every
row. The rejected-row sample is capped at 500, so the diagnosis reports what it
actually examined alongside the extrapolation rather than quoting the cap as a
population.

## No silent drops

Every source row lands in exactly one terminal bucket, and the buckets are
checked against the source count. An unbalanced run is a defect regardless of
how many rows it inserted -- the missing ones went somewhere nobody is looking.

```
source_rows           28291
parsed_rows           28291
mapped_rows           28291
validated_rows            0
matched_rows          28291
inserted_rows             0
updated_rows              0
unchanged_rows            0
quarantined_rows      28291
rejected_rows             0
———————————————————————————
BALANCED           all 28,291 source rows accounted for
quarantined  28291  MISSING_REQUIRED_FIELD
```

`parsed`, `mapped`, `validated` and `matched` are progress gauges, not
destinations, so they are excluded from the sum on purpose.

Every quarantined row retains its source, its own record id, a machine-readable
`reason_code`, human details and the **full raw record** — so a run can be
re-driven after a mapping is repaired rather than re-fetched and re-guessed.
Validation rejects are retained in full; only the diagnostic sample used to
explain an anomaly is capped.

```bash
npm run sourcemesh -- quarantine --source=ourairports --limit=5
```

## Status, derived not written

```bash
npm run sourcemesh -- status
```

`BUILT / CONNECTED / SEEDED / TESTED / BROKEN / NOT STARTED`, computed from the
spec registry, run history, domain tables and the test suite. Designed-but-
unconnected sources are listed with their blocker, so a gap is visible rather
than simply absent. `TESTED` requires `SEEDED`: coverage is a property of a
seeded source, not a stage beyond it.

## Why a run can fail loudly

- `quality.rejectIfMissing` — fields without which a record is meaningless
- `quality.ranges` — a latitude of 900 is not a latitude
- `quality.minImportRatio` — **a run that keeps 15% of a real feed fails**; the
  original bug reported success while discarding 85% of the data
- funnel anomalies — any stage losing ≥20% is diagnosed, not averaged away
- persistence loss ≥20% warns that a dependency was not ingested first

## Ordering is a dependency order

Specs run `country → city → airport → place`, because geography resolvers look
values up in tables earlier sources populate. Sorting by filename put
`restcountries` last and silently cost ~15% of both other datasets.

## Licensing is enforced, not documented

`registerSpec` refuses a source with no licence and attribution. `npm run
sourcemesh -- list` prints the attribution lines that must accompany any
published output. `world-countries` is ODbL and flagged share-alike.

## Not built here

Blocked by egress (see `scout/BLOCKED.md`): OSM PBF extracts, Wikidata,
Wikivoyage, MobilityDatabase GTFS, NPS/RIDB, Natural Earth. Their specs are
straightforward to add once the hosts are reachable — that is the point of the
spec format. PostGIS/pgvector are not used: this runs on SQLite, and the SQL is
kept portable rather than pretending to a Postgres deployment that isn't here.
