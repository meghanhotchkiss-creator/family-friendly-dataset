-- Fix a silent drop in entity_matches.
--
-- The unique key was (entity_type, left_source, left_key), which assumes one
-- decision per left entity. Candidate pairs are many-to-many: "Springfield"
-- appears in several pairs, and each upsert overwrote the previous decision.
-- 785 of 6,579 classified city pairs were lost with no error raised -- exactly
-- the class of failure the accounting layer exists to prevent, in the schema
-- that records it.
--
-- The identity of a match is the PAIR.

CREATE TABLE entity_matches_new (
  id            TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,
  left_source   TEXT NOT NULL,
  left_key      TEXT NOT NULL,
  right_entity  TEXT,
  state         TEXT NOT NULL CHECK (state IN ('MATCH','POSSIBLE_MATCH','NO_MATCH')),
  score         REAL NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  decided_at    TEXT NOT NULL,
  UNIQUE (entity_type, left_key, right_entity)
);

INSERT INTO entity_matches_new
  (id, entity_type, left_source, left_key, right_entity, state, score, evidence_json, decided_at)
SELECT id, entity_type, left_source, left_key, right_entity, state, score, evidence_json, decided_at
FROM entity_matches;

DROP TABLE entity_matches;
ALTER TABLE entity_matches_new RENAME TO entity_matches;

CREATE INDEX entity_matches_state_idx ON entity_matches(state);
CREATE INDEX entity_matches_left_idx ON entity_matches(entity_type, left_key);
