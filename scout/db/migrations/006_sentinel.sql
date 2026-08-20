-- Connection Sentinel plus the job/queue ledger.

CREATE TABLE providers (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  source_class   TEXT NOT NULL,
  authority      REAL NOT NULL CHECK (authority >= 0 AND authority <= 1),
  freshness_tier TEXT NOT NULL CHECK (freshness_tier IN ('base','periodic','live')),
  region_scope   TEXT NOT NULL DEFAULT '[]',
  enabled        INTEGER NOT NULL DEFAULT 1,
  config_json    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE provider_health_checks (
  id                 TEXT PRIMARY KEY,
  provider_id        TEXT NOT NULL REFERENCES providers(id),
  checked_at         TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('up','degraded','down','unconfigured')),
  latency_ms         INTEGER,
  http_status        INTEGER,
  auth_ok            INTEGER NOT NULL DEFAULT 0,
  schema_ok          INTEGER NOT NULL DEFAULT 0,
  schema_fingerprint TEXT,
  error              TEXT
);
CREATE INDEX provider_health_provider_idx ON provider_health_checks(provider_id, checked_at);

-- Drift detection: a new fingerprint for a provider means its payload changed shape.
CREATE TABLE schema_fingerprints (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT NOT NULL REFERENCES providers(id),
  fingerprint   TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  UNIQUE (provider_id, fingerprint)
);

CREATE TABLE incidents (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  kind        TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  opened_at   TEXT NOT NULL,
  closed_at   TEXT,
  detail      TEXT NOT NULL
);
CREATE INDEX incidents_open_idx ON incidents(provider_id, closed_at);

-- Stand-in for the AWS job/queue ledger: every batch job records a run.
CREATE TABLE job_runs (
  id          TEXT PRIMARY KEY,
  job         TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL CHECK (status IN ('running','ok','failed')),
  stats_json  TEXT NOT NULL DEFAULT '{}',
  error       TEXT
);
CREATE INDEX job_runs_job_idx ON job_runs(job, started_at);
