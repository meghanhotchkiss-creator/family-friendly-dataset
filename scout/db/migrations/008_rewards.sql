-- Rewards foundation: programs, transfers, balances, award quotes, friction.

CREATE TABLE loyalty_programs (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('airline','hotel','bank','rail')),
  currency_name TEXT NOT NULL,
  region_code   TEXT REFERENCES regions(code)
);

CREATE TABLE transfer_partners (
  id                 TEXT PRIMARY KEY,
  from_program_id    TEXT NOT NULL REFERENCES loyalty_programs(id),
  to_program_id      TEXT NOT NULL REFERENCES loyalty_programs(id),
  -- ratio_num points out produce ratio_den points in
  ratio_num          INTEGER NOT NULL CHECK (ratio_num > 0),
  ratio_den          INTEGER NOT NULL CHECK (ratio_den > 0),
  min_transfer       INTEGER NOT NULL DEFAULT 1000,
  transfer_time_hours REAL NOT NULL DEFAULT 0,
  active             INTEGER NOT NULL DEFAULT 1,
  UNIQUE (from_program_id, to_program_id)
);

CREATE TABLE user_balances (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  program_id TEXT NOT NULL REFERENCES loyalty_programs(id),
  balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, program_id)
);

CREATE TABLE award_quotes (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT REFERENCES users(id),
  origin_airport_id      TEXT NOT NULL REFERENCES airports(id),
  destination_airport_id TEXT NOT NULL REFERENCES airports(id),
  program_id             TEXT NOT NULL REFERENCES loyalty_programs(id),
  points_cost            INTEGER NOT NULL CHECK (points_cost > 0),
  taxes_cents            INTEGER NOT NULL DEFAULT 0,
  cash_cents             INTEGER NOT NULL DEFAULT 0,
  cents_per_point        REAL NOT NULL,
  confidence             REAL NOT NULL,
  confidence_json        TEXT NOT NULL,
  quoted_at              TEXT NOT NULL
);
CREATE INDEX award_quotes_route_idx ON award_quotes(origin_airport_id, destination_airport_id);

CREATE TABLE travel_friction (
  id                     TEXT PRIMARY KEY,
  origin_airport_id      TEXT NOT NULL REFERENCES airports(id),
  destination_airport_id TEXT NOT NULL REFERENCES airports(id),
  stops                  INTEGER NOT NULL,
  total_minutes          INTEGER NOT NULL,
  overnight              INTEGER NOT NULL DEFAULT 0,
  redeye                 INTEGER NOT NULL DEFAULT 0,
  score                  REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  factors_json           TEXT NOT NULL DEFAULT '[]',
  computed_at            TEXT NOT NULL
);
CREATE INDEX travel_friction_route_idx ON travel_friction(origin_airport_id, destination_airport_id);
