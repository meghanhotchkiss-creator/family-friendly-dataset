/**
 * Where mapped records land.
 *
 * Kept separate from the adapter on purpose: mapping/validation answers "did
 * this data survive, and if not why", persistence answers "where does it go".
 * Splitting them is what lets a dry run report a full funnel without writing.
 */

import type { Db } from '../db/index.ts';
import type { RegionCode, Result } from '../contracts/index.ts';
import { ok, err, makeId } from '../contracts/index.ts';
import {
  upsertCountry, upsertCity, upsertAirport, ensureRegions,
  upsertAdminRegion, upsertRunway, upsertFrequency, upsertNavaid,
} from '../db/repo-core.ts';
import { canonicalHash } from '../runtime/hash.ts';
import type { MappedRecord } from './adapter.ts';
import type { SourceSpec } from './spec.ts';
import type { ReasonCode } from './accounting.ts';

export interface SinkRejection {
  record: MappedRecord;
  reasonCode: ReasonCode;
  details: string;
}

export interface SinkResult {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Records that mapped cleanly but could not be persisted. */
  rejections: SinkRejection[];
  reasons: Record<string, number>;
}

function note(reasons: Record<string, number>, key: string): void {
  reasons[key] = (reasons[key] ?? 0) + 1;
}

/** Does this entity already exist, and is it identical? Drives insert/update/unchanged. */
function priorState(
  db: Db,
  table: string,
  idColumn: string,
  id: string,
): { exists: boolean; hash: string | null } {
  const row = db.get<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${idColumn} = ?`, id);
  if (!row) return { exists: false, hash: null };
  const copy = { ...row };
  delete copy.updated_at;
  return { exists: true, hash: canonicalHash(copy) };
}

export function writeRecords(db: Db, spec: SourceSpec, records: MappedRecord[]): Result<SinkResult> {
  ensureRegions(db);
  const result: SinkResult = { inserted: 0, updated: 0, unchanged: 0, rejections: [], reasons: {} };

  const reject = (record: MappedRecord, reasonCode: ReasonCode, details: string): void => {
    result.rejections.push({ record, reasonCode, details });
    note(result.reasons, reasonCode);
  };

  const settle = (before: { exists: boolean; hash: string | null }, after: { hash: string | null }): void => {
    if (!before.exists) result.inserted += 1;
    else if (before.hash === after.hash) result.unchanged += 1;
    else result.updated += 1;
  };

  /**
   * Every id this run has already written, so a second record claiming one is
   * caught instead of silently overwriting the first.
   *
   * This is the guard that was missing when 457 pairs of distinct airports
   * collapsed onto one id: the upsert succeeded, the funnel counted both rows
   * as imported, and the table was 457 rows shorter than the report claimed.
   * Cities are exempt -- many airports legitimately share one.
   */
  const claimed = new Set<string>();
  const claim = (record: MappedRecord, id: string): boolean => {
    if (claimed.has(id)) {
      reject(record, 'DUPLICATE_IDENTITY', `${id} was already written by an earlier record in this run`);
      return false;
    }
    claimed.add(id);
    return true;
  };

  const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  // Each record is written in its own savepoint: one bad row must not roll
  // back a 28,000-row run, and a database constraint is a rejection reason like
  // any other rather than a crash.
  for (const record of records) {
    try {
      db.transaction(() => {
      const v = record.values;
      const iso2 = str(v.countryIso2);

      if (spec.entity === 'country') {
        const iso3 = str(v.countryIso3);
        const region = str(v.regionCode);
        if (!iso2 || !iso3 || !v.name) {
          reject(record, 'MISSING_REQUIRED_FIELD', 'country needs iso2, iso3 and name');
          return;
        }
        // Region comes from the spec when supplied, otherwise from the
        // subregion/region names the source carries.
        const regionCode = (region ?? mapRegion(str(v.subregion), str(v.region))) as RegionCode | null;
        if (!regionCode) {
          reject(record, 'UNRESOLVED_GEOGRAPHY', `no region for ${iso2}`);
          return;
        }
        const id = makeId('country', iso2);
        if (!claim(record, id)) return;
        const before = priorState(db, 'countries', 'id', id);
        upsertCountry(db, { iso2, iso3, name: String(v.name), regionCode, currency: str(v.currency) });
        settle(before, { hash: priorState(db, 'countries', 'id', id).hash });
        return;
      }

      // These three describe an airport, not a place on the map: they carry no
      // country of their own and are resolved by OurAirports `ident`. Handled
      // before the country gate below, which would otherwise reject every one
      // of them for a country code they were never going to have.
      if (spec.entity === 'runway' || spec.entity === 'frequency' || spec.entity === 'navaid') {
        const ident = str(v.airportIdent);
        const airportId = ident
          ? db.get<{ id: string }>('SELECT id FROM airports WHERE ident = ?', ident)?.id ?? null
          : null;
        const sourceId = str(v.sourceId);
        if (!sourceId) {
          reject(record, 'MISSING_REQUIRED_FIELD', `${spec.entity} needs the upstream row id`);
          return;
        }

        if (spec.entity === 'navaid') {
          // A navaid's associated airport is genuinely optional upstream, so an
          // unmatched one is recorded with a null airport rather than dropped.
          const id = makeId('navaid', sourceId);
          if (!claim(record, id)) return;
          const before = priorState(db, 'navaids', 'id', id);
          upsertNavaid(db, {
            sourceId, navaidIdent: String(v.navaidIdent ?? ''), name: String(v.name ?? ''),
            navaidType: str(v.navaidType), frequencyKhz: num(v.frequencyKhz),
            lat: num(v.lat), lon: num(v.lon), elevationFt: num(v.elevationFt),
            countryIso2: iso2, usageType: str(v.usageType), power: str(v.power),
            associatedAirport: ident, airportId,
          });
          settle(before, { hash: priorState(db, 'navaids', 'id', id).hash });
          return;
        }

        // Runways and frequencies are meaningless without their airport.
        if (!airportId) {
          reject(record, 'NO_MATCHING_AIRPORT', `ident ${ident ?? '(none)'} is not in the airports table`);
          return;
        }
        if (spec.entity === 'runway') {
          const id = makeId('runway', sourceId);
          if (!claim(record, id)) return;
          const before = priorState(db, 'runways', 'id', id);
          upsertRunway(db, {
            sourceId, airportIdent: String(ident), airportId,
            lengthFt: num(v.lengthFt), widthFt: num(v.widthFt), surface: str(v.surface),
            lighted: v.lighted === null || v.lighted === undefined ? null : Boolean(v.lighted),
            closed: v.closed === null || v.closed === undefined ? null : Boolean(v.closed),
            leIdent: str(v.leIdent), heIdent: str(v.heIdent),
          });
          settle(before, { hash: priorState(db, 'runways', 'id', id).hash });
          return;
        }
        const id = makeId('frequency', sourceId);
        if (!claim(record, id)) return;
        const before = priorState(db, 'airport_frequencies', 'id', id);
        upsertFrequency(db, {
          sourceId, airportIdent: String(ident), airportId,
          frequencyType: str(v.frequencyType), description: str(v.description),
          frequencyMhz: num(v.frequencyMhz),
        });
        settle(before, { hash: priorState(db, 'airport_frequencies', 'id', id).hash });
        return;
      }

      const countryId = iso2
        ? db.get<{ id: string }>('SELECT id FROM countries WHERE iso2 = ?', iso2)?.id ?? null
        : null;
      if (!countryId) {
        reject(record, 'NO_MATCHING_COUNTRY', `iso2 ${iso2 ?? '(none)'} is not in the countries table`);
        return;
      }

      if (spec.entity === 'admin_region') {
        const code = str(v.code);
        if (!code || !v.name) {
          reject(record, 'MISSING_REQUIRED_FIELD', 'admin region needs a code and a name');
          return;
        }
        const id = makeId('admin_region', code);
        if (!claim(record, id)) return;
        const before = priorState(db, 'admin_regions', 'id', id);
        upsertAdminRegion(db, {
          code, localCode: str(v.localCode), name: String(v.name),
          continent: str(v.continent), countryIso2: String(iso2), countryId,
          wikipediaLink: str(v.wikipediaLink),
        });
        settle(before, { hash: priorState(db, 'admin_regions', 'id', id).hash });
        return;
      }

      if (spec.entity === 'city') {
        if (!v.name) { reject(record, 'MISSING_REQUIRED_FIELD', 'city needs a name'); return; }
        const cityId = makeId('city', countryId.replace('country:', ''), str(v.admin1) ?? '', String(v.name));
        const before = priorState(db, 'cities', 'id', cityId);
        upsertCity(db, {
          id: cityId,
          name: String(v.name), countryId, admin1: str(v.admin1),
          lat: num(v.lat) ?? 0, lon: num(v.lon) ?? 0,
          population: num(v.population), timezone: str(v.timezone),
          geonameId: num(v.geonameId),
        } as never);
        settle(before, { hash: priorState(db, 'cities', 'id', cityId).hash });
        return;
      }

      if (spec.entity === 'airport') {
        const region = str(v.regionCode) as RegionCode | null;
        if (!region) {
          reject(record, 'UNRESOLVED_GEOGRAPHY', `no region for airport in ${iso2 ?? '(unknown)'}`);
          return;
        }
        const city = str(v.city);
        // Two vocabularies for one idea. `admin1` is the readable region name
        // from admin_regions ("England"), which is what an airport row should
        // show. `admin1Code` is the ISO 3166-2 subdivision ("ENG"), which is
        // what a city id is built from -- GeoNames keys cities on the code, so
        // storing the name here forged a second London for every city both
        // sources know about.
        const admin1 = str(v.admin1);
        const admin1Code = str(v.admin1Code);
        const cityId = city
          ? upsertCity(db, {
              name: city, countryId, admin1: admin1Code,
              lat: num(v.lat) ?? 0, lon: num(v.lon) ?? 0,
              population: null, timezone: null,
            })
          : null;
        // Length-checked once, so the id and the stored columns agree. A
        // two-letter value in an `iata_code` column is not an IATA code, and
        // deriving the id from it while storing null put the same airport under
        // two different ids depending on which source loaded it.
        const rawIata = str(v.iata);
        const rawIcao = str(v.icao);
        const iata = rawIata && rawIata.length === 3 ? rawIata : null;
        const icao = rawIcao && rawIcao.length === 4 ? rawIcao : null;
        // IATA first, matching repo-core.upsertAirport and the fixture
        // importer. Deriving it as icao-first gave the same physical airport
        // two ids depending on which source loaded it, which collided on the
        // UNIQUE iata index the moment both ran.
        // `ident` is OurAirports' own key, unique across the file, and it is
        // NAMESPACED here. Folding it into the same slug space as IATA and ICAO
        // collapsed 54 pairs of genuinely different airports -- one airport's
        // three-letter local ident is another's IATA code -- and the funnel
        // still called all of them imported.
        const ident = str(v.ident);
        const airportId = iata
          ? makeId('airport', iata)
          : icao
            ? makeId('airport', icao)
            : ident
              ? makeId('airport', 'ident', ident)
              : makeId('airport', `${iso2}-${String(v.name)}`);
        if (!claim(record, airportId)) return;
        const before = priorState(db, 'airports', 'id', airportId);
        upsertAirport(db, {
          id: airportId,
          iata, icao,
          name: String(v.name), cityId, countryId, regionCode: region,
          lat: num(v.lat) ?? 0, lon: num(v.lon) ?? 0,
          kind: airportKind(str(v.airportType), Boolean(v.scheduledService)),
          geonameId: num(v.geonameId),
          cityGeonameId: num(v.cityGeonameId),
          ident, gpsCode: str(v.gpsCode), localCode: str(v.localCode),
          isoRegion: str(v.isoRegion), admin1,
          airportType: str(v.airportType), elevationFt: num(v.elevationFt),
          scheduledService: v.scheduledService === null || v.scheduledService === undefined
            ? null
            : Boolean(v.scheduledService),
          homeLink: str(v.homeLink), wikipediaLink: str(v.wikipediaLink),
        });
        settle(before, { hash: priorState(db, 'airports', 'id', airportId).hash });
        return;
      }

      reject(record, 'UNSUPPORTED_ENTITY', `no sink for entity ${spec.entity}`);
      });
    } catch (cause) {
      reject(
        record,
        'PERSIST_FAILED',
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }

  return ok(result);
}

/**
 * OurAirports' seven-way `type` collapsed onto the three sizes the recommender
 * uses. Previously `kind` was guessed from IATA presence alone, because the
 * airportsdata wheel carried no size column and nothing could ever be `large`.
 * Now it is read from the source, and IATA presence is only the fallback for a
 * feed that still does not classify.
 */
export function airportKind(airportType: string | null, scheduledService: boolean): 'large' | 'medium' | 'small' {
  switch (airportType) {
    case 'large_airport': return 'large';
    case 'medium_airport': return 'medium';
    case 'small_airport':
    case 'heliport':
    case 'seaplane_base':
    case 'balloonport':
    case 'closed': return 'small';
    default: return scheduledService ? 'medium' : 'small';
  }
}

const SUBREGION_TO_FLAG: Readonly<Record<string, RegionCode>> = {
  'northern america': 'NA', 'central america': 'CA', 'caribbean': 'CA',
  'south america': 'SA', 'northern europe': 'EU', 'western europe': 'EU',
  'southern europe': 'EU', 'eastern europe': 'EU', 'central europe': 'EU',
  'western asia': 'ME', 'central asia': 'AS', 'eastern asia': 'AS',
  'south-eastern asia': 'AS', 'southern asia': 'AS',
  'northern africa': 'AF', 'sub-saharan africa': 'AF', 'western africa': 'AF',
  'eastern africa': 'AF', 'middle africa': 'AF', 'southern africa': 'AF',
  'australia and new zealand': 'OC', 'melanesia': 'OC', 'micronesia': 'OC', 'polynesia': 'OC',
};

const REGION_TO_FLAG: Readonly<Record<string, RegionCode>> = {
  americas: 'NA', europe: 'EU', africa: 'AF', asia: 'AS', oceania: 'OC', antarctic: 'OC',
};

export function mapRegion(subregion: string | null, region: string | null): RegionCode | null {
  if (subregion) {
    const hit = SUBREGION_TO_FLAG[subregion.trim().toLowerCase()];
    if (hit) return hit;
  }
  if (region) {
    const hit = REGION_TO_FLAG[region.trim().toLowerCase()];
    if (hit) return hit;
  }
  return null;
}
