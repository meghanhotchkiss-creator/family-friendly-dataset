#!/usr/bin/env python3
"""Generate a synthetic activity dataset for development and testing.

The output is FICTIONAL. Every venue name, address and price is invented. It
exists so the API and recommender can be exercised without real data, and so
that failures show up in development rather than in front of a family.

It is written to data/seed/ rather than to the production path that
FAMILY_DATASET_URL defaults to, specifically so it cannot quietly become "the
dataset". Point FAMILY_DATASET_URL at it deliberately:

    FAMILY_DATASET_URL=data/seed/family_friendly_seed.csv uvicorn server:app

Deterministic: the same seed always produces the same file.
"""

import csv
import random
from pathlib import Path

SEED = 20260819
OUT = Path(__file__).resolve().parents[1] / "data" / "seed" / "family_friendly_seed.csv"

# Markets deliberately span several states, timezones and one non-US entry, so
# that logic which assumes a single market or a two-letter US state fails here
# rather than in production.
MARKETS = [
    ("Jacksonville", "FL"), ("Orlando", "FL"), ("Miami", "FL"),
    ("New York", "NY"), ("Brooklyn", "NY"),
    ("Boston", "MA"), ("Chicago", "IL"), ("Austin", "TX"),
    ("Denver", "CO"), ("Nashville", "TN"), ("Seattle", "WA"),
    ("San Francisco", "CA"), ("Los Angeles", "CA"),
    ("Washington", "DC"),
    ("London", "Greater London"),   # non-US: not a 2-letter state
    ("Toronto", "Ontario"),
]

CATEGORIES = [
    ("Playground", "outdoor", 0, 10, (0, 0)),
    ("Nature trail", "outdoor", 3, 99, (0, 8)),
    ("Splash pad", "outdoor", 1, 12, (0, 5)),
    ("Botanical garden", "outdoor", 0, 99, (5, 22)),
    ("Zoo", "outdoor", 0, 99, (12, 34)),
    ("Science museum", "indoor", 4, 99, (9, 28)),
    ("Children's museum", "indoor", 1, 10, (8, 24)),
    ("Aquarium", "indoor", 0, 99, (14, 39)),
    ("Indoor play centre", "indoor", 0, 8, (6, 19)),
    ("Public library", "indoor", 0, 99, (0, 0)),
    ("Art gallery", "indoor", 6, 99, (0, 25)),
    ("Climbing gym", "indoor", 5, 99, (11, 30)),
]

QUALIFIERS = [
    "Riverside", "Northgate", "Old Mill", "Cedar Hollow", "Fair Oaks",
    "Harbourview", "Lantern Hill", "Alder Creek", "Bramble Court",
    "Sunnyfield", "Kingsway", "Willow Bend", "Copper Ridge", "Ashgrove",
]


def build_rows():
    rng = random.Random(SEED)
    rows = []
    activity_id = 1

    for city, state in MARKETS:
        for category, setting, min_age, max_age, (lo, hi) in CATEGORIES:
            # Not every market gets every category -- a uniform grid would hide
            # bugs that only appear when a filter returns nothing.
            if rng.random() < 0.28:
                continue

            qualifier = rng.choice(QUALIFIERS)
            price = 0 if lo == hi == 0 else rng.randint(lo, hi)

            rows.append({
                "activity_id": f"seed-{activity_id:04d}",
                "name": f"{qualifier} {category}",
                "city": city,
                "state": state,
                "indoor_or_outdoor": setting,
                "min_age": min_age,
                "max_age": max_age,
                "price_usd": price,
                "duration_minutes": rng.choice([45, 60, 90, 120, 180]),
                "category": category,
                "description": f"Fictional {category.lower()} in {city}. Seed data, not a real venue.",
                "source": "synthetic-seed",
                "is_seed_data": "true",
            })
            activity_id += 1

    return rows


def main():
    rows = build_rows()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {len(rows)} rows to {OUT}")
    states = sorted({r['state'] for r in rows})
    print(f"{len(states)} states/regions: {', '.join(states)}")


if __name__ == "__main__":
    main()
