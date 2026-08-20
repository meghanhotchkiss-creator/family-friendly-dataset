# SourceMesh

CONNECT → UNDERSTAND → MAP → RESOLVE → VERIFY → DEDUPE → MONITOR → API

The engine that turns a messy external dataset into normalised, provenanced
records. **A new dataset is a spec, not code** — that is the whole claim, and
the test suite holds the line on it.

## The commercial gate

> If every new dataset still requires modifying importer code, it isn't the product yet.

Nine datasets, four record shapes, one adapter, zero importer code:

| Source | Shape | Rows | Result |
|---|---|---|---|
| `restcountries` (world-countries, npm) | JSON array, nested `name.common` | 250 | 250 imported |
| `geonames-cities15000` (geonamescache, PyPI) | JSON **map keyed by id**, array field | 34,006 | 34,006 imported |
| `ourairports` (ourairports-data, GitHub) | CSV, quoted commas | 85,936 | 85,925 imported |
| `ourairports-regions` | CSV | 3,987 | 3,985 imported |
| `ourairports-runways` | CSV, joins on `ident` | 48,180 | 48,176 imported |
| `ourairports-frequencies` | CSV, joins on `ident` | 30,339 | 30,336 imported |
| `ourairports-navaids` | CSV, optional airport link | 11,008 | 11,008 imported |
| `optd-por` (OpenTravelData, GitHub) | CSV, `^`-delimited, mixed entities | 20,939 | 9,380 airports selected |
| `wikimedia-enterprise` | JSON, JWT login | — | skipped: no credentials |

Adding the five OurAirports files after the first one took no adapter changes:
they are JSON specs. The three capabilities they did need -- several `select`
conditions ANDed together, a `1`/`0` boolean, and an id namespace so a local
`ident` cannot collide with an IATA code -- are generic, and every source has
them now.

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
that derives the region from the source's own `continent` column instead of
resolving it through the countries table.

The funnel is spotless:

```
SOURCE ROWS      85936  ████████████████████████████
PARSED           85936  ████████████████████████████
MAPPED           85936  ████████████████████████████
COUNTRY MATCHED  85936  ████████████████████████████
REGION RESOLVED  85936  ████████████████████████████
IMPORTED         85936  ████████████████████████████
BALANCED         all 85,936 source rows accounted for
```

The data is wrong anyway. `continent` and Scout's region flags are different
vocabularies that happen to share five of their codes:

| | Middle East | Central America / Caribbean | Antarctica |
|---|---|---|---|
| correct spec | 1,543 airports | 1,093 airports | folded into OC |
| naive spec | **18** | **13** | `AN`, which is not a region at all |

Only the Antarctic rows announce themselves, as 46 `PERSIST_FAILED` rows on the
`regions(code)` foreign key. The 2,600 Middle Eastern and Caribbean airports are
filed under Asia and North America with no error of any kind: a green funnel, a
balanced ledger, and a travel graph that thinks Jordan is in Asia and Jamaica is
in North America.

That is the case for resolvers. The repair is a spec edit, not a code change:

```
    source.iso_country -> countries.iso2 -> countries.region_code
```

When the source's own column is genuinely empty rather than merely wrong, the
diagnosis says so directly, extrapolating from a capped sample and reporting
what it actually examined rather than quoting the cap as a population:

```
[CRITICAL] 100.0% of otherwise-valid records were rejected at "REGION RESOLVED"
  Likely cause: continent is blank for 500 of 500 sampled rejects.
  Suggested repair: Resolve the region from the existing countries table
  instead of the source's own column.
```

## No silent drops

Every source row lands in exactly one terminal bucket, and the buckets are
checked against the source count. An unbalanced run is a defect regardless of
how many rows it inserted -- the missing ones went somewhere nobody is looking.

```
source_rows           85936
parsed_rows           85936
selected_out_rows         0
mapped_rows           85936
validated_rows        85925
matched_rows          85936
inserted_rows         85925
updated_rows              0
unchanged_rows            0
quarantined_rows         11
rejected_rows             0
———————————————————————————
BALANCED           all 85,936 source rows accounted for
quarantined     11  MISSING_REQUIRED_FIELD
```

Those eleven are airports in `XP` and `ZZ` — OurAirports' placeholders for "no
country" — and they are refused rather than filed somewhere plausible.

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
