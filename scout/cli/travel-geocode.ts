/**
 * npm run travel:geocode -- upgrade city-centroid coordinates to venue precision.
 *
 * Writes lat/lon as CLAIMS from OpenStreetMap (open_dataset, 0.70), which
 * outranks the seed dataset (0.35), so `truth:resolve` replaces the centroids
 * through the ordinary resolution path. This CLI never writes to `places`.
 *
 * Blocked in this environment: egress is closed by policy, so the fixture
 * transport serves only the recorded sample. To run it for real see the header
 * of scout/connectors/adapters/geocode.ts.
 */

import { openDb } from '../db/index.ts';
import { getPlace } from '../db/repo-places.ts';
import { getCity } from '../db/repo-core.ts';
import { upsertSource, recordClaim } from '../db/repo-truth.ts';
import {
  createGeocodeProvider, isVenueUpgrade, GEOCODE_PROVIDER_ID, GEOCODE_PROVIDER_META,
  GEOCODE_RATE_LIMIT_MS,
} from '../connectors/adapters/geocode.ts';
import { providerContext } from '../connectors/registry.ts';
import { SOURCE_AUTHORITY } from '../contracts/index.ts';
import { nowIso } from '../runtime/clock.ts';

const args = process.argv.slice(2);
const limit = Number(args.find((a) => a.startsWith('--limit='))?.slice(8) ?? 25);
const dryRun = args.includes('--dry-run');

const db = openDb();
const provider = createGeocodeProvider();
const ctx = providerContext();

upsertSource(db, {
  id: GEOCODE_PROVIDER_ID,
  name: GEOCODE_PROVIDER_META.name,
  sourceClass: 'open_dataset',
  authority: SOURCE_AUTHORITY.open_dataset,
  homepage: GEOCODE_PROVIDER_META.homepage,
  regionScope: [],
  freshnessTier: 'base',
  enabled: true,
});

const targets = db.all<{ id: string }>(
  `SELECT id FROM places
   WHERE lat IS NOT NULL AND (location_precision IS NULL OR location_precision <> 'venue')
   ORDER BY id LIMIT ?`,
  limit,
);

console.log(`transport: ${ctx.transport.mode}  targets: ${targets.length} (limit ${limit})`);
if (targets.length === 0) {
  console.log('nothing to upgrade — every place already has venue-precise coordinates');
  db.close();
  process.exit(0);
}

let upgraded = 0, rejected = 0, missed = 0, failed = 0;

for (const [index, row] of targets.entries()) {
  const place = getPlace(db, row.id);
  if (!place) continue;
  const city = getCity(db, place.cityId);
  if (!city) continue;
  const iso2 = city.countryId.replace('country:', '').toUpperCase();

  const result = await provider.fetch(ctx, {
    query: { name: place.name, city: city.name, countryIso2: iso2 } as unknown as Record<string, unknown>,
  });

  if (!result.ok) {
    failed += 1;
    console.log(`  MISS  ${place.name}: [${result.error.kind}] ${result.error.message}`);
  } else {
    const hit = result.value.items[0];
    if (!hit) {
      missed += 1;
      console.log(`  MISS  ${place.name}: no match`);
    } else if (!isVenueUpgrade(hit, { lat: city.lat, lon: city.lon })) {
      // Nominatim fell back to the settlement: that is the centroid again.
      rejected += 1;
      console.log(`  SAME  ${place.name}: hit resolves to the city, not the venue`);
    } else {
      upgraded += 1;
      console.log(`  OK    ${place.name}: ${hit.lat.toFixed(5)},${hit.lon.toFixed(5)} (${hit.category ?? 'n/a'})`);
      if (!dryRun) {
        const observedAt = nowIso();
        for (const [field, value] of [['lat', hit.lat], ['lon', hit.lon]] as const) {
          recordClaim(db, {
            sourceId: GEOCODE_PROVIDER_ID, entityType: 'place', entityId: place.id,
            field, value, observedAt,
          });
        }
      }
    }
  }

  // Nominatim allows 1 req/s. Respect it rather than getting the project banned.
  if (ctx.transport.mode === 'network' && index < targets.length - 1) {
    await new Promise((r) => setTimeout(r, GEOCODE_RATE_LIMIT_MS));
  }
}

console.log(
  `\n${upgraded} upgraded, ${rejected} resolved to the city, ${missed} no match, ${failed} failed` +
    (dryRun ? '  (dry run: no claims written)' : ''),
);
console.log('Run `npm run truth:resolve` to apply the winning coordinates.');
db.close();
