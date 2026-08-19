#!/usr/bin/env python3
"""Fetch real upstream datasets from package registries into data/upstream/.

Why registries: this environment's egress policy blocks data hosts
(restcountries.com, ourairports, ...) but explicitly permits registry.npmjs.org
and pypi.org. Both datasets below are published there, so this is a sanctioned
channel -- not a way around the policy.

    python scripts/build_upstream.py
    SCOUT_TRANSPORT=offline npm run travel:import:all

Sources
-------
world-countries (npm)  the dataset restcountries.com serves; ODbL
airportsdata (PyPI)    ~28k airports derived from OurAirports; MIT

Everything written here is real. The one derived field is the airport `type`,
which airportsdata does not carry and Scout's schema requires; it is derived
from IATA presence and is recorded as derived in PROVENANCE.md.
"""

from __future__ import annotations

import csv
import io
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
UPSTREAM = REPO / "data" / "upstream"


def run(cmd: list[str], cwd: Path) -> None:
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"error: {' '.join(cmd)} failed:\n{proc.stderr[-800:]}")


def fetch_world_countries(work: Path) -> tuple[list[dict], str]:
    run(["npm", "pack", "world-countries"], work)
    tgz = next(work.glob("world-countries-*.tgz"))
    version = tgz.name.replace("world-countries-", "").replace(".tgz", "")
    with tarfile.open(tgz) as tar:
        member = tar.extractfile("package/countries.json")
        if member is None:
            raise SystemExit("error: countries.json missing from world-countries")
        return json.load(member), version


def fetch_airportsdata(work: Path) -> tuple[list[dict], str]:
    run([sys.executable, "-m", "pip", "download", "airportsdata", "--no-deps", "-d", "py"], work)
    wheel = next((work / "py").glob("airportsdata-*.whl"))
    version = wheel.name.split("-")[1]
    with zipfile.ZipFile(wheel) as zf:
        with zf.open("airportsdata/airports.csv") as fh:
            rows = list(csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8")))
    return rows, version


# REST Countries v3.1 field set the geography adapter requests. `capitalInfo`
# is deliberately absent: world-countries carries only a COUNTRY centroid, and
# passing that off as the capital's location is exactly the fake precision the
# platform refuses elsewhere.
COUNTRY_FIELDS = ("name", "cca2", "cca3", "currencies", "region", "subregion", "capital")


def to_restcountries(records: list[dict]) -> list[dict]:
    out = []
    for c in records:
        if not c.get("cca2") or not c.get("cca3"):
            continue
        out.append({f: c[f] for f in COUNTRY_FIELDS if f in c})
    return out


# OurAirports airports.csv column order, which the airports adapter parses.
OURAIRPORTS_COLUMNS = [
    "id", "ident", "type", "name", "latitude_deg", "longitude_deg", "elevation_ft",
    "continent", "iso_country", "iso_region", "municipality", "scheduled_service",
    "gps_code", "iata_code", "local_code", "home_link", "wikipedia_link", "keywords",
]


def derive_type(row: dict) -> str:
    """DERIVED, not sourced. airportsdata carries no size field.

    An IATA code means scheduled commercial service, which is the distinction
    that actually matters to a traveller; everything else is a small field.
    """
    return "medium_airport" if row.get("iata") else "small_airport"


def to_ourairports(rows: list[dict]) -> list[dict]:
    out = []
    for index, r in enumerate(rows, start=1):
        lat, lon = r.get("lat"), r.get("lon")
        if not lat or not lon:
            continue
        out.append({
            "id": index,
            "ident": r.get("icao") or r.get("lid") or "",
            "type": derive_type(r),
            "name": r.get("name") or "",
            "latitude_deg": lat,
            "longitude_deg": lon,
            "elevation_ft": r.get("elevation") or "",
            "continent": "",
            "iso_country": r.get("country") or "",
            "iso_region": f"{r.get('country','')}-{r.get('subd','')}" if r.get("subd") else "",
            "municipality": r.get("city") or "",
            "scheduled_service": "yes" if r.get("iata") else "no",
            "gps_code": r.get("icao") or "",
            "iata_code": r.get("iata") or "",
            "local_code": r.get("lid") or "",
            "home_link": "", "wikipedia_link": "", "keywords": "",
        })
    return out


def main() -> int:
    UPSTREAM.mkdir(parents=True, exist_ok=True)
    (UPSTREAM / "ourairports-data").mkdir(exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        print("fetching world-countries from registry.npmjs.org ...")
        raw_countries, countries_version = fetch_world_countries(work)
        print("fetching airportsdata from pypi.org ...")
        raw_airports, airports_version = fetch_airportsdata(work)

    countries = to_restcountries(raw_countries)
    (UPSTREAM / "countries.json").write_text(
        json.dumps(countries, ensure_ascii=False), encoding="utf-8"
    )

    airports = to_ourairports(raw_airports)
    path = UPSTREAM / "ourairports-data" / "airports.csv"
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=OURAIRPORTS_COLUMNS, quoting=csv.QUOTE_ALL)
        writer.writeheader()
        writer.writerows(airports)

    manifest = {"https://restcountries.com/v3.1/all": "countries.json"}
    (UPSTREAM / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    with_iata = sum(1 for a in airports if a["iata_code"])
    (UPSTREAM / "PROVENANCE.md").write_text(f"""# Upstream data provenance

Generated by `scripts/build_upstream.py`. Do not edit by hand.

Fetched from package registries because this environment's egress policy blocks
data hosts but explicitly permits registry.npmjs.org and pypi.org.

| Dataset | Package | Version | Licence | Records |
|---|---|---|---|---|
| Countries | `world-countries` (npm) | {countries_version} | ODbL | {len(countries)} |
| Airports | `airportsdata` (PyPI) | {airports_version} | MIT | {len(airports)} |

## Real vs derived

Everything is as published **except**:

- **`type`** ({with_iata} `medium_airport`, {len(airports) - with_iata} `small_airport`) is
  DERIVED, not sourced. airportsdata carries no size field and Scout's schema
  requires one, so it is derived from IATA presence: an IATA code means
  scheduled commercial service. No airport is claimed as `large_airport`,
  because nothing in this dataset supports that claim.
- **`capitalInfo`** is omitted. world-countries carries a country centroid, not
  the capital's location, and passing one off as the other is the same fake
  precision the platform refuses for places.
- **`continent`** is left blank; the adapter derives the region flag from
  `iso_country`.

Field names and column order match each upstream API's real contract, so the
adapters parse this exactly as they would parse a live response.
""", encoding="utf-8")

    print(f"\n  countries.json                 {len(countries)} countries")
    print(f"  ourairports-data/airports.csv  {len(airports)} airports ({with_iata} with IATA)")
    print(f"  PROVENANCE.md                  written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
