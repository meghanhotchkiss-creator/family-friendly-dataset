"""The curated seed source.

Reads `data/seed/curated_activities.csv`, a hand-written list of long-lived
public attractions. It exists so the API returns real rows before any
third-party account has been opened -- the state the project was in when this
was written was an API with no data behind it at all.

Rows carry `verified=false` until a human checks them. Names, states, and
categories are reliable; URLs and age bands are best-effort.
"""
from __future__ import annotations

import csv
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .base import ActivityProvider, ProviderError

SEED_PATH = Path(__file__).resolve().parents[2] / "data" / "seed" / "curated_activities.csv"


class SeedProvider(ActivityProvider):
    name = "seed_curated"
    description = "Hand-curated public attractions. No credentials required."

    def __init__(self, path: Path = SEED_PATH):
        self.path = path

    def available(self) -> bool:
        return self.path.exists()

    def unavailable_reason(self) -> str:
        return f"seed file not found at {self.path}"

    def fetch(self, states: Optional[Iterable[str]] = None) -> List[Dict[str, Any]]:
        if not self.path.exists():
            raise ProviderError(f"seed file not found at {self.path}")

        wanted = {s.strip().upper() for s in states} if states else None

        with self.path.open(newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))

        if not rows:
            raise ProviderError(f"seed file {self.path} is empty")

        if wanted:
            rows = [r for r in rows if str(r.get("state", "")).upper() in wanted]

        return rows
