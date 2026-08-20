-- The rest of the OurAirports file set.
--
-- Until now only airports.csv was loaded, and only a ~28k reconstruction of it.
-- The full dump carries four more things the travel graph could not previously
-- answer: which sub-national region an airport is in, whether its runway can
-- take a jet, what it is reachable on by radio, and what navaids serve it.

-- regions.csv. `code` is what airports.iso_region joins to (US-PA, GB-ENG,
-- JP-13). This is NOT the `regions` table: that one holds the eight travel
-- flags (NA CA SA EU ME AF AS OC) the whole platform filters on. Two different
-- ideas that both got called "region" upstream, kept apart here on purpose.
CREATE TABLE admin_regions (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  local_code     TEXT,
  name           TEXT NOT NULL,
  continent      TEXT,
  country_iso2   TEXT NOT NULL,
  country_id     TEXT REFERENCES countries(id),
  wikipedia_link TEXT,
  updated_at     TEXT NOT NULL
);
CREATE INDEX admin_regions_country_idx ON admin_regions(country_iso2);

-- OurAirports' own primary key. Runways, frequencies and navaids all reference
-- an airport by `ident`, not by IATA or ICAO, so it has to be stored for those
-- files to join to anything.
ALTER TABLE airports ADD COLUMN ident TEXT;
ALTER TABLE airports ADD COLUMN iso_region TEXT;
ALTER TABLE airports ADD COLUMN admin1 TEXT;
-- The real OurAirports classification: large_airport, medium_airport,
-- small_airport, heliport, seaplane_base, balloonport, closed. `kind` is the
-- three-way bucket the recommender uses; this is what it was derived from.
ALTER TABLE airports ADD COLUMN airport_type TEXT;
ALTER TABLE airports ADD COLUMN elevation_ft INTEGER;
ALTER TABLE airports ADD COLUMN scheduled_service INTEGER;
-- The local identifiers, kept as themselves. They used to be written into the
-- `icao` column via an anyOf fallback, which invented an ICAO code for 75,000
-- airfields that have none -- and collapsed 457 pairs of distinct airports onto
-- one id, because one airport's `ident` is another's `gps_code`.
ALTER TABLE airports ADD COLUMN gps_code TEXT;
ALTER TABLE airports ADD COLUMN local_code TEXT;
ALTER TABLE airports ADD COLUMN home_link TEXT;
ALTER TABLE airports ADD COLUMN wikipedia_link TEXT;
CREATE INDEX airports_ident_idx ON airports(ident);
CREATE INDEX airports_iso_region_idx ON airports(iso_region);

CREATE TABLE runways (
  id                TEXT PRIMARY KEY,
  airport_ident     TEXT NOT NULL,
  airport_id        TEXT REFERENCES airports(id),
  length_ft         INTEGER,
  width_ft          INTEGER,
  surface           TEXT,
  lighted           INTEGER,
  closed            INTEGER,
  le_ident          TEXT,
  he_ident          TEXT,
  updated_at        TEXT NOT NULL
);
CREATE INDEX runways_airport_idx ON runways(airport_id);
CREATE INDEX runways_ident_idx ON runways(airport_ident);

CREATE TABLE airport_frequencies (
  id                TEXT PRIMARY KEY,
  airport_ident     TEXT NOT NULL,
  airport_id        TEXT REFERENCES airports(id),
  frequency_type    TEXT,
  description       TEXT,
  frequency_mhz     REAL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX airport_frequencies_airport_idx ON airport_frequencies(airport_id);
CREATE INDEX airport_frequencies_ident_idx ON airport_frequencies(airport_ident);

CREATE TABLE navaids (
  id                   TEXT PRIMARY KEY,
  navaid_ident         TEXT NOT NULL,
  name                 TEXT NOT NULL,
  navaid_type          TEXT,
  frequency_khz        INTEGER,
  lat                  REAL,
  lon                  REAL,
  elevation_ft         INTEGER,
  country_iso2         TEXT,
  usage_type           TEXT,
  power                TEXT,
  associated_airport   TEXT,
  airport_id           TEXT REFERENCES airports(id),
  updated_at           TEXT NOT NULL
);
CREATE INDEX navaids_airport_idx ON navaids(airport_id);
CREATE INDEX navaids_country_idx ON navaids(country_iso2);
