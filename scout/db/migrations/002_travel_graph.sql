-- Places, topics, vibes, trips and constraints.

CREATE TABLE places (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  city_id          TEXT NOT NULL REFERENCES cities(id),
  neighborhood_id  TEXT REFERENCES neighborhoods(id),
  lat              REAL,
  lon              REAL,
  category         TEXT NOT NULL,
  subcategory      TEXT,
  price_tier       TEXT CHECK (price_tier IN ('free','$','$$','$$$')),
  indoor_outdoor   TEXT CHECK (indoor_outdoor IN ('indoor','outdoor','mixed')),
  rating           REAL CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5)),
  min_age          INTEGER,
  max_age          INTEGER,
  duration_minutes INTEGER,
  -- 0..1 tourist saturation; 0..1 how much locals actually go
  touristiness     REAL CHECK (touristiness IS NULL OR (touristiness >= 0 AND touristiness <= 1)),
  local_favor      REAL CHECK (local_favor IS NULL OR (local_favor >= 0 AND local_favor <= 1)),
  description      TEXT,
  canonical_hash   TEXT,
  updated_at       TEXT NOT NULL
);
CREATE INDEX places_city_idx ON places(city_id);
CREATE INDEX places_category_idx ON places(category);
CREATE INDEX places_city_category_idx ON places(city_id, category);

CREATE TABLE topics (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  label           TEXT NOT NULL,
  parent_topic_id TEXT REFERENCES topics(id),
  status          TEXT NOT NULL CHECK (status IN ('core','candidate','promoted','rejected')),
  support_count   INTEGER NOT NULL DEFAULT 0,
  confidence      REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE INDEX topics_status_idx ON topics(status);

CREATE TABLE vibes (
  id    TEXT PRIMARY KEY,
  slug  TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

CREATE TABLE place_topics (
  place_id TEXT NOT NULL REFERENCES places(id),
  topic_id TEXT NOT NULL REFERENCES topics(id),
  weight   REAL NOT NULL DEFAULT 1,
  source   TEXT NOT NULL CHECK (source IN ('taxonomy','discovered','manual')),
  PRIMARY KEY (place_id, topic_id)
);
CREATE INDEX place_topics_topic_idx ON place_topics(topic_id);

CREATE TABLE place_vibes (
  place_id TEXT NOT NULL REFERENCES places(id),
  vibe_id  TEXT NOT NULL REFERENCES vibes(id),
  weight   REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (place_id, vibe_id)
);

CREATE TABLE trips (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  title               TEXT NOT NULL,
  destination_city_id TEXT REFERENCES cities(id),
  start_date          TEXT,
  end_date            TEXT,
  status              TEXT NOT NULL CHECK (status IN ('draft','planned','active','complete')),
  created_at          TEXT NOT NULL
);
CREATE INDEX trips_user_idx ON trips(user_id);

CREATE TABLE trip_items (
  id       TEXT PRIMARY KEY,
  trip_id  TEXT NOT NULL REFERENCES trips(id),
  place_id TEXT NOT NULL REFERENCES places(id),
  day      INTEGER NOT NULL,
  position INTEGER NOT NULL,
  note     TEXT
);
CREATE INDEX trip_items_trip_idx ON trip_items(trip_id);

CREATE TABLE constraints (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  trip_id    TEXT REFERENCES trips(id),
  kind       TEXT NOT NULL,
  value_json TEXT NOT NULL,
  hard       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK (user_id IS NOT NULL OR trip_id IS NOT NULL)
);
CREATE INDEX constraints_user_idx ON constraints(user_id);
