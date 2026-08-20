-- Geography spine of the Travel Graph. Region codes are the flags the global
-- import framework filters on (NA CA SA EU ME AF AS OC).

CREATE TABLE regions (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL
);

CREATE TABLE countries (
  id          TEXT PRIMARY KEY,
  iso2        TEXT NOT NULL UNIQUE,
  iso3        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  region_code TEXT NOT NULL REFERENCES regions(code),
  currency    TEXT,
  updated_at  TEXT NOT NULL
);
CREATE INDEX countries_region_idx ON countries(region_code);

CREATE TABLE cities (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  country_id  TEXT NOT NULL REFERENCES countries(id),
  admin1      TEXT,
  lat         REAL,
  lon         REAL,
  population  INTEGER,
  timezone    TEXT,
  updated_at  TEXT NOT NULL
);
CREATE INDEX cities_country_idx ON cities(country_id);
CREATE INDEX cities_name_idx ON cities(name);

CREATE TABLE neighborhoods (
  id              TEXT PRIMARY KEY,
  city_id         TEXT NOT NULL REFERENCES cities(id),
  name            TEXT NOT NULL,
  lat             REAL,
  lon             REAL,
  -- 0..1 how residential/local the area reads, used by the "not touristy" intent
  local_character REAL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX neighborhoods_city_idx ON neighborhoods(city_id);

CREATE TABLE airports (
  id          TEXT PRIMARY KEY,
  iata        TEXT,
  icao        TEXT,
  name        TEXT NOT NULL,
  city_id     TEXT REFERENCES cities(id),
  country_id  TEXT NOT NULL REFERENCES countries(id),
  region_code TEXT NOT NULL REFERENCES regions(code),
  lat         REAL,
  lon         REAL,
  kind        TEXT NOT NULL CHECK (kind IN ('large','medium','small')),
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX airports_iata_idx ON airports(iata) WHERE iata IS NOT NULL;
CREATE INDEX airports_region_idx ON airports(region_code);
CREATE INDEX airports_city_idx ON airports(city_id);
