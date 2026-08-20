#!/usr/bin/env python3
"""Record OurAirports transport fixtures from the vendored files.

The fixtures are REAL rows, sliced -- not hand-written approximations. A test
that runs against invented data proves the test, not the pipeline, so every
fixture here is a verbatim subset of what `build_upstream.py` fetched, kept
small enough to commit.

    python scripts/build_upstream.py && python scripts/record_fixtures.py
"""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "data" / "upstream" / "ourairports-data"
OUT = REPO / "scout" / "connectors" / "fixtures"

# The nine countries data:validate asserts on, plus the handful the older
# fixtures already covered so nothing that passed before starts failing.
COUNTRIES = ["GB", "FR", "JP", "AU", "ZA", "US", "CA", "BR", "IN"]
# Chosen so the slice covers all eight travel regions, which the connector
# tests assert on: NA (US CA MX), CA (PA CR JM), SA (BR), EU (GB FR IT ES DE NL),
# ME (AE), AF (ZA KE), AS (JP KR SG IN), OC (AU NZ).
EXTRA_COUNTRIES = ["MX", "PA", "CR", "JM", "IT", "ES", "DE", "NL", "KR", "SG", "AE", "KE", "NZ"]
PER_COUNTRY = 6

# Airports the tests assert on by name. Slicing purely by size and ident order
# is arbitrary enough to drop Heathrow, which makes a failing test read like a
# pipeline bug rather than a fixture that happens not to contain it.
ANCHORS = ["EGLL", "LFPG", "RJTT", "YSSY", "FAOR", "KATL", "KSFO", "CYYZ", "SBGR", "VIDP"]


def fixture_name(path: str) -> str:
    slug = path.replace("/", "-").replace(".", "-").strip("-")
    return f"davidmegginson-github-io__{slug}.json"


def write(path: str, header: list[str], rows: list[dict]) -> None:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=header, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    target = OUT / fixture_name(path)
    target.write_text(
        json.dumps(
            {"status": 200, "headers": {"content-type": "text/csv; charset=utf-8"}, "bodyText": buf.getvalue()},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"  {target.name:<62} {len(rows):>5} rows")


def read(name: str) -> tuple[list[str], list[dict]]:
    with (SRC / name).open(encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        return list(reader.fieldnames or []), list(reader)


def main() -> int:
    if not SRC.exists():
        raise SystemExit("error: run scripts/build_upstream.py first")

    wanted = COUNTRIES + EXTRA_COUNTRIES
    print("recording OurAirports fixtures")

    a_header, airports = read("airports.csv")
    picked: list[dict] = []
    for iso in wanted:
        rows = [r for r in airports if r["iso_country"] == iso]
        # Biggest first, so every country contributes an airport a traveller has
        # heard of as well as the small fields that stress the resolvers.
        order = {"large_airport": 0, "medium_airport": 1, "small_airport": 2,
                 "heliport": 3, "seaplane_base": 4, "balloonport": 5, "closed": 6}
        rows.sort(key=lambda r: (r["ident"] not in ANCHORS, order.get(r["type"], 9), r["ident"]))
        picked.extend(rows[:PER_COUNTRY])
    missing = [a for a in ANCHORS if a not in {r["ident"] for r in picked}]
    if missing:
        raise SystemExit(f"error: anchor airports missing from the slice: {missing}")
    write("ourairports-data/airports.csv", a_header, picked)

    idents = {r["ident"] for r in picked}
    regions_used = {r["iso_region"] for r in picked if r["iso_region"]}

    c_header, countries = read("countries.csv")
    write("ourairports-data/countries.csv", c_header, [r for r in countries if r["code"] in wanted])

    r_header, regions = read("regions.csv")
    write("ourairports-data/regions.csv", r_header,
          [r for r in regions if r["code"] in regions_used or r["iso_country"] in COUNTRIES])

    # The SourceMesh country spec requests the bare URL; the older geography
    # provider requests it with a `fields=` query, so the two fixtures are
    # different files and neither shadows the other.
    countries_json = json.loads((REPO / "data" / "upstream" / "countries.json").read_text(encoding="utf-8"))
    sliced = [c for c in countries_json if c.get("cca2") in wanted]
    target = OUT / "restcountries-com__v3-1-all.json"
    target.write_text(
        json.dumps(
            {"status": 200, "headers": {"content-type": "application/json"}, "body": sliced},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"  {target.name:<62} {len(sliced):>5} rows")

    for name, key in (("runways.csv", "airport_ident"),
                      ("airport-frequencies.csv", "airport_ident"),
                      ("navaids.csv", "associated_airport")):
        header, rows = read(name)
        write(f"ourairports-data/{name}", header, [r for r in rows if r[key] in idents])

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
