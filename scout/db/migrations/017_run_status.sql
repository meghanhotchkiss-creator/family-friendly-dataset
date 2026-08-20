-- no-transaction
--
-- A run that never started is not a run that failed.
--
-- `skipped` is what a source with no credentials, or one behind blocked egress,
-- actually is. Recording those as `failed` put a missing API key and a broken
-- feed in the same bucket on every status board -- and the CHECK constraint,
-- correctly, refused the new value until the constraint itself was widened.
--
-- SQLite cannot alter a CHECK in place, so the table is rebuilt. The direction
-- matters: build the replacement under a new name, drop the original, then
-- rename into place. Renaming the ORIGINAL out of the way instead rewrites
-- every REFERENCES clause pointing at it -- `quarantine`'s foreign key became
-- `REFERENCES ingestion_runs_old`, which this migration then dropped, and every
-- quarantine insert afterwards failed with "no such table". `legacy_alter_table`
-- does not prevent that rewrite; only renaming in the safe direction does.
--
-- Foreign keys are off for the swap so the DROP does not cascade, and the
-- migration ends by checking that nothing was left dangling.

PRAGMA foreign_keys = OFF;

CREATE TABLE ingestion_runs_v2 (
  run_id            TEXT PRIMARY KEY,
  source_id         TEXT NOT NULL REFERENCES source_registry(source_id),
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  status            TEXT NOT NULL CHECK (status IN ('running','ok','ok_with_anomalies','failed','skipped')),
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
  error             TEXT,
  validated_rows    INTEGER NOT NULL DEFAULT 0,
  matched_rows      INTEGER NOT NULL DEFAULT 0,
  inserted_rows     INTEGER NOT NULL DEFAULT 0,
  updated_rows      INTEGER NOT NULL DEFAULT 0,
  unchanged_rows    INTEGER NOT NULL DEFAULT 0,
  quarantined_rows  INTEGER NOT NULL DEFAULT 0,
  accounting_balanced INTEGER NOT NULL DEFAULT 1
);

INSERT INTO ingestion_runs_v2 SELECT
  run_id, source_id, started_at, finished_at, status, source_rows, parsed, mapped,
  geo_resolved, imported, rejected, content_hash, unchanged, anomalies_json,
  warnings_json, error, validated_rows, matched_rows, inserted_rows, updated_rows,
  unchanged_rows, quarantined_rows, accounting_balanced
FROM ingestion_runs;

DROP TABLE ingestion_runs;

ALTER TABLE ingestion_runs_v2 RENAME TO ingestion_runs;

CREATE INDEX ingestion_runs_source_idx ON ingestion_runs(source_id, started_at);

PRAGMA foreign_keys = ON;
