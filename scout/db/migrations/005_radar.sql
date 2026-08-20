-- Radar: watched-source registry, scan history, semantic deltas, verification.

CREATE TABLE watches (
  id                     TEXT PRIMARY KEY,
  source_id              TEXT NOT NULL REFERENCES sources(id),
  entity_type            TEXT NOT NULL,
  entity_id              TEXT NOT NULL,
  locator                TEXT NOT NULL,
  freshness_tier         TEXT NOT NULL CHECK (freshness_tier IN ('base','periodic','live')),
  check_interval_minutes INTEGER NOT NULL,
  last_checked_at        TEXT,
  last_hash              TEXT,
  -- Conditional-fetch validators: an unchanged source should cost one 304.
  etag                   TEXT,
  last_modified          TEXT,
  enabled                INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT NOT NULL,
  UNIQUE (source_id, entity_id, locator)
);
CREATE INDEX watches_due_idx ON watches(enabled, last_checked_at);

CREATE TABLE radar_scans (
  id               TEXT PRIMARY KEY,
  watch_id         TEXT NOT NULL REFERENCES watches(id),
  started_at       TEXT NOT NULL,
  finished_at      TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('unchanged','changed','error','skipped')),
  http_status      INTEGER,
  bytes            INTEGER,
  hash             TEXT,
  conditional_hit  INTEGER NOT NULL DEFAULT 0,
  error            TEXT
);
CREATE INDEX radar_scans_watch_idx ON radar_scans(watch_id, started_at);

CREATE TABLE radar_deltas (
  id             TEXT PRIMARY KEY,
  watch_id       TEXT NOT NULL REFERENCES watches(id),
  scan_id        TEXT NOT NULL REFERENCES radar_scans(id),
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  field          TEXT NOT NULL,
  old_value_json TEXT,
  new_value_json TEXT,
  semantic_score REAL NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('cosmetic','material','structural')),
  verification   TEXT NOT NULL DEFAULT 'unverified',
  created_at     TEXT NOT NULL
);
CREATE INDEX radar_deltas_entity_idx ON radar_deltas(entity_id, field);
CREATE INDEX radar_deltas_pending_idx ON radar_deltas(verification, kind);

CREATE TABLE verifications (
  id         TEXT PRIMARY KEY,
  delta_id   TEXT NOT NULL REFERENCES radar_deltas(id),
  verifier   TEXT NOT NULL,
  method     TEXT NOT NULL CHECK (method IN ('corroboration','refetch','heuristic','human')),
  outcome    TEXT NOT NULL,
  notes      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX verifications_delta_idx ON verifications(delta_id);
