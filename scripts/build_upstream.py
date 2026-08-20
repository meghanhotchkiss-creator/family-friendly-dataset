#!/usr/bin/env python3
"""Fetch real upstream datasets into data/upstream/.

    python scripts/build_upstream.py
    SCOUT_TRANSPORT=offline npm run travel:import:all

Sources
-------
world-countries (npm)         the dataset restcountries.com serves; ODbL
ourairports-data (GitHub)     the daily OurAirports dump, all six files; public domain
geonamescache (PyPI)          GeoNames cities15000; CC BY 4.0
opentraveldata (GitHub)       points of reference; CC BY 4.0

This environment's egress policy blocks most data hosts but permits
registry.npmjs.org, pypi.org and github.com, so each dataset is taken from
whichever of those actually publishes it. That is a sanctioned channel, not a
way around the policy; anything still unreachable is recorded in scout/BLOCKED.md
rather than faked.

Every file is stored as published. See PROVENANCE.md for the two deliberate
omissions and why region flags are not taken from the OurAirports continent.
"""
from __future__ import annotations

import json
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


# The six files OurAirports publishes daily. `airports` is the spine; `regions`
# is what turns an `iso_region` code such as `US-PA` into a name; the rest are
# per-airport detail that nothing else in the open-data stack carries.
OURAIRPORTS_FILES = (
    "airports.csv",
    "countries.csv",
    "regions.csv",
    "runways.csv",
    "airport-frequencies.csv",
    "navaids.csv",
)


def fetch_ourairports(work: Path) -> tuple[dict[str, str], str]:
    """The real OurAirports daily dump, from the public repo (public domain).

    This replaces an earlier reconstruction from the `airportsdata` PyPI wheel,
    which carried ~28k airports, no region codes, no runways, and needed the
    `type` column to be DERIVED from IATA presence. Nothing here is derived.
    """
    run(["git", "clone", "--depth", "1",
         "https://github.com/davidmegginson/ourairports-data.git", "oad"], work)
    repo = work / "oad"
    sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=repo,
                         capture_output=True, text=True).stdout.strip()
    return {name: (repo / name).read_text(encoding="utf-8") for name in OURAIRPORTS_FILES}, sha


def fetch_geonames(work: Path) -> tuple[dict, str]:
    """GeoNames cities15000 via the geonamescache package (CC BY 4.0)."""
    run([sys.executable, "-m", "pip", "download", "geonamescache", "--no-deps", "-d", "gn"], work)
    wheel = next((work / "gn").glob("geonamescache-*.whl"))
    version = wheel.name.split("-")[1]
    with zipfile.ZipFile(wheel) as zf:
        with zf.open("geonamescache/data/cities15000.json") as fh:
            cities = json.load(fh)
    return cities, version


def fetch_optd(work: Path) -> tuple[str, str]:
    """OpenTravelData points of reference (CC BY 4.0), from the public repo."""
    run(["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse",
         "https://github.com/opentraveldata/opentraveldata.git", "optd"], work)
    repo = work / "optd"
    run(["git", "sparse-checkout", "set", "opentraveldata"], repo)
    csv_path = repo / "opentraveldata" / "optd_por_public.csv"
    sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=repo,
                         capture_output=True, text=True).stdout.strip()
    return csv_path.read_text(encoding="utf-8"), sha


def main() -> int:
    UPSTREAM.mkdir(parents=True, exist_ok=True)
    (UPSTREAM / "ourairports-data").mkdir(exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        print("fetching world-countries from registry.npmjs.org ...")
        raw_countries, countries_version = fetch_world_countries(work)
        print("fetching ourairports-data from github.com ...")
        ourairports, ourairports_sha = fetch_ourairports(work)
        print("fetching geonamescache from pypi.org ...")
        raw_cities, cities_version = fetch_geonames(work)
        print("fetching opentraveldata from github.com ...")
        optd_csv, optd_sha = fetch_optd(work)

    countries = to_restcountries(raw_countries)
    (UPSTREAM / "countries.json").write_text(
        json.dumps(countries, ensure_ascii=False), encoding="utf-8"
    )

    # Verbatim, byte for byte. The engine's whole claim is that a spec adapts to
    # the feed, so the feed must not be pre-adapted to the engine.
    for name, text in ourairports.items():
        (UPSTREAM / "ourairports-data" / name).write_text(text, encoding="utf-8")

    # GeoNames ships a map keyed by geonameid; keep it verbatim so SourceMesh
    # has to cope with a third record shape rather than a pre-flattened list.
    (UPSTREAM / "geonames-cities15000.json").write_text(
        json.dumps(raw_cities, ensure_ascii=False), encoding="utf-8"
    )

    (UPSTREAM / "optd_por_public.csv").write_text(optd_csv, encoding="utf-8")

    manifest = {
        "https://restcountries.com/v3.1/all": "countries.json",
        "https://raw.githubusercontent.com/opentraveldata/opentraveldata/master/opentraveldata/optd_por_public.csv": "optd_por_public.csv",
        "https://download.geonames.org/export/dump/cities15000": "geonames-cities15000.json",
    }
    for name in OURAIRPORTS_FILES:
        manifest[f"https://davidmegginson.github.io/ourairports-data/{name}"] = f"ourairports-data/{name}"
    (UPSTREAM / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    def rows(name: str) -> int:
        return max(0, ourairports[name].count(chr(10)) - 1)

    oad_table = "\n".join(
        f"| OurAirports `{name}` | ourairports-data (GitHub) | {ourairports_sha} | Public domain | {rows(name):,} |"
        for name in OURAIRPORTS_FILES
    )

    (UPSTREAM / "PROVENANCE.md").write_text(f"""# Upstream data provenance

Generated by `scripts/build_upstream.py`. Do not edit by hand.

| Dataset | Package | Version | Licence | Records |
|---|---|---|---|---|
| Countries | `world-countries` (npm) | {countries_version} | ODbL | {len(countries)} |
{oad_table}
| Cities | `geonamescache` (PyPI) | {cities_version} | CC BY 4.0 | {len(raw_cities)} |
| Points of reference | `opentraveldata` (GitHub) | {optd_sha} | CC BY 4.0 | {optd_csv.count(chr(10))} |

## Real vs derived

The six OurAirports files are stored **byte for byte as published**. Nothing in
them is derived, inferred or reconstructed.

This is a change: airports previously came from the `airportsdata` PyPI wheel,
which carried ~28k airports and no size column, so `type` had to be derived from
IATA presence. That derivation is gone -- `type`, `iso_region`, `elevation_ft`
and the runway/frequency/navaid detail are now all sourced.

Two things are still deliberately omitted rather than guessed:

- **`capitalInfo`** is dropped from the country feed. world-countries carries a
  country centroid, not the capital's location, and passing one off as the other
  is the same fake precision the platform refuses for places.
- **Region flags** (NA CA SA EU ME AF AS OC) are resolved from the
  world-countries subregion, *not* from the OurAirports `continent` column. They
  are different vocabularies: OurAirports has no Central America or Middle East
  and does have Antarctica. Using its continent would silently file Jamaica
  under North America and Jordan under Asia.

## Country roster

`ourairports-data/countries.csv` is vendored but is **not** the country
authority: it carries no ISO-3 code and no currency, both of which the schema
requires. It is used as an independent roster -- `npm run data:validate`
reports any country it lists that the country table does not have.
""", encoding="utf-8")

    print(f"\n  countries.json                 {len(countries)} countries")
    for name in OURAIRPORTS_FILES:
        print(f"  ourairports-data/{name:<22} {rows(name):>7,} rows")
    print(f"  geonames-cities15000.json      {len(raw_cities)} cities")
    print(f"  optd_por_public.csv            {optd_csv.count(chr(10))} points of reference")
    print(f"  PROVENANCE.md                  written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
