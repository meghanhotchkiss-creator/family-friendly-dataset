-- Persist how precise a place's coordinates actually are.
--
-- The places adapter already distinguishes venue-precise coordinates from a
-- city centroid, but there was nowhere to put the answer, so it was parsed and
-- dropped. That left 73 of 179 places sharing a centroid with no way to tell:
-- all 10 Chicago places sit on 41.878,-87.63.
--
-- Nothing breaks while neighborhoods and place_transit are empty, but the
-- first neighbourhood or transit import would link all ten to the same
-- "nearest" row, silently and confidently wrong. Recording the precision makes
-- that refusable instead of invisible.
--
--   venue  usable for distance, nearest-neighbour and transit linking
--   city   a centroid standing in for an unknown address; NOT usable for those
--   NULL   unknown provenance, treated as unusable

ALTER TABLE places ADD COLUMN location_precision TEXT
  CHECK (location_precision IS NULL OR location_precision IN ('venue', 'city'));

CREATE INDEX places_precision_idx ON places(location_precision);
