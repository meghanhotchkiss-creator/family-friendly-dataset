-- SourceMesh: the ingestion and truth layer.
--
-- The point of these tables is that a dataset's journey is auditable end to
-- end. Not "4,213 rows imported", but: how many arrived, how many parsed, how
-- many resolved geography, how many were rejected and WHY -- so an 85% silent
-- loss surfaces as an anomaly instead of looking like a successful run.

-- Every source, with its licence recorded BEFORE ingestion is permitted.
CREATE TABLE source_registry (
  source_id               TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  source_type             TEXT NOT NULL,
  entity                  TEXT NOT NULL,
  license                 TEXT NOT NULL,
  attribution             TEXT NOT NULL,
  commercial_use_allowed  INTEGER NOT NULL,
  share_alike             INTEGER NOT NULL DEFAULT 0,
  homepage                TEXT,
  locator                 TEXT NOT NULL,
  update_frequency        TEXT,
  trust_tier              TEXT NOT NULL CHECK (trust_tier IN ('official','open_dataset','aggregator','community','derived')),
  spec_hash               TEXT,
  last_checked            TEXT,
  last_successful_ingestion TEXT,
  enabled                 INTEGER NOT NULL DEFAULT 1
);

-- One row per ingestion attempt, carrying the full funnel.
CREATE TABLE ingestion_runs (
  run_id            TEXT PRIMARY KEY,
  source_id         TEXT NOT NULL REFERENCES source_registry(source_id),
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  status            TEXT NOT NULL CHECK (status IN ('running','ok','ok_with_anomalies','failed')),
  source_rows       INTEGER NOT NULL DEFAULT 0,
  parsed            INTEGER NOT NULL DEFAULT 0,
  mapped            INTEGER NOT NULL DEFAULT 0,
  geo_resolved      INTEGER NOT NULL DEFAULT 0,
  imported          INTEGER NOT NULL DEFAULT 0,
  rejected          INTEGER NOT NULL DEFAULT 0,
  content_hash      TEXT,
  unchanged         INTEGER NOT NULL DEFAULT 0,
  anomalies_json    TEXT NOT NULL DEFAULT '[]',
  warnings_json     TEXT NOT NULL DEFAULT '[]',
  error             TEXT
);
CREATE INDEX ingestion_runs_source_idx ON ingestion_runs(source_id, started_at);

-- Why individual records were dropped. Capped per run: enough to diagnose a
-- systemic failure, not a second copy of the dataset.
CREATE TABLE ingest_rejections (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES ingestion_runs(run_id),
  stage       TEXT NOT NULL,
  reason      TEXT NOT NULL,
  field       TEXT,
  sample_json TEXT
);
CREATE INDEX ingest_rejections_run_idx ON ingest_rejections(run_id, reason);

-- Cross-source entity resolution outcomes.
CREATE TABLE entity_matches (
  id            TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,
  left_source   TEXT NOT NULL,
  left_key      TEXT NOT NULL,
  right_entity  TEXT,
  state         TEXT NOT NULL CHECK (state IN ('MATCH','POSSIBLE_MATCH','NO_MATCH')),
  score         REAL NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  decided_at    TEXT NOT NULL,
  UNIQUE (entity_type, left_source, left_key)
);
CREATE INDEX entity_matches_state_idx ON entity_matches(state);

-- Disagreements between sources, kept rather than silently resolved.
CREATE TABLE data_conflicts (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  field        TEXT NOT NULL,
  values_json  TEXT NOT NULL,
  detected_at  TEXT NOT NULL,
  resolved_at  TEXT,
  resolution   TEXT
);
CREATE INDEX data_conflicts_entity_idx ON data_conflicts(entity_id, field);
