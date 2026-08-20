"""Read the JSON seed files that ship in data/seeds/.

Standard library only and never raises: if the seed files are missing or
malformed the API still starts, falling back to whatever default the caller
supplies. Point the loader somewhere else with FAMILY_SEED_DIR.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SEED_DIR = REPO_ROOT / "data" / "seeds"
SEED_DIR = Path(os.getenv("FAMILY_SEED_DIR", str(DEFAULT_SEED_DIR)))


def load_seed(name: str, default: Any = None) -> Any:
    """Load data/seeds/<name>.json, returning `default` if it is unusable."""
    path = SEED_DIR / f"{name}.json"
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default if default is not None else []


def load_users() -> List[Dict[str, Any]]:
    return load_seed("users", [])


def load_points_ledger() -> List[Dict[str, Any]]:
    return load_seed("points_ledger", [])


def user_tiers() -> Dict[str, str]:
    """api_key -> tier, for every seeded user."""
    return {
        user["api_key"]: user["tier"]
        for user in load_users()
        if user.get("api_key") and user.get("tier")
    }


def user_display_names() -> Dict[str, str]:
    """api_key -> human-readable name, for the leaderboard."""
    return {
        user["api_key"]: user.get("display_name", user["api_key"])
        for user in load_users()
        if user.get("api_key")
    }


def points_by_user() -> Dict[str, int]:
    """api_key -> starting points balance."""
    return {
        user["api_key"]: int(user.get("points", 0))
        for user in load_users()
        if user.get("api_key")
    }


def history_by_user() -> Dict[str, List[Dict[str, Any]]]:
    """api_key -> chronological points history, in the shape /points_history returns."""
    history: Dict[str, List[Dict[str, Any]]] = {key: [] for key in points_by_user()}
    entries = sorted(
        load_points_ledger(),
        key=lambda entry: (str(entry.get("created_at", "")), entry.get("entry_id", 0)),
    )
    for entry in entries:
        key = entry.get("api_key")
        if key is None:
            continue
        item: Dict[str, Any] = {
            "event": entry.get("event"),
            "points": entry.get("points", 0),
            "date": entry.get("created_at"),
        }
        if entry.get("activity_id"):
            item["activity_id"] = entry["activity_id"]
        if entry.get("note"):
            item["note"] = entry["note"]
        history.setdefault(key, []).append(item)
    return history
