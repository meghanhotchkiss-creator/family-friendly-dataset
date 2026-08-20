# Blocked work, and exactly how to unblock it

Everything here is built, tested and waiting on something this environment
cannot provide. Nothing in this file is a coding task.

**What I will not do to get around these:** disable TLS verification, tunnel
past the egress proxy, or otherwise evade the network controls on this account.
Those 403s are an organisation policy, the proxy's own documentation says
policy denials get reported rather than routed around, and doing it quietly to
avoid whoever administers the account would be worse, not better.

**What to do instead — offline mode.** You obtain the upstream files through
whatever channel your environment permits, and Scout imports them through the
same adapter parsers it would use on the wire:

```bash
export SCOUT_TRANSPORT=offline
export SCOUT_OFFLINE_DIR=./data/upstream    # default
npm run travel:import:all
```

Same normalisation, same claims, same provenance, same confidence maths — only
the byte source differs. See `data/upstream/README.md` for the file layout and
`manifest.json` mapping. Verified end to end: a real OurAirports CSV slice
imports 5 real airports across 5 region flags with correct coordinates.

This is the supported path, not a workaround. If the data can reach the machine
legitimately, the platform can ingest it.

**Already done for two of the four datasets.** The egress policy explicitly
permits `registry.npmjs.org` and `pypi.org`, and both of these datasets are
published there, so `scripts/build_upstream.py` fetches them through that
sanctioned channel:

```bash
python scripts/build_upstream.py            # npm + pip, no policy involved
SCOUT_TRANSPORT=offline npm run travel:import:geography
SCOUT_TRANSPORT=offline npm run travel:import:airports
```

| Dataset | Package | Real records imported |
|---|---|---|
| Countries | `world-countries` (npm, ODbL) | **250 countries**, all 8 regions |
| Airports | `airportsdata` (PyPI, MIT) | **7,884 IATA airports**, all 8 regions |

Verified against known values: LHR `51.4706,-0.46194`, NRT `35.7647,140.386`,
SYD `-33.9461,151.177`, JNB `-26.13367,28.24233`, ORD `41.97694,-87.90815`.

`data/upstream/PROVENANCE.md` records versions, licences and the one derived
field. Still unavailable this way: places (no public dataset carries the age
and duration fields) and live weather (a live API has no package form).

---

## 1. Live provider data — blocked on egress policy

**Status:** adapters complete and verified against each API's real wire shape.
**Blocked by:** the egress proxy returns 403 CONNECT for every external host.

| Adapter | Endpoint | Wire shape verified |
|---|---|---|
| airports | `davidmegginson.github.io/ourairports-data` | exact OurAirports CSV header |
| geography | `restcountries.com/v3.1` | `cca2` / `cca3` / `name.common` / `currencies` |
| weather | `api.open-meteo.com/v1/forecast` | `current` / `current_units` |
| geocode | `nominatim.openstreetmap.org/search` | `jsonv2` string coords, `importance`, `category` |

**Unblock:**

```bash
# 1. allowlist these hosts in the environment's egress policy (admin action)
#    restcountries.com, davidmegginson.github.io, api.open-meteo.com,
#    nominatim.openstreetmap.org
# 2. then:
export SCOUT_TRANSPORT=network
npm run travel:import:all
npm run sentinel:check     # confirms each provider is up against the live endpoint
```

No code changes. Schema-drift detection will flag any API whose shape has moved
since these parsers were written.

**Verification that the live path really executes:** running with
`SCOUT_TRANSPORT=network` today produces `[upstream_auth] HTTP 403` from the
proxy against the real `restcountries.com` URL — so request construction and
error mapping run for real; only the bytes are missing.

---

## 2. Venue coordinates — blocked on egress policy

**Status:** `npm run travel:geocode` is built, tested and rate-limit compliant.
**Blocked by:** the same egress policy (Nominatim is an external host).

120 of 179 places carry a city centroid instead of a street address. They are
flagged `location_precision = 'city'` and **refused** for neighbourhood and
transit linking, so the imprecision cannot silently corrupt a "what is nearest"
answer. `npm run travel:normalize` reports them every run.

**Unblock:**

```bash
export SCOUT_TRANSPORT=network
export SCOUT_GEOCODE_EMAIL=you@example.org   # Nominatim requires contact details
npm run travel:geocode -- --limit=200
npm run truth:resolve                        # applies the winning coordinates
```

The geocoder writes lat/lon as *claims* at `open_dataset` authority (0.70),
which outranks the seed dataset (0.35), so centroids are replaced through the
ordinary truth-resolution path — no special-casing, no direct writes to
`places`. Hits that resolve back to the city itself are rejected rather than
locked in at higher authority.

I did not hand-write 120 venue coordinates. That would be fabrication with a
provenance record attached, which is worse than a missing value.

---

## 3. Wikimedia Enterprise — blocked on egress and an account

**Status:** spec and JWT auth flow built and tested against a stub transport.
**Blocked by:** `enterprise.wikimedia.com` is unreachable here, and there are no
credentials.

```bash
export SCOUT_TRANSPORT=network
export WME_USERNAME=...            # named in the spec, never stored in it
export WME_PASSWORD=...
npm run sourcemesh -- health --source=wikimedia-enterprise
```

`sourcemesh health` reports it `unconfigured` rather than `down`, because a
missing credential is not an outage.

**Consider the free tier first.** Wikimedia Enterprise is the paid high-volume
product. For enrichment, the public Wikipedia REST API, the Wikidata query
service and the Wikimedia dumps carry the same content under CC BY-SA / CC0,
need no commercial agreement, and would use the same spec format. Enterprise
earns its keep for firehose realtime and whole-project snapshots, not for
looking up a few thousand attractions.

## 4. Kaggle datasets — two blockers left, one removed

**Status:** the Kaggle CLI installs from PyPI, which the egress policy permits:

```bash
pip install kaggle          # works here: Kaggle CLI 2.2.4
```

**Blocked by:** (1) no API token, (2) `kaggle.com` unreachable.

```bash
# 1. Kaggle -> Settings -> API -> Create New Token, save as:
#      ~/.kaggle/kaggle.json      (chmod 600)
# 2. allowlist kaggle.com in the egress policy
kaggle datasets download -d <owner>/<dataset> -p data/upstream --unzip
SCOUT_TRANSPORT=offline npm run sourcemesh -- ingest --source=<spec>
```

**`kernels pull` is the wrong verb for data.** It downloads a *notebook* --
Python source -- not a dataset. `kaggle datasets download` is the one that
retrieves data. A kernel like `ryanholbrook/exercise-the-sliding-window` is a
lesson from Kaggle's Computer Vision course about convolution and pooling; it
contains no travel data and nothing SourceMesh could ingest.

**Licence review is mandatory, not optional.** Kaggle content carries per-item
licences that are frequently unstated, derivative, or scraped from sources whose
terms prohibit redistribution. `registerSpec` refuses any source without a
licence and attribution, so a Kaggle dataset cannot be registered until someone
has read its terms. That is the guard working, not an obstacle to route around.
Name a dataset and its licence and the spec is a few minutes' work.

## 5. A real places aggregator — blocked on a commercial decision

**Status:** the adapter slot is built; the data in it is Scout's own seed set,
labelled `sourceClass: 'seed'` at authority 0.35 with a reserved `.invalid`
host so it cannot be mistaken for a vendor.
**Blocked by:** no public API carries `min_age` / `max_age` /
`typical_visit_minutes`, which is what this dataset is actually about. Picking a
vendor (Foursquare, Google Places, OpenTripMap) is a commercial call, not a
technical one.

**Unblock:** add the vendor as a *new* adapter at `major_aggregator` (0.80).
The seed provider then loses every contested field automatically, because
0.35 < 0.80. No migration, no deletion, no truth-engine changes — that is what
the authority scale is for.

---

## What is NOT blocked

Everything else runs today: migrations, imports, normalisation, the topic and
user graphs, the truth layer, radar change detection and verification, the
sentinel, rewards, the recommendation API, and the nine-step proof scenario.
