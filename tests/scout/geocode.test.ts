import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGeocodeProvider, geocodeUrl, normalizeHit, isVenueUpgrade,
  GEOCODE_PROVIDER_ID, GEOCODE_RATE_LIMIT_MS,
} from '../../scout/connectors/adapters/geocode.ts';
import { SOURCE_AUTHORITY } from '../../scout/contracts/index.ts';

test('geocoder outranks the seed dataset so it can replace centroids', () => {
  const p = createGeocodeProvider();
  assert.equal(p.id, GEOCODE_PROVIDER_ID);
  assert.equal(p.sourceClass, 'open_dataset');
  assert.equal(p.authority, SOURCE_AUTHORITY.open_dataset);
  assert.ok(p.authority > SOURCE_AUTHORITY.seed,
    'must outrank seed, or the Truth Engine would keep the centroid');
});

test('builds a real Nominatim request', () => {
  const url = geocodeUrl({ name: 'Field Museum', city: 'Chicago', countryIso2: 'US' }, 'me@example.org');
  assert.ok(url.startsWith('https://nominatim.openstreetmap.org/search?'));
  const q = new URL(url).searchParams;
  assert.equal(q.get('q'), 'Field Museum, Chicago');
  assert.equal(q.get('countrycodes'), 'us');
  assert.equal(q.get('format'), 'jsonv2');
  assert.equal(q.get('limit'), '1');
  assert.equal(q.get('email'), 'me@example.org');
});

test('parses jsonv2 string coordinates and rejects impossible ones', () => {
  const hit = normalizeHit({ lat: '48.8582599', lon: '2.2945006', display_name: 'Eiffel Tower', importance: 0.68, osm_type: 'way', category: 'tourism' });
  assert.ok(hit);
  assert.equal(hit.lat, 48.8582599);
  assert.equal(hit.category, 'tourism');

  assert.equal(normalizeHit({ lat: 'abc', lon: '2.29' }), null);
  assert.equal(normalizeHit({ lat: '91', lon: '0' }), null, 'latitude past the pole');
  assert.equal(normalizeHit({ lat: '0', lon: '181' }), null, 'longitude past the meridian');
  assert.equal(normalizeHit({}), null);
});

test('a hit that resolves back to the city is not an upgrade', () => {
  // The failure that matters: Nominatim falls back to the settlement when it
  // cannot find the venue, handing back the very centroid we are replacing --
  // but with a HIGHER authority attached, which would lock the bad value in.
  const paris = { lat: 48.8566, lon: 2.3522 };
  const venue = { lat: 48.8582599, lon: 2.2945006, displayName: '', importance: 0.68, osmType: 'way', category: 'tourism' };
  const cityFallback = { lat: 48.8566, lon: 2.3522, displayName: 'Paris', importance: 0.9, osmType: 'relation', category: 'place' };
  const boundary = { lat: 48.9, lon: 2.4, displayName: 'Paris', importance: 0.9, osmType: 'relation', category: 'boundary' };
  const tooClose = { lat: 48.8567, lon: 2.3523, displayName: 'x', importance: 0.5, osmType: 'node', category: 'tourism' };

  assert.equal(isVenueUpgrade(venue, paris), true);
  assert.equal(isVenueUpgrade(cityFallback, paris), false, 'place category is the city itself');
  assert.equal(isVenueUpgrade(boundary, paris), false, 'boundary is never a venue');
  assert.equal(isVenueUpgrade(tooClose, paris), false, 'within 150m of the centre');
});

test('respects Nominatim rate limits', () => {
  assert.ok(GEOCODE_RATE_LIMIT_MS >= 1000, 'Nominatim allows 1 request per second');
});
