"""Tests for the seed data pipeline.

Standard library only, so this suite runs on a bare checkout:

    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import ast
import csv
import json
import re
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))
sys.path.insert(0, str(REPO_ROOT / "api"))

import seedlib  # noqa: E402
import seed_db  # noqa: E402
import seed_loader  # noqa: E402


def parse_schema(path: Path) -> dict:
    """Extract {table: [column, ...]} from a CREATE TABLE script."""
    text = path.read_text(encoding="utf-8")
    tables = {}
    non_columns = {"check", "constraint", "primary", "foreign", "unique", "--"}
    for match in re.finditer(r"CREATE TABLE (\w+) \((.*?)\n\);", text, re.DOTALL):
        name, body = match.group(1), match.group(2)
        columns = []
        for line in body.splitlines():
            line = line.strip()
            if not line or line.startswith("--"):
                continue
            first = line.split()[0].lower()
            if first in non_columns:
                continue
            columns.append(line.split()[0])
        tables[name] = columns
    return tables


class TestSeedFiles(unittest.TestCase):
    def test_every_seed_file_exists_and_is_a_json_array(self):
        for name in seedlib.SEED_FILES:
            with self.subTest(seed=name):
                rows = seedlib.load_seed(name)
                self.assertIsInstance(rows, list)
                self.assertTrue(rows, f"{name}.json is empty")

    def test_seeds_validate_cleanly(self):
        errors = seedlib.validate()
        self.assertEqual(errors, [], "\n".join(errors))

    def test_validation_actually_catches_a_broken_seed(self):
        seeds = seedlib.load_all()
        seeds["trips"][0]["itinerary"]["days"][0]["activities"][0]["activity_id"] = "zz-999"
        errors = seedlib.validate(seeds)
        self.assertTrue(any("zz-999" in error for error in errors), errors)

    def test_validation_catches_a_balance_that_does_not_reconcile(self):
        seeds = seedlib.load_all()
        seeds["users"][0]["points"] += 5
        errors = seedlib.validate(seeds)
        self.assertTrue(any("ledger total" in error for error in errors), errors)


class TestActivityCoverage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.activities = seedlib.load_seed("activities")

    def test_every_supported_state_has_indoor_and_outdoor_options(self):
        for state in sorted(seedlib.SUPPORTED_STATES):
            for mode in ("indoor", "outdoor"):
                with self.subTest(state=state, mode=mode):
                    hits = [a for a in self.activities
                            if a["state"] == state and a["indoor_or_outdoor"] == mode]
                    self.assertTrue(hits, f"no {mode} activities for {state}")

    def test_states_match_the_ones_the_bots_can_parse(self):
        """bots/nlu_parser.py maps state names to abbreviations; seeds must cover them."""
        source = (REPO_ROOT / "bots" / "nlu_parser.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        states = None
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == "STATES" for t in node.targets
            ):
                states = ast.literal_eval(node.value)
        self.assertIsNotNone(states, "could not find STATES in bots/nlu_parser.py")
        seeded = {a["state"] for a in self.activities}
        self.assertEqual(set(states.values()) - seeded, set(),
                         "nlu_parser can parse states that have no seeded activities")

    def test_categories_cover_the_bot_query_vocabulary(self):
        """Categories the NLU parser extracts should exist in the data."""
        seeded = {a["category"] for a in self.activities}
        for category in ("park", "museum", "library", "zoo", "aquarium"):
            with self.subTest(category=category):
                self.assertIn(category, seeded)

    def test_activity_ids_are_unique_and_prefixed_by_state(self):
        seen = set()
        for activity in self.activities:
            self.assertNotIn(activity["id"], seen)
            seen.add(activity["id"])
            self.assertTrue(
                activity["id"].startswith(activity["state"].lower() + "-"),
                f"{activity['id']} does not match state {activity['state']}",
            )


class TestDatasetBuild(unittest.TestCase):
    def test_csv_matches_the_seed_file(self):
        """The committed CSV must be what build_dataset.py would produce today."""
        with seedlib.DATASET_CSV.open(encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
        activities = seedlib.load_seed("activities")

        self.assertEqual(len(rows), len(activities), "CSV is stale; run scripts/build_dataset.py")
        for row, activity in zip(rows, activities):
            expected = seedlib.activity_to_row(activity)
            for column in seedlib.ACTIVITY_COLUMNS:
                self.assertEqual(row[column], str(expected[column]),
                                 f"{activity['id']}.{column} differs; run scripts/build_dataset.py")

    def test_csv_header_contains_the_columns_the_api_filters_on(self):
        with seedlib.DATASET_CSV.open(encoding="utf-8", newline="") as handle:
            header = next(csv.reader(handle))
        for column in ("id", "name", "type", "state", "indoor_or_outdoor"):
            self.assertIn(column, header)

    def test_json_dataset_matches_the_seed_file(self):
        built = json.loads(seedlib.DATASET_JSON.read_text(encoding="utf-8"))
        self.assertEqual(built, seedlib.load_seed("activities"),
                         "JSON dataset is stale; run scripts/build_dataset.py")


class TestSchemas(unittest.TestCase):
    def test_postgres_and_sqlite_schemas_declare_the_same_shape(self):
        postgres = parse_schema(seedlib.SCHEMA_SQL)
        sqlite_schema = parse_schema(seedlib.DB_DIR / "schema.sqlite.sql")
        self.assertEqual(sorted(postgres), sorted(sqlite_schema))
        for table in postgres:
            with self.subTest(table=table):
                self.assertEqual(postgres[table], sqlite_schema[table])

    def test_loader_covers_every_table_in_the_schema(self):
        postgres = parse_schema(seedlib.SCHEMA_SQL)
        loaded = {table for table, _ in seed_db.TABLES}
        self.assertEqual(set(postgres), loaded)

    def test_loader_column_lists_match_the_schema(self):
        postgres = parse_schema(seedlib.SCHEMA_SQL)
        for table, columns in seed_db.TABLES:
            with self.subTest(table=table):
                self.assertEqual(sorted(columns), sorted(postgres[table]))

    def test_schema_keeps_the_tables_from_the_original_sketch(self):
        """The four tables sketched in `Uberliketasks` must survive."""
        postgres = parse_schema(seedlib.SCHEMA_SQL)
        for table in ("families", "trips", "feedback", "global_patterns"):
            self.assertIn(table, postgres)


class TestSqliteLoad(unittest.TestCase):
    def test_seeds_load_into_sqlite_with_intact_foreign_keys(self):
        seeds = seedlib.load_all()
        schema = (seedlib.DB_DIR / "schema.sqlite.sql").read_text(encoding="utf-8")

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "test.db"
            connection = sqlite3.connect(path)
            try:
                connection.executescript(schema)
                connection.execute("PRAGMA foreign_keys = ON")
                for table, columns in seed_db.TABLES:
                    rows = seed_db._rows_for(table, seeds, columns)
                    placeholders = ", ".join("?" for _ in columns)
                    connection.executemany(
                        f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders})",
                        rows,
                    )
                connection.commit()

                self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])

                count = connection.execute("SELECT COUNT(*) FROM activities").fetchone()[0]
                self.assertEqual(count, len(seeds["activities"]))

                # The query GET /recommend runs must return rows for every state.
                for state in sorted(seedlib.SUPPORTED_STATES):
                    found = connection.execute(
                        "SELECT COUNT(*) FROM activities WHERE state = ?", (state,)
                    ).fetchone()[0]
                    self.assertGreater(found, 0, f"no rows for {state}")
            finally:
                connection.close()

    def test_generated_seed_sql_escapes_quotes(self):
        self.assertEqual(seed_db._sql_literal("O'Hare"), "'O''Hare'")
        self.assertEqual(seed_db._sql_literal(None), "NULL")
        self.assertEqual(seed_db._sql_literal(7), "7")


class TestApiSeedLoader(unittest.TestCase):
    def test_tiers_are_loaded_for_every_seeded_user(self):
        users = seedlib.load_seed("users")
        tiers = seed_loader.user_tiers()
        self.assertEqual(len(tiers), len(users))
        for user in users:
            self.assertEqual(tiers[user["api_key"]], user["tier"])

    def test_history_totals_match_the_balances_the_api_serves(self):
        balances = seed_loader.points_by_user()
        history = seed_loader.history_by_user()
        for api_key, points in balances.items():
            with self.subTest(api_key=api_key):
                self.assertEqual(sum(item["points"] for item in history[api_key]), points)

    def test_history_is_in_chronological_order(self):
        for api_key, items in seed_loader.history_by_user().items():
            dates = [item["date"] for item in items if item.get("date")]
            with self.subTest(api_key=api_key):
                self.assertEqual(dates, sorted(dates))

    def test_missing_seed_directory_falls_back_instead_of_raising(self):
        self.assertEqual(seed_loader.load_seed("does_not_exist"), [])
        self.assertEqual(seed_loader.load_seed("does_not_exist", default=["x"]), ["x"])


if __name__ == "__main__":
    unittest.main()
