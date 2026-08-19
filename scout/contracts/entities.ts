/** Travel Graph entity shapes. These mirror the columns in scout/db/migrations. */

import type { EntityId } from './ids.ts';

/** Region flags used by the global import framework. */
export const REGION_CODES = ['NA', 'CA', 'SA', 'EU', 'ME', 'AF', 'AS', 'OC'] as const;
export type RegionCode = (typeof REGION_CODES)[number];

export const REGION_LABELS: Readonly<Record<RegionCode, string>> = {
  NA: 'North America',
  CA: 'Central America & Caribbean',
  SA: 'South America',
  EU: 'Europe',
  ME: 'Middle East',
  AF: 'Africa',
  AS: 'Asia',
  OC: 'Oceania',
};

export const PLACE_CATEGORIES = [
  'museum', 'park', 'zoo', 'aquarium', 'library', 'beach', 'landmark',
  'theme_park', 'historic_site', 'market', 'viewpoint', 'trail',
  'restaurant', 'cafe', 'playground', 'science_center', 'garden', 'transit',
] as const;
export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];

export const PRICE_TIERS = ['free', '$', '$$', '$$$'] as const;
export type PriceTier = (typeof PRICE_TIERS)[number];

export const INDOOR_OUTDOOR = ['indoor', 'outdoor', 'mixed'] as const;
export type IndoorOutdoor = (typeof INDOOR_OUTDOOR)[number];

export interface Region { id: EntityId; code: RegionCode; name: string }

export interface Country {
  id: EntityId; iso2: string; iso3: string; name: string;
  regionCode: RegionCode; currency: string | null;
}

export interface City {
  id: EntityId; name: string; countryId: EntityId; admin1: string | null;
  lat: number; lon: number; population: number | null; timezone: string | null;
}

export interface Neighborhood {
  id: EntityId; cityId: EntityId; name: string;
  lat: number | null; lon: number | null;
  /** 0..1 how residential/local the area reads. */
  localCharacter: number | null;
}

export interface Airport {
  id: EntityId; iata: string | null; icao: string | null; name: string;
  cityId: EntityId | null; countryId: EntityId; regionCode: RegionCode;
  lat: number; lon: number; kind: 'large' | 'medium' | 'small';
}

export interface Place {
  id: EntityId;
  name: string;
  cityId: EntityId;
  neighborhoodId: EntityId | null;
  lat: number | null;
  lon: number | null;
  category: PlaceCategory;
  subcategory: string | null;
  priceTier: PriceTier | null;
  indoorOutdoor: IndoorOutdoor | null;
  rating: number | null;
  minAge: number | null;
  maxAge: number | null;
  durationMinutes: number | null;
  /** 0..1. High means heavily visited by tourists. */
  touristiness: number | null;
  /** 0..1. High means locals actually go. */
  localFavor: number | null;
  description: string | null;
  /** Hash of the canonical field set, for change detection. */
  canonicalHash: string | null;
  updatedAt: string;
}

export interface Vibe { id: EntityId; slug: string; label: string }

export interface Trip {
  id: EntityId; userId: EntityId; title: string;
  destinationCityId: EntityId | null;
  startDate: string | null; endDate: string | null;
  status: 'draft' | 'planned' | 'active' | 'complete';
}

export const CONSTRAINT_KINDS = [
  'budget', 'mobility', 'nap_window', 'max_travel_minutes', 'dietary',
  'accessibility', 'avoid_category', 'require_indoor', 'party_size',
] as const;
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

export interface Constraint {
  id: string; userId: EntityId | null; tripId: EntityId | null;
  kind: ConstraintKind; value: unknown;
  /** Hard constraints filter; soft constraints only penalise. */
  hard: boolean;
}
