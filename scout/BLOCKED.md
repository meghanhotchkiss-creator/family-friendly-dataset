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

## 3. A real places aggregator — blocked on a commercial decision

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
