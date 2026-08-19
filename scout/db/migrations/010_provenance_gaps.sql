-- Closes two gaps the parallel tracks hit against the frozen schema.
--
-- 1. topics.confidence_json
--    Topics stored only the scalar confidence, so the four components behind
--    it (authority, corroboration, freshness, verification) were lost and had
--    to be reconstructed on read. Every other subsystem persists the whole
--    Confidence object; topics were the one exception.
--
-- 2. radar_deltas.source_record_id
--    Radar files a source claim for each material/structural delta, but there
--    was no link back to it, so verification re-identified the claim by
--    (source, entity, field, content_hash). That is exact today but silently
--    finds nothing once the Truth Engine supersedes the row, which would leave
--    a verified change stuck at `unverified` weight.

ALTER TABLE topics ADD COLUMN confidence_json TEXT;

ALTER TABLE radar_deltas ADD COLUMN source_record_id TEXT REFERENCES source_records(id);

CREATE INDEX radar_deltas_source_record_idx ON radar_deltas(source_record_id);
