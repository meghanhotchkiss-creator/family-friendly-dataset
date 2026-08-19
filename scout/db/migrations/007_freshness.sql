-- TTL cache backing the base / periodic / live freshness tiers.

CREATE TABLE live_data_cache (
  cache_key   TEXT PRIMARY KEY,
  provider_id TEXT REFERENCES providers(id),
  tier        TEXT NOT NULL CHECK (tier IN ('base','periodic','live')),
  value_json  TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  hash        TEXT NOT NULL,
  stale       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX live_data_cache_expiry_idx ON live_data_cache(expires_at);
CREATE INDEX live_data_cache_provider_idx ON live_data_cache(provider_id);
