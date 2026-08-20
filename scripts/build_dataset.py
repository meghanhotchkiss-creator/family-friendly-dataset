#!/usr/bin/env python3
"""Build the processed activity dataset the API and bots read.

Reads data/seeds/activities.json and writes:

    data/processed/family_friendly_dataset.csv   <- what api/server.py loads
    data/processed/family_friendly_dataset.json  <- same rows, for JS consumers

The seed data is validated first, so a broken seed file fails here rather than
at API request time.

    python scripts/build_dataset.py
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from seedlib import (  # noqa: E402
    ACTIVITY_COLUMNS,
    DATASET_CSV,
    DATASET_JSON,
    PROCESSED_DIR,
    SeedValidationError,
    iter_activity_rows,
    load_all,
    validate_or_raise,
)


def build(skip_validation: bool = False) -> int:
    seeds = load_all()
    if not skip_validation:
        validate_or_raise(seeds)

    activities = seeds["activities"]
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

    with DATASET_CSV.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=ACTIVITY_COLUMNS)
        writer.writeheader()
        for row in iter_activity_rows(activities):
            writer.writerow(row)

    DATASET_JSON.write_text(
        json.dumps(activities, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    print(f"wrote {len(activities)} activities")
    print(f"  {DATASET_CSV}")
    print(f"  {DATASET_JSON}")
    return len(activities)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--skip-validation",
        action="store_true",
        help="build even if the seed files fail validation (not recommended)",
    )
    args = parser.parse_args()

    try:
        build(skip_validation=args.skip_validation)
    except SeedValidationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
