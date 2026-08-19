-- Scout Truth Layer. Facts enter as source claims and are resolved centrally.

CREATE TABLE sources (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  source_class    TEXT NOT NULL,
  authority       REAL NOT NULL CHECK (authority >= 0 AND authority <= 1),
  homepage        TEXT,
  region_scope    TEXT NOT NULL DEFAULT '[]',
  freshness_tier  TEXT NOT NULL CHECK (freshness_tier IN ('base','periodic','live')),
  enabled         INTEGER NOT NULL DEFAULT 1
);

-- One source's claim about one field of one entity at one time.
CREATE TABLE source_records (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES sources(id),
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  field         TEXT NOT NULL,
  value_json    TEXT NOT NULL,
  observed_at   TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  verification  TEXT NOT NULL DEFAULT 'unverified',
  superseded_by TEXT REFERENCES source_records(id)
);
CREATE INDEX source_records_entity_idx ON source_records(entity_type, entity_id, field);
CREATE INDEX source_records_source_idx ON source_records(source_id);
CREATE INDEX source_records_live_idx ON source_records(entity_id, field) WHERE superseded_by IS NULL;

CREATE TABLE truth_resolutions (
  id                    TEXT PRIMARY KEY,
  entity_type           TEXT NOT NULL,
  entity_id             TEXT NOT NULL,
  field                 TEXT NOT NULL,
  value_json            TEXT NOT NULL,
  confidence            REAL NOT NULL,
  confidence_json       TEXT NOT NULL,
  chosen_record_id      TEXT NOT NULL REFERENCES source_records(id),
  agreeing_record_ids   TEXT NOT NULL DEFAULT '[]',
  conflicting_record_ids TEXT NOT NULL DEFAULT '[]',
  rationale             TEXT NOT NULL,
  resolved_at           TEXT NOT NULL,
  UNIQUE (entity_type, entity_id, field)
);
CREATE INDEX truth_resolutions_entity_idx ON truth_resolutions(entity_id);
