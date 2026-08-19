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
import type { MappedRecord } from './adapter.ts';
import type { SourceSpec } from './spec.ts';

export interface SinkResult {
  written: number;
  skipped: number;
  reasons: Record<string, number>;
}

function note(reasons: Record<string, number>, key: string): void {
  reasons[key] = (reasons[key] ?? 0) + 1;
}

export function writeRecords(db: Db, spec: SourceSpec, records: MappedRecord[]): Result<SinkResult> {
  ensureRegions(db);
  const result: SinkResult = { written: 0, skipped: 0, reasons: {} };

  const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  db.transaction(() => {
    for (const record of records) {
      const v = record.values;
      const iso2 = str(v.countryIso2);

      if (spec.entity === 'country') {
        const iso3 = str(v.countryIso3);
        const region = str(v.regionCode);
        if (!iso2 || !iso3 || !v.name) { result.skipped += 1; note(result.reasons, 'missing iso/name'); continue; }
        // Region comes from the spec when supplied, otherwise from the
        // subregion/region names the source carries.
        const regionCode = (region ?? mapRegion(str(v.subregion), str(v.region))) as RegionCode | null;
        if (!regionCode) { result.skipped += 1; note(result.reasons, 'unresolved region'); continue; }
        upsertCountry(db, {
          iso2, iso3, name: String(v.name), regionCode,
          currency: str(v.currency),
        });
        result.written += 1;
        continue;
      }

      const countryId = iso2
        ? db.get<{ id: string }>('SELECT id FROM countries WHERE iso2 = ?', iso2)?.id ?? null
        : null;
      if (!countryId) { result.skipped += 1; note(result.reasons, 'no matching country'); continue; }

      if (spec.entity === 'city') {
        if (!v.name) { result.skipped += 1; note(result.reasons, 'missing name'); continue; }
        upsertCity(db, {
          name: String(v.name), countryId, admin1: str(v.admin1),
          lat: num(v.lat) ?? 0, lon: num(v.lon) ?? 0,
          population: num(v.population), timezone: str(v.timezone),
        });
        result.written += 1;
        continue;
      }

      if (spec.entity === 'airport') {
        const region = str(v.regionCode) as RegionCode | null;
        if (!region) { result.skipped += 1; note(result.reasons, 'unresolved region'); continue; }
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
        upsertAirport(db, {
          id: makeId('airport', icao ?? iata ?? `${iso2}-${String(v.name)}`),
          iata: iata && iata.length === 3 ? iata : null,
          icao: icao && icao.length === 4 ? icao : null,
          name: String(v.name), cityId, countryId, regionCode: region,
          lat: num(v.lat) ?? 0, lon: num(v.lon) ?? 0,
          kind: v.scheduledService ? 'medium' : 'small',
        });
        result.written += 1;
        continue;
      }

      result.skipped += 1;
      note(result.reasons, `unsupported entity ${spec.entity}`);
    }
  });

  if (result.written === 0 && records.length > 0) {
    return err('internal', `${spec.id}: nothing could be written`, { reasons: result.reasons });
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
