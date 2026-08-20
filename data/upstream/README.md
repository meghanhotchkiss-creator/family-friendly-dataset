# Local upstream datasets

Drop **real** upstream files here and Scout imports them through the same
adapter parsers it would use on the network — same normalisation, same claims,
same provenance. This exists so a closed egress policy is not a dead end.

```bash
npm run data:seed       # fetch, migrate, ingest every spec offline, then validate
npm run data:fetch      # just refill this directory from permitted channels
```

**A fresh clone has none of these files** — they are third-party datasets with
their own licences, so they are gitignored. `data:seed` fetches them first for
exactly that reason. Running `data:ingest` on its own before a fetch imports
nothing and says so, naming `data:fetch` as the remedy rather than reporting a
missing credential.

Obtain the files through whatever channel your environment permits (an approved
mirror, an internal artifact store, a vendor export, a download on an
unrestricted machine). Do not work around your organisation's network policy to
get them.

| Provider | File | Source |
|---|---|---|
| airports | `ourairports-data/airports.csv` | https://davidmegginson.github.io/ourairports-data/airports.csv |
| admin regions | `ourairports-data/regions.csv` | https://davidmegginson.github.io/ourairports-data/regions.csv |
| country roster | `ourairports-data/countries.csv` | https://davidmegginson.github.io/ourairports-data/countries.csv |
| runways | `ourairports-data/runways.csv` | https://davidmegginson.github.io/ourairports-data/runways.csv |
| frequencies | `ourairports-data/airport-frequencies.csv` | https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv |
| navaids | `ourairports-data/navaids.csv` | https://davidmegginson.github.io/ourairports-data/navaids.csv |
| geography | `v3.1/all` (JSON array) | https://restcountries.com/v3.1/all |
| points of reference | `optd_por_public.csv` | https://github.com/opentraveldata/opentraveldata |
| cities | `geonames-cities15000.json` | https://download.geonames.org/export/dump/cities15000 |
| weather | `v1/forecast` (JSON) | https://api.open-meteo.com/v1/forecast |
| geocode | `search` (JSON array) | https://nominatim.openstreetmap.org/search |

Layout follows the URL path, so `…/ourairports-data/airports.csv` becomes
`ourairports-data/airports.csv`. Anything unusual can be mapped explicitly in
`manifest.json`:

```json
{ "https://restcountries.com/v3.1/all": "countries-export.json" }
```

A file that is missing is reported as `not_configured` listing every path
tried. Nothing is ever fabricated to fill a gap.

`.gitignore` excludes the data files themselves — they are third-party datasets
with their own licences, not Scout's to redistribute.
