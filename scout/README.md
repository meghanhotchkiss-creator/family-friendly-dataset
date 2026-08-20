# Scout travel intelligence platform

A travel graph, a user graph, a topic graph, a change-detection radar, a truth
layer, a connection sentinel and a rewards engine — built as six parallel
tracks against one frozen set of contracts.

## Zero runtime dependencies

`node:sqlite`, `node:http`, `node:test`, `node:crypto`. TypeScript runs
directly via Node's type stripping, so there is no build step. The only
devDependencies are `typescript` and `@types/node`.

`tsconfig.json` sets `erasableSyntaxOnly`, so `npm run typecheck` mechanically
rejects syntax Node cannot execute (enums, namespaces, decorators, constructor
parameter properties).

## The four "one X" rules

Parallel development works only if nobody invents a second version of these.
They are enforced structurally, not by convention:

| Rule | Where it lives | How it is enforced |
|---|---|---|
| One schema | `scout/db/migrations/` | Authored centrally. No track writes DDL. Checksums reject an edited migration. |
| One source-of-truth model | `source_records` → `truth_resolutions` | Nothing writes a fact onto an entity directly. Radar records claims; only the Truth Engine applies them. |
| One confidence model | `scout/contracts/confidence.ts` | A single `computeConfidence()`. No other 0..1 certainty scale exists. |
| One provider interface | `scout/contracts/provider.ts` | Every connector implements `Provider`. Sentinel, cache and failover treat them identically. |

### The confidence model

```
confidence = noisyOr(authorities) × freshness × verificationWeight
```

- **noisy-OR** (`1 - Π(1 - aᵢ)`) so independent corroboration accumulates without ever exceeding 1. Authorities are deduped by source id — a source cannot corroborate itself.
- **freshness** decays `0.5 ^ (ageDays / halfLifeDays)`, floored at 0.25 so stable old facts do not vanish.
- **verification** weights `human_verified` 1.0 … `disputed` 0.4 … `rejected` 0.0.

Every number the platform shows can be explained from its four components.

## Getting started

```bash
npm install
npm run bootstrap     # migrate + import + normalize + topics + user graph + truth
npm run scout:demo    # the nine-step proof scenario
npm test              # 194 tests
npm run api:serve     # HTTP API on :8787
```

## Commands

| Command | Does |
|---|---|
| `db:migrate` / `db:reset` / `db:status` | Schema, with checksum drift detection |
| `data:fetch` / `data:fixtures` | Pull the upstream datasets; re-record the committed fixtures |
| `data:ingest` / `data:seed` | Run every SourceMesh spec offline; migrate + ingest + validate |
| `data:validate` | Geography funnel, and whether GB FR JP AU ZA US CA BR IN resolve |
| `data:status` | BUILT / CONNECTED / SEEDED / TESTED per source |
| `sourcemesh -- credentials` | What Scout needs from you, and which capabilities are actually available |
| `travel:import:{geography,airports,places,gtfs,all}` | Global import framework |
| `travel:geocode` | Upgrade city-centroid coordinates to venue precision via OpenStreetMap (needs egress) |
| `travel:normalize` | Dedupe, canonical hashes, derived touristiness/local favour, neighbourhood linking |
| `graph:topic:build` / `topics:discover` | Core taxonomy plus automatic candidate discovery |
| `graph:user:build` | Recompute learned preferences from signals |
| `truth:resolve` | Adjudicate competing claims, apply the winners |
| `radar:scan` / `radar:verify` / `radar:health` | Conditional fetch, delta classification, verification |
| `sentinel:check` | Provider health, drift, incidents |
| `rewards:quote` | Award valuation, transfer planning, friction |
| `recommend` / `api:serve` / `scout:demo` | Scout Mind |

## Live providers

Adapters are real: real URL construction, parsing, normalisation, schema
fingerprinting and error mapping. They reach the outside world through one
seam — `scout/connectors/transport.ts`.

There are three byte sources behind that one seam:

| `SCOUT_TRANSPORT` | Source |
|---|---|
| unset | recorded fixtures (default) |
| `offline` | **real upstream files from `SCOUT_OFFLINE_DIR`** — same parsers, same claims, no network needed |
| `network` | live HTTP |

`offline` is the answer when egress is closed by policy: obtain the datasets
through a permitted channel, drop them in `data/upstream/`, and import them for
real. See `data/upstream/README.md`.

Two of them are already automated, because package registries are permitted
where data hosts are not:

```bash
npm run data:fetch      # world-countries (npm), ourairports-data + opentraveldata
                        # (GitHub), geonamescache (PyPI) -> data/upstream/
npm run data:seed       # migrate, ingest every spec offline, then validate
npm run data:validate   # the funnel, and whether the geography resolved
npm run data:status     # BUILT / CONNECTED / SEEDED / TESTED per source
npm run data:fixtures   # re-record the committed test fixtures from the above
```

That yields **250 real countries and 85,925 real airports across all 8 region
flags**, plus 3,985 administrative regions, 48,180 runways, 30,339 frequencies
and 11,008 navaids. `npm run data:validate` reports the funnel and asserts that
GB FR JP AU ZA US CA BR IN all resolve. The data files themselves are
gitignored — they carry their own licences — so a fresh clone runs on the
recorded fixtures until you run the fetch.

To go live over the network:

```bash
export SCOUT_TRANSPORT=network
export SCOUT_PLACES_API_KEY=...     # only the places aggregator needs a key
```

No adapter code changes. Verified: with `SCOUT_TRANSPORT=network` the pipeline
really requests `https://restcountries.com/v1/...` and maps the proxy's 403 to
`upstream_auth`, so the live path executes end to end.

Fixture coverage: 58 countries and 86 airports across all 8 region flags
(NA CA SA EU ME AF AS OC), 179 places (120 from this repo's existing seed
dataset plus 59 international), 3 GTFS feeds.

## Architecture

```
                        contracts/  (frozen)
                              │
      ┌────────────┬──────────┼──────────┬────────────┐
      ↓            ↓          ↓          ↓            ↓
 Travel Graph  User Graph  Topic     Radar        Sentinel
      │            │       Graph        │            │
      └────────────┴──────────┴─────────┴────────────┘
                              ↓
                    source_records (claims)
                              ↓
                   Truth Engine (adjudicates)
                              ↓
                        Scout Mind
                              ↓
                   Recommendation API
```

The load-bearing separation: **Radar never writes to `places`.** It records
claims under the watching source and lets the Truth Engine decide. That is what
makes every served value traceable to the source that won and the competition
it beat — visible at `GET /place?id=…`.

## Closed in migration 010

Two gaps the tracks hit against the frozen schema, both fixed additively:

- **`topics.confidence_json`.** Topics persisted only the scalar, and the reader rebuilt the object by feeding that final value back in as an *authority* — so `computeConfidence` re-applied the verification weight and the number shrank on every read (0.95 → 0.8075, and `human_verified` silently became `unverified`). The full `Confidence` now round-trips exactly.
- **`radar_deltas.source_record_id`.** Radar files a claim per actionable delta but had no link to it, so verification re-identified the claim by `(source, entity, field, content_hash)` with newest-wins — which a same-valued row could capture, and which finds nothing once the Truth Engine supersedes the row. Deltas now carry the claim id; the hash lookup remains only as a fallback for rows written before the column existed.

## What is real, and what is not

| | |
|---|---|
| **Real** | 86 airport IATA/ICAO codes, names and coordinates; 58 country ISO codes and regions; 163 city names; 179 place names and their cities; 19 GTFS stops |
| **Not real** | Every *number* about a place — rating, `min_age`, `max_age`, `duration_minutes` — is Scout seed data. `touristiness` and `local_favor` are computed by formula in `travel:normalize`, not observed. Loyalty transfer ratios are real-world-shaped but unverified. Award quotes and weather values are synthetic. |

This is visible at runtime rather than only in a doc: every one of those values
resolves through `Scout seed dataset (0.30 low)`, and `GET /place?id=…` returns
the provenance alongside the value.

## Known gaps

- **Providers are fixture-backed here.** Egress is blocked by policy and commercial feeds need credentials. The adapters are real and verified against each API's true wire shape; only the bytes are recorded. Exact unblock steps: [BLOCKED.md](BLOCKED.md).
- **The places provider serves Scout's own seed data, and is labelled as such.** No public API carries `min_age`/`max_age`/`typical_visit_minutes`, which is where this dataset's value lives, so that adapter is the *slot* a real aggregator will occupy — its pagination, header auth and normalisation are real work — while the rows are Scout's. It sits at `sourceClass: 'seed'` / authority 0.35 and its base URL is a reserved `.invalid` host, so nothing can mistake it for a vendor and any real provider added later automatically outranks it. The other four adapters target genuinely real endpoints.
- **120 of 179 places carry a city centroid, not a street address.** They are flagged `location_precision = 'city'` and *refused* for neighbourhood and transit linking, so the imprecision cannot silently corrupt a "what is nearest" answer; `travel:normalize` reports the count every run. `npm run travel:geocode` upgrades them via OpenStreetMap and is built and tested — it needs egress. See [BLOCKED.md](BLOCKED.md).
