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
import { upsertCountry, upsertCity, upsertAirport, ensureRegions } from '../db/repo-core.ts';
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
        const before = priorState(db, 'countries', 'id', id);
        upsertCountry(db, { iso2, iso3, name: String(v.name), regionCode, currency: str(v.currency) });
        settle(before, { hash: priorState(db, 'countries', 'id', id).hash });
        return;
      }

      const countryId = iso2
        ? db.get<{ id: string }>('SELECT id FROM countries WHERE iso2 = ?', iso2)?.id ?? null
        : null;
      if (!countryId) {
        reject(record, 'NO_MATCHING_COUNTRY', `iso2 ${iso2 ?? '(none)'} is not in the countries table`);
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
        const cityId = city
          ? upsertCity(db, {
              name: city, countryId, admin1: str(v.admin1),
              lat: num(v.lat) ?? 0, lon: num(v.lon) ?? 0,
              population: null, timezone: null,
            })
          : null;
        const iata = str(v.iata);
        const icao = str(v.icao);
        // IATA first, matching repo-core.upsertAirport and the fixture
        // importer. Deriving it as icao-first gave the same physical airport
        // two ids depending on which source loaded it, which collided on the
        // UNIQUE iata index the moment both ran.
        const airportId = makeId('airport', iata ?? icao ?? `${iso2}-${String(v.name)}`);
        const before = priorState(db, 'airports', 'id', airportId);
        upsertAirport(db, {
          id: airportId,
          iata: iata && iata.length === 3 ? iata : null,
          icao: icao && icao.length === 4 ? icao : null,
          name: String(v.name), cityId, countryId, regionCode: region,
          lat: num(v.lat) ?? 0, lon: num(v.lon) ?? 0,
          kind: v.scheduledService ? 'medium' : 'small',
          geonameId: num(v.geonameId),
          cityGeonameId: num(v.cityGeonameId),
        } as never);
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
