#!/usr/bin/env python3
"""Build data/processed/family_friendly_dataset.csv from the registered providers.

    python scripts/build_dataset.py --list-sources
    python scripts/build_dataset.py                       # seed only, no keys needed
    python scripts/build_dataset.py --source seed_curated,nps
    python scripts/build_dataset.py --source nps --states CA,TX,FL
    python scripts/build_dataset.py --check               # validate, write nothing

This replaces the three scripts recovered from `family-friendly-dataset.zip`
(`fetch_public.py`, `fetch_places.py`, `clean_merge.py`), which were never
merged into the repository and never run. Those wrote inconsistent column
names, only ever merged libraries, and pointed at a URL that does not resolve.

A provider whose credentials are missing is skipped with a message rather than
failing the build, so this works before every account exists.
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path
from typing import Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from api.providers import (  # noqa: E402  (path set above)
    COLUMNS,
    REGISTRY,
    ProviderError,
    dedupe_key,
    get_provider,
)

DEFAULT_OUTPUT = REPO_ROOT / "data" / "processed" / "family_friendly_dataset.csv"


def collect(sources: List[str], states: Optional[List[str]]) -> List[Dict[str, str]]:
    """Run each source, keeping the first provider to report a given place."""
    merged: Dict[str, Dict[str, str]] = {}
    counts: Dict[str, int] = {}

    for source in sources:
        provider = get_provider(source)

        if not provider.available():
            print(f"- {source}: skipped -- {provider.unavailable_reason()}")
            counts[source] = 0
            continue

        print(f"- {source}: fetching...")
        try:
            rows = provider.rows(states)
        except ProviderError as exc:
            print(f"- {source}: skipped -- {exc}")
            counts[source] = 0
            continue
        except Exception as exc:  # noqa: BLE001 -- one source must not kill the build
            print(f"- {source}: FAILED -- {type(exc).__name__}: {exc}")
            counts[source] = 0
            continue

        kept = 0
        for row in rows:
            key = dedupe_key(row)
            if key in merged:
                continue
            merged[key] = row
            kept += 1

        counts[source] = kept
        duplicates = len(rows) - kept
        suffix = f" ({duplicates} already seen)" if duplicates else ""
        print(f"- {source}: {kept} new rows{suffix}")

    print()
    for source, count in counts.items():
        print(f"  {source:>14}: {count}")
    print(f"  {'TOTAL':>14}: {len(merged)}")

    # Stable output: same inputs produce a byte-identical file, so a scheduled
    # rebuild that changes nothing produces no diff.
    return sorted(merged.values(), key=lambda r: (r["state"], r["name"]))


def write_csv(rows: List[Dict[str, str]], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)

    extra = sorted({key for row in rows for key in row} - set(COLUMNS))
    fieldnames = list(COLUMNS) + extra

    with output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key, "") for key in fieldnames})


def summarise(rows: List[Dict[str, str]]) -> None:
    states = sorted({row["state"] for row in rows})
    verified = sum(1 for row in rows if row.get("verified") == "true")

    by_type: Dict[str, int] = {}
    for row in rows:
        by_type[row.get("type", "other")] = by_type.get(row.get("type", "other"), 0) + 1

    print(f"\nStates covered ({len(states)}): {', '.join(states)}")
    print(f"Verified rows: {verified}/{len(rows)}")
    print("By type: " + ", ".join(f"{k}={v}" for k, v in sorted(by_type.items())))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--source",
        default="seed_curated",
        help="comma-separated provider names, in precedence order (default: seed_curated)",
    )
    parser.add_argument("--states", default="", help="comma-separated 2-letter codes; default all")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--check", action="store_true", help="validate without writing")
    parser.add_argument("--list-sources", action="store_true")
    args = parser.parse_args()

    if args.list_sources:
        print("Available sources:\n")
        for name, provider in REGISTRY.items():
            status = "ready" if provider.available() else provider.unavailable_reason()
            print(f"  {name:<14} {provider.description}")
            print(f"  {'':<14} status: {status}\n")
        return 0

    sources = [s.strip() for s in args.source.split(",") if s.strip()]
    states = [s.strip().upper() for s in args.states.split(",") if s.strip()] or None

    unknown = [s for s in sources if s not in REGISTRY]
    if unknown:
        parser.error(f"unknown source(s): {', '.join(unknown)}. Try --list-sources")

    print(f"Building from: {', '.join(sources)}")
    if states:
        print(f"States: {', '.join(states)}")
    print()

    rows = collect(sources, states)

    if not rows:
        print("\nNo rows produced. The dataset was NOT overwritten.", file=sys.stderr)
        return 1

    summarise(rows)

    if args.check:
        print("\n--check: validated, nothing written.")
        return 0

    write_csv(rows, args.output)
    print(f"\nWrote {len(rows)} rows to {args.output.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
