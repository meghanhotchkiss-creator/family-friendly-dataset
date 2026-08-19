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

```bash
npm run sourcemesh -- list       # registered sources + required attribution
npm run sourcemesh -- inspect    # schema profile + proposed mapping
npm run sourcemesh -- validate   # check the spec against real data first
npm run sourcemesh -- ingest     # run the funnel
npm run sourcemesh -- report     # last run per source
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
