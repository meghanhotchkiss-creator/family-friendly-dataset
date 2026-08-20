#!/usr/bin/env python3
"""Validate the JSON seed files in data/seeds/.

Exits non-zero and prints every problem found, so it can be wired into CI.

    python scripts/validate_seeds.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from seedlib import SEED_FILES, SeedValidationError, load_all, validate  # noqa: E402


def main() -> int:
    try:
        seeds = load_all()
    except SeedValidationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    errors = validate(seeds)
    for error in errors:
        print(f"error: {error}", file=sys.stderr)

    if errors:
        print(f"\n{len(errors)} problem(s) found.", file=sys.stderr)
        return 1

    counts = ", ".join(f"{len(seeds[name])} {name}" for name in SEED_FILES)
    print(f"seed data OK: {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
