-- GTFS static import target. Kept minimal and provider-agnostic: enough to
-- answer "can this family reach this place by transit" without modelling the
-- whole spec.

CREATE TABLE gtfs_feeds (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  city_id       TEXT REFERENCES cities(id),
  region_code   TEXT NOT NULL REFERENCES regions(code),
  source_url    TEXT,
  feed_hash     TEXT,
  imported_at   TEXT NOT NULL
);

CREATE TABLE gtfs_agencies (
  id       TEXT PRIMARY KEY,
  feed_id  TEXT NOT NULL REFERENCES gtfs_feeds(id),
  name     TEXT NOT NULL,
  timezone TEXT
);

CREATE TABLE gtfs_stops (
  id       TEXT PRIMARY KEY,
  feed_id  TEXT NOT NULL REFERENCES gtfs_feeds(id),
  code     TEXT,
  name     TEXT NOT NULL,
  lat      REAL,
  lon      REAL
);
CREATE INDEX gtfs_stops_feed_idx ON gtfs_stops(feed_id);

CREATE TABLE gtfs_routes (
  id         TEXT PRIMARY KEY,
  feed_id    TEXT NOT NULL REFERENCES gtfs_feeds(id),
  agency_id  TEXT REFERENCES gtfs_agencies(id),
  short_name TEXT,
  long_name  TEXT,
  route_type INTEGER
);
CREATE INDEX gtfs_routes_feed_idx ON gtfs_routes(feed_id);

-- Which stops serve which place, so transit access is a graph edge.
CREATE TABLE place_transit (
  place_id     TEXT NOT NULL REFERENCES places(id),
  stop_id      TEXT NOT NULL REFERENCES gtfs_stops(id),
  walk_minutes INTEGER NOT NULL,
  PRIMARY KEY (place_id, stop_id)
);
