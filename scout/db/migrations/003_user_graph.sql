-- User Graph: identity, travel party, learned preferences, context signals.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  home_city_id  TEXT REFERENCES cities(id),
  created_at    TEXT NOT NULL
);

CREATE TABLE travel_party (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  label      TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('adult','child','infant','teen','senior')),
  age        INTEGER,
  needs_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX travel_party_user_idx ON travel_party(user_id);

-- One row per (user, dimension, value). Weight is -1..1: negative is aversion.
CREATE TABLE user_preferences (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  dimension       TEXT NOT NULL,
  value           TEXT NOT NULL,
  weight          REAL NOT NULL,
  confidence      REAL NOT NULL DEFAULT 0,
  confidence_json TEXT,
  evidence_count  INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL,
  UNIQUE (user_id, dimension, value)
);
CREATE INDEX user_preferences_user_idx ON user_preferences(user_id);

-- Raw observations. The learner derives user_preferences from these, so it can
-- always be recomputed from scratch.
CREATE TABLE user_signals (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  place_id     TEXT NOT NULL REFERENCES places(id),
  kind         TEXT NOT NULL CHECK (kind IN ('saved','rejected','visited','rated','viewed','booked')),
  rating       INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX user_signals_user_idx ON user_signals(user_id);
CREATE INDEX user_signals_place_idx ON user_signals(place_id);
