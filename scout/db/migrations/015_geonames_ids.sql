-- Carry GeoNames identifiers so entity resolution can be exact.
--
-- Matching cities by name and proximity works, but it produced 148 pairs that
-- had to be left for human review because Salem MA and Salem NH are genuinely
-- indistinguishable from geometry alone. OpenTravelData publishes the GeoNames
-- id for both an airport and the city it serves, which turns that fuzzy join
-- into an identity join for every row that carries one.

ALTER TABLE cities ADD COLUMN geoname_id INTEGER;
ALTER TABLE airports ADD COLUMN geoname_id INTEGER;
-- The GeoNames id of the CITY this airport serves, which is not the airport's
-- own id: LAX is 5368418, Los Angeles is 5368361.
ALTER TABLE airports ADD COLUMN city_geoname_id INTEGER;

CREATE INDEX cities_geoname_idx ON cities(geoname_id) WHERE geoname_id IS NOT NULL;
CREATE INDEX airports_city_geoname_idx ON airports(city_geoname_id) WHERE city_geoname_id IS NOT NULL;
