-- Full row accounting and quarantine.
--
-- "No silent drops" means every source row ends in exactly one bucket, and the
-- buckets sum back to the source count. The previous funnel recorded where rows
-- were lost but not what happened to the survivors (inserted vs updated vs
-- unchanged), and rejected rows were sampled rather than retained.

ALTER TABLE ingestion_runs ADD COLUMN validated_rows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingestion_runs ADD COLUMN matched_rows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingestion_runs ADD COLUMN inserted_rows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingestion_runs ADD COLUMN updated_rows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingestion_runs ADD COLUMN unchanged_rows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingestion_runs ADD COLUMN quarantined_rows INTEGER NOT NULL DEFAULT 0;
-- False when the buckets do not sum to source_rows: an accounting failure is
-- itself a defect, not a rounding detail.
ALTER TABLE ingestion_runs ADD COLUMN accounting_balanced INTEGER NOT NULL DEFAULT 1;

-- Every row that did not make it, kept in full rather than sampled, so a run
-- can be re-driven after a mapping is repaired.
CREATE TABLE quarantine (
  id                   TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL REFERENCES ingestion_runs(run_id),
  source_id            TEXT NOT NULL,
  source_record_id     TEXT,
  stage                TEXT NOT NULL,
  reason_code          TEXT NOT NULL,
  details              TEXT,
  raw_record           TEXT NOT NULL,
  raw_record_hash      TEXT NOT NULL,
  quarantined_at       TEXT NOT NULL,
  released_at          TEXT,
  released_by_run_id   TEXT
);
CREATE INDEX quarantine_run_idx ON quarantine(run_id);
CREATE INDEX quarantine_reason_idx ON quarantine(source_id, reason_code);
CREATE INDEX quarantine_open_idx ON quarantine(source_id, released_at);
