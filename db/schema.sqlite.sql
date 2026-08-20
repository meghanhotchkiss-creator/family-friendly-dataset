-- Family Friendly / Scout Fox -- SQLite schema (local development).
--
-- Column-for-column equivalent of db/schema.sql, with SQLite-compatible types
-- (JSONB -> TEXT holding JSON, DATE -> TEXT holding an ISO-8601 date).
-- Built and populated by:
--
--   python scripts/seed_db.py --sqlite
--
-- Keep this file in sync with db/schema.sql; tests/test_seed_data.py asserts
-- that both declare the same tables and columns.
DROP TABLE IF EXISTS points_ledger;
DROP TABLE IF EXISTS feedback;
DROP TABLE IF EXISTS trips;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS families;
DROP TABLE IF EXISTS global_patterns;
DROP TABLE IF EXISTS activities;

-- Family-friendly places served by GET /recommend.
CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  category TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  indoor_or_outdoor TEXT NOT NULL CHECK (indoor_or_outdoor IN ('indoor', 'outdoor')),
  price_tier TEXT NOT NULL CHECK (price_tier IN ('free', '$', '$$', '$$$')),
  min_age INTEGER NOT NULL,
  max_age INTEGER NOT NULL,
  avg_duration_hours REAL NOT NULL,
  rating REAL NOT NULL CHECK (rating >= 0 AND rating <= 5),
  tags TEXT NOT NULL,
  description TEXT NOT NULL,
  CHECK (min_age <= max_age)
);

CREATE INDEX activities_state_idx ON activities (state);
CREATE INDEX activities_state_indoor_idx ON activities (state, indoor_or_outdoor);
CREATE INDEX activities_category_idx ON activities (category);

CREATE TABLE families (
  family_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  members TEXT NOT NULL,            -- ages, preferences
  budget_range TEXT,
  home_location TEXT
);

-- API-key holders. Mirrors USER_TIERS in api/auth_tiers.py.
CREATE TABLE users (
  api_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  tier TEXT NOT NULL CHECK (tier IN ('free', 'pro', 'business')),
  points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  home_state TEXT,
  family_id INTEGER REFERENCES families(family_id)
);

CREATE TABLE trips (
  trip_id INTEGER PRIMARY KEY,
  family_id INTEGER REFERENCES families(family_id),
  destination TEXT,
  start_date TEXT,
  end_date TEXT,
  itinerary TEXT
);

CREATE INDEX trips_family_idx ON trips (family_id);

CREATE TABLE feedback (
  feedback_id INTEGER PRIMARY KEY,
  trip_id INTEGER REFERENCES trips(trip_id),
  family_id INTEGER REFERENCES families(family_id),
  rating INT CHECK (rating >= 1 AND rating <= 5),
  comments TEXT
);

CREATE INDEX feedback_trip_idx ON feedback (trip_id);

CREATE TABLE global_patterns (
  pattern_id INTEGER PRIMARY KEY,
  cluster_name TEXT,
  top_destinations TEXT,
  seasonal_preferences TEXT,
  notes TEXT
);

-- Append-only points history behind /points/points_history and /points/leaderboard.
CREATE TABLE points_ledger (
  entry_id INTEGER PRIMARY KEY,
  api_key TEXT REFERENCES users(api_key),
  event TEXT NOT NULL,
  points INTEGER NOT NULL,
  activity_id TEXT REFERENCES activities(id),
  created_at TEXT,
  note TEXT
);

CREATE INDEX points_ledger_api_key_idx ON points_ledger (api_key);
