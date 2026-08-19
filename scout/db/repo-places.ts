/**
 * Shared place access. Read by Intelligence, Radar and Connectors, so it is
 * owned centrally: one row->Place mapping, one canonical hash rule.
 */

import type { Db } from './index.ts';
import type { Place, PlaceCategory, PriceTier, IndoorOutdoor } from '../contracts/index.ts';
import { canonicalHash } from '../runtime/hash.ts';
import { nowIso } from '../runtime/clock.ts';

/** Fields that define a place's identity for change detection. */
export const CANONICAL_FIELDS = [
  'name', 'category', 'priceTier', 'indoorOutdoor', 'lat', 'lon',
  'minAge', 'maxAge', 'durationMinutes', 'description',
] as const;

export function computeCanonicalHash(place: Partial<Place>): string {
  const subset: Record<string, unknown> = {};
  for (const field of CANONICAL_FIELDS) subset[field] = place[field] ?? null;
  return canonicalHash(subset);
}

export function rowToPlace(row: Record<string, unknown>): Place {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    id: String(row.id),
    name: String(row.name),
    cityId: String(row.city_id),
    neighborhoodId: (row.neighborhood_id as string) ?? null,
    lat: num(row.lat), lon: num(row.lon),
    category: row.category as PlaceCategory,
    subcategory: (row.subcategory as string) ?? null,
    priceTier: (row.price_tier as PriceTier) ?? null,
    indoorOutdoor: (row.indoor_outdoor as IndoorOutdoor) ?? null,
    rating: num(row.rating),
    minAge: num(row.min_age), maxAge: num(row.max_age),
    durationMinutes: num(row.duration_minutes),
    touristiness: num(row.touristiness), localFavor: num(row.local_favor),
    description: (row.description as string) ?? null,
    canonicalHash: (row.canonical_hash as string) ?? null,
    updatedAt: String(row.updated_at),
  };
}

export function upsertPlace(db: Db, place: Place): string {
  const hash = place.canonicalHash ?? computeCanonicalHash(place);
  db.run(
    `INSERT INTO places (id, name, city_id, neighborhood_id, lat, lon, category, subcategory,
       price_tier, indoor_outdoor, rating, min_age, max_age, duration_minutes,
       touristiness, local_favor, description, canonical_hash, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, city_id = excluded.city_id,
       neighborhood_id = excluded.neighborhood_id, lat = excluded.lat, lon = excluded.lon,
       category = excluded.category, subcategory = excluded.subcategory,
       price_tier = excluded.price_tier, indoor_outdoor = excluded.indoor_outdoor,
       rating = excluded.rating, min_age = excluded.min_age, max_age = excluded.max_age,
       duration_minutes = excluded.duration_minutes, touristiness = excluded.touristiness,
       local_favor = excluded.local_favor, description = excluded.description,
       canonical_hash = excluded.canonical_hash, updated_at = excluded.updated_at`,
    place.id, place.name, place.cityId, place.neighborhoodId, place.lat, place.lon,
    place.category, place.subcategory, place.priceTier, place.indoorOutdoor, place.rating,
    place.minAge, place.maxAge, place.durationMinutes, place.touristiness, place.localFavor,
    place.description, hash, place.updatedAt || nowIso(),
  );
  return place.id;
}

export function getPlace(db: Db, id: string): Place | undefined {
  const row = db.get<Record<string, unknown>>('SELECT * FROM places WHERE id = ?', id);
  return row ? rowToPlace(row) : undefined;
}

export function listPlacesByCity(db: Db, cityId: string, limit = 500): Place[] {
  return db
    .all<Record<string, unknown>>('SELECT * FROM places WHERE city_id = ? LIMIT ?', cityId, limit)
    .map(rowToPlace);
}

export function listAllPlaces(db: Db, limit = 5000): Place[] {
  return db.all<Record<string, unknown>>('SELECT * FROM places LIMIT ?', limit).map(rowToPlace);
}

/** Apply one resolved field onto a place. Used by the Truth Engine only. */
export function applyResolvedField(db: Db, placeId: string, column: string, value: unknown): boolean {
  const ALLOWED = new Set([
    'name', 'category', 'price_tier', 'indoor_outdoor', 'rating', 'min_age', 'max_age',
    'duration_minutes', 'touristiness', 'local_favor', 'description', 'lat', 'lon',
    'neighborhood_id',
  ]);
  if (!ALLOWED.has(column)) return false;
  const scalar =
    value === null || typeof value === 'number' || typeof value === 'string'
      ? value
      : JSON.stringify(value);
  db.run(`UPDATE places SET ${column} = ?, updated_at = ? WHERE id = ?`, scalar, nowIso(), placeId);
  const place = getPlace(db, placeId);
  if (place) {
    db.run('UPDATE places SET canonical_hash = ? WHERE id = ?', computeCanonicalHash(place), placeId);
  }
  return true;
}
