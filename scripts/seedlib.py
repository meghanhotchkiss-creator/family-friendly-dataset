"""Shared helpers for loading, validating and exporting the seed data.

Standard library only, on purpose: the seed pipeline must run before anyone
installs the API's dependencies (pandas, fastapi, ...), otherwise you cannot
produce the dataset the API needs in order to start.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Iterable, List

REPO_ROOT = Path(__file__).resolve().parents[1]
SEED_DIR = REPO_ROOT / "data" / "seeds"
PROCESSED_DIR = REPO_ROOT / "data" / "processed"
DB_DIR = REPO_ROOT / "db"

DATASET_CSV = PROCESSED_DIR / "family_friendly_dataset.csv"
DATASET_JSON = PROCESSED_DIR / "family_friendly_dataset.json"
SQLITE_DB = PROCESSED_DIR / "scoutfox.db"
SEED_SQL = DB_DIR / "seed.sql"
SCHEMA_SQL = DB_DIR / "schema.sql"

# Column order of the generated CSV. `state`, `indoor_or_outdoor`, `name` and
# `type` are consumed directly by api/server.py, the bots and the dashboard --
# do not rename them without updating those callers.
ACTIVITY_COLUMNS = [
    "id",
    "name",
    "type",
    "category",
    "city",
    "state",
    "indoor_or_outdoor",
    "price_tier",
    "min_age",
    "max_age",
    "avg_duration_hours",
    "rating",
    "tags",
    "description",
]

# Controlled vocabularies. `category` values are the lemmas bots/nlu_parser.py
# extracts from user queries, plus a few extra buckets.
CATEGORIES = {
    "museum",
    "park",
    "zoo",
    "aquarium",
    "library",
    "beach",
    "landmark",
    "theme_park",
    "historic_site",
}
PRICE_TIERS = {"free", "$", "$$", "$$$"}
INDOOR_OUTDOOR = {"indoor", "outdoor"}
TIERS = {"free", "pro", "business"}

# States the dashboard selector and bots/nlu_parser.py know about.
SUPPORTED_STATES = {"CA", "TX", "FL", "NY", "AZ", "OH", "GA", "IL"}

SEED_FILES = (
    "activities",
    "users",
    "families",
    "trips",
    "feedback",
    "global_patterns",
    "points_ledger",
)

# Point values awarded per event, mirrored from api/points.py.
EVENT_POINTS = {
    "daily_checkin": 10,
    "affiliate_booking": 20,
    "upgrade_pro": 50,
    "upgrade_business": 100,
}


class SeedValidationError(Exception):
    """Raised when the seed files are internally inconsistent."""


def load_seed(name: str) -> List[Dict[str, Any]]:
    """Load one seed file by name (without the .json extension)."""
    path = SEED_DIR / f"{name}.json"
    if not path.exists():
        raise SeedValidationError(f"missing seed file: {path}")
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, list):
        raise SeedValidationError(f"{path.name} must contain a JSON array")
    return data


def load_all() -> Dict[str, List[Dict[str, Any]]]:
    """Load every seed file into a dict keyed by seed name."""
    return {name: load_seed(name) for name in SEED_FILES}


def _require(errors: List[str], cond: bool, message: str) -> None:
    if not cond:
        errors.append(message)


def validate(seeds: Dict[str, List[Dict[str, Any]]] | None = None) -> List[str]:
    """Validate the seed set and return a list of human-readable problems.

    An empty list means the seed data is consistent.
    """
    seeds = seeds or load_all()
    errors: List[str] = []

    activities = seeds["activities"]
    users = seeds["users"]
    families = seeds["families"]
    trips = seeds["trips"]
    feedback = seeds["feedback"]
    patterns = seeds["global_patterns"]
    ledger = seeds["points_ledger"]

    # ---- activities -----------------------------------------------------
    activity_ids = set()
    for row in activities:
        label = row.get("id", "<no id>")
        for field in ACTIVITY_COLUMNS:
            _require(errors, field in row, f"activity {label}: missing field {field!r}")
        if "id" in row:
            _require(errors, row["id"] not in activity_ids, f"duplicate activity id {label!r}")
            activity_ids.add(row["id"])
        _require(errors, row.get("category") in CATEGORIES,
                 f"activity {label}: unknown category {row.get('category')!r}")
        _require(errors, row.get("price_tier") in PRICE_TIERS,
                 f"activity {label}: unknown price_tier {row.get('price_tier')!r}")
        _require(errors, row.get("indoor_or_outdoor") in INDOOR_OUTDOOR,
                 f"activity {label}: indoor_or_outdoor must be indoor/outdoor, "
                 f"got {row.get('indoor_or_outdoor')!r}")
        _require(errors, row.get("state") in SUPPORTED_STATES,
                 f"activity {label}: state {row.get('state')!r} is not a supported state")
        _require(errors, isinstance(row.get("tags"), list),
                 f"activity {label}: tags must be a list")
        _require(errors, str(row.get("name", "")).strip() != "",
                 f"activity {label}: name must not be empty")
        min_age, max_age = row.get("min_age"), row.get("max_age")
        if isinstance(min_age, int) and isinstance(max_age, int):
            _require(errors, min_age <= max_age,
                     f"activity {label}: min_age {min_age} > max_age {max_age}")
        rating = row.get("rating")
        if isinstance(rating, (int, float)):
            _require(errors, 0 <= rating <= 5, f"activity {label}: rating {rating} out of range")

    # Every supported state needs results, or /recommend returns an empty list.
    covered = {row.get("state") for row in activities}
    for state in sorted(SUPPORTED_STATES - covered):
        errors.append(f"state {state} has no seeded activities")

    # Each state needs both indoor and outdoor rows so the filters are useful.
    for state in sorted(SUPPORTED_STATES & covered):
        for mode in sorted(INDOOR_OUTDOOR):
            hits = [r for r in activities
                    if r.get("state") == state and r.get("indoor_or_outdoor") == mode]
            _require(errors, bool(hits), f"state {state} has no {mode} activities")

    # ---- users ----------------------------------------------------------
    seen_keys = set()
    for user in users:
        key = user.get("api_key", "<no api_key>")
        _require(errors, key not in seen_keys, f"duplicate api_key {key!r}")
        seen_keys.add(key)
        _require(errors, user.get("tier") in TIERS,
                 f"user {key}: unknown tier {user.get('tier')!r}")
        _require(errors, isinstance(user.get("points"), int) and user.get("points", -1) >= 0,
                 f"user {key}: points must be a non-negative integer")

    # ---- families / trips / feedback ------------------------------------
    family_ids = set()
    for family in families:
        fid = family.get("family_id")
        _require(errors, fid not in family_ids, f"duplicate family_id {fid!r}")
        family_ids.add(fid)
        _require(errors, isinstance(family.get("members"), list) and family["members"],
                 f"family {fid}: members must be a non-empty list")

    for user in users:
        fid = user.get("family_id")
        _require(errors, fid in family_ids,
                 f"user {user.get('api_key')!r}: family_id {fid!r} has no matching family")

    trip_ids = set()
    for trip in trips:
        tid = trip.get("trip_id")
        _require(errors, tid not in trip_ids, f"duplicate trip_id {tid!r}")
        trip_ids.add(tid)
        _require(errors, trip.get("family_id") in family_ids,
                 f"trip {tid}: family_id {trip.get('family_id')!r} has no matching family")
        _require(errors, trip.get("start_date", "") <= trip.get("end_date", ""),
                 f"trip {tid}: start_date is after end_date")
        for day in trip.get("itinerary", {}).get("days", []):
            for entry in day.get("activities", []):
                _require(errors, entry.get("activity_id") in activity_ids,
                         f"trip {tid} day {day.get('day')}: unknown activity_id "
                         f"{entry.get('activity_id')!r}")

    seen_feedback = set()
    for item in feedback:
        fbid = item.get("feedback_id")
        _require(errors, fbid not in seen_feedback, f"duplicate feedback_id {fbid!r}")
        seen_feedback.add(fbid)
        _require(errors, item.get("trip_id") in trip_ids,
                 f"feedback {fbid}: trip_id {item.get('trip_id')!r} has no matching trip")
        _require(errors, item.get("family_id") in family_ids,
                 f"feedback {fbid}: family_id {item.get('family_id')!r} has no matching family")
        rating = item.get("rating")
        _require(errors, isinstance(rating, int) and 1 <= rating <= 5,
                 f"feedback {fbid}: rating must be an integer 1-5, got {rating!r}")

    # Feedback must point at a trip that belongs to the same family, otherwise
    # the Postgres foreign keys are satisfied but the row is nonsense.
    trip_owner = {t.get("trip_id"): t.get("family_id") for t in trips}
    for item in feedback:
        tid = item.get("trip_id")
        if tid in trip_owner:
            _require(errors, trip_owner[tid] == item.get("family_id"),
                     f"feedback {item.get('feedback_id')}: trip {tid} belongs to family "
                     f"{trip_owner[tid]}, not {item.get('family_id')}")

    # ---- points ledger ---------------------------------------------------
    seen_entries = set()
    balances: Dict[str, int] = {}
    for entry in ledger:
        eid = entry.get("entry_id")
        _require(errors, eid not in seen_entries, f"duplicate ledger entry_id {eid!r}")
        seen_entries.add(eid)
        key = entry.get("api_key")
        _require(errors, key in seen_keys,
                 f"ledger {eid}: api_key {key!r} has no matching user")
        points = entry.get("points")
        _require(errors, isinstance(points, int), f"ledger {eid}: points must be an integer")
        event = entry.get("event")
        if event in EVENT_POINTS:
            _require(errors, points == EVENT_POINTS[event],
                     f"ledger {eid}: event {event!r} should award "
                     f"{EVENT_POINTS[event]} points, got {points!r}")
        elif event == "redeem":
            _require(errors, isinstance(points, int) and points < 0,
                     f"ledger {eid}: redeem entries must be negative, got {points!r}")
        else:
            errors.append(f"ledger {eid}: unknown event {event!r}")
        activity_id = entry.get("activity_id")
        if activity_id is not None:
            _require(errors, activity_id in activity_ids,
                     f"ledger {eid}: unknown activity_id {activity_id!r}")
        if isinstance(points, int) and key is not None:
            balances[key] = balances.get(key, 0) + points

    # A user's stored balance must equal the sum of their ledger, otherwise
    # /points_balance and /points_history tell the user two different stories.
    for user in users:
        key = user.get("api_key")
        expected = balances.get(key, 0)
        _require(errors, user.get("points") == expected,
                 f"user {key!r}: points {user.get('points')!r} does not match "
                 f"ledger total {expected}")

    # ---- global patterns -------------------------------------------------
    seen_patterns = set()
    for pattern in patterns:
        pid = pattern.get("pattern_id")
        _require(errors, pid not in seen_patterns, f"duplicate pattern_id {pid!r}")
        seen_patterns.add(pid)
        _require(errors, isinstance(pattern.get("top_destinations"), list)
                 and bool(pattern.get("top_destinations")),
                 f"pattern {pid}: top_destinations must be a non-empty list")
        _require(errors, isinstance(pattern.get("seasonal_preferences"), dict),
                 f"pattern {pid}: seasonal_preferences must be an object")

    return errors


def validate_or_raise(seeds: Dict[str, List[Dict[str, Any]]] | None = None) -> None:
    """Validate and raise SeedValidationError listing every problem found."""
    errors = validate(seeds)
    if errors:
        joined = "\n  - ".join(errors)
        raise SeedValidationError(f"{len(errors)} seed problem(s):\n  - {joined}")


def activity_to_row(activity: Dict[str, Any]) -> Dict[str, Any]:
    """Flatten one activity into the CSV row shape (tags become 'a;b;c')."""
    row = {column: activity.get(column, "") for column in ACTIVITY_COLUMNS}
    row["tags"] = ";".join(activity.get("tags", []))
    return row


def iter_activity_rows(activities: Iterable[Dict[str, Any]]) -> Iterable[Dict[str, Any]]:
    for activity in activities:
        yield activity_to_row(activity)
