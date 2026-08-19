# Local upstream datasets

Drop **real** upstream files here and Scout imports them through the same
adapter parsers it would use on the network — same normalisation, same claims,
same provenance. This exists so a closed egress policy is not a dead end.

```bash
export SCOUT_TRANSPORT=offline
npm run travel:import:airports
```

Obtain the files through whatever channel your environment permits (an approved
mirror, an internal artifact store, a vendor export, a download on an
unrestricted machine). Do not work around your organisation's network policy to
get them.

| Provider | File | Source |
|---|---|---|
| airports | `ourairports-data/airports.csv` | https://davidmegginson.github.io/ourairports-data/airports.csv |
| geography | `v3.1/all` (JSON array) | https://restcountries.com/v3.1/all?fields=name,cca2,cca3,currencies,region,subregion,capital,capitalInfo |
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
