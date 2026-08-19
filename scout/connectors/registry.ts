/**
 * The provider registry: one list of every integration Scout has, and the one
 * way to put that list into the database.
 *
 * Registration writes two rows per provider under the SAME id -- one in
 * `providers` (what Sentinel monitors) and one in `sources` (what the Truth
 * Engine weighs). That shared id is what lets a claim recorded by an importer
 * be traced back to the connector that produced it.
 */

import type {
  Provider,
  ProviderContext,
  ProviderCredentials,
  ProviderKind,
  Result,
  Source,
  Transport,
} from '../contracts/index.ts';
import { err, ok } from '../contracts/index.ts';
import type { Db } from '../db/index.ts';
import { upsertSource } from '../db/repo-truth.ts';
import { nowIso } from '../runtime/clock.ts';
import { defaultTransport } from './transport.ts';
import { GEOGRAPHY_PROVIDER_META, createGeographyProvider } from './adapters/geography.ts';
import { AIRPORTS_PROVIDER_META, createAirportsProvider } from './adapters/airports.ts';
import { PLACES_PROVIDER_META, createPlacesProvider } from './adapters/places.ts';
import { GTFS_PROVIDER_META, createGtfsProvider } from './adapters/gtfs.ts';
import { WEATHER_PROVIDER_META, createWeatherProvider } from './adapters/weather.ts';

export interface ProviderDescriptor {
  readonly provider: Provider;
  /** Human name, used for the `sources` row and for CLI output. */
  readonly name: string;
  readonly homepage: string;
}

/**
 * Providers are stateless, so one instance each is built at module load and
 * handed out by reference: `providerById(x) === providerById(x)`.
 */
const DESCRIPTORS: readonly ProviderDescriptor[] = [
  { provider: createGeographyProvider(), name: GEOGRAPHY_PROVIDER_META.name, homepage: GEOGRAPHY_PROVIDER_META.homepage },
  { provider: createAirportsProvider(), name: AIRPORTS_PROVIDER_META.name, homepage: AIRPORTS_PROVIDER_META.homepage },
  { provider: createPlacesProvider(), name: PLACES_PROVIDER_META.name, homepage: PLACES_PROVIDER_META.homepage },
  { provider: createGtfsProvider(), name: GTFS_PROVIDER_META.name, homepage: GTFS_PROVIDER_META.homepage },
  { provider: createWeatherProvider(), name: WEATHER_PROVIDER_META.name, homepage: WEATHER_PROVIDER_META.homepage },
];

const BY_ID: ReadonlyMap<string, ProviderDescriptor> = new Map(
  DESCRIPTORS.map((d) => [d.provider.id, d]),
);

export function allProviderDescriptors(): ProviderDescriptor[] {
  return [...DESCRIPTORS];
}

export function allProviders(): Provider[] {
  return DESCRIPTORS.map((d) => d.provider);
}

export function providerById(id: string): Provider | undefined {
  return BY_ID.get(id)?.provider;
}

export function descriptorById(id: string): ProviderDescriptor | undefined {
  return BY_ID.get(id);
}

export function providersByKind(kind: ProviderKind): Provider[] {
  return DESCRIPTORS.filter((d) => d.provider.kind === kind).map((d) => d.provider);
}

/* ------------------------------------------------------------------ *
 * Context
 * ------------------------------------------------------------------ */

/**
 * Credentials come from the environment, never from code:
 *
 *   SCOUT_<KIND>_API_KEY   e.g. SCOUT_PLACES_API_KEY, SCOUT_WEATHER_API_KEY
 *   SCOUT_API_KEY          fallback for single-vendor deployments
 *
 * `SCOUT_<KIND>_CLIENT_ID` / `_CLIENT_SECRET` follow the same rule for the
 * OAuth-style providers a later track adds.
 */
export function credentialsFromEnv(kind?: ProviderKind): ProviderCredentials {
  const prefix = kind ? `SCOUT_${kind.toUpperCase()}` : 'SCOUT';
  const env = process.env;
  const pick = (suffix: string): string | undefined =>
    env[`${prefix}_${suffix}`] ?? env[`SCOUT_${suffix}`];
  return {
    apiKey: pick('API_KEY'),
    clientId: pick('CLIENT_ID'),
    clientSecret: pick('CLIENT_SECRET'),
  };
}

/**
 * The default context: the transport SCOUT_TRANSPORT selects, credentials from
 * the environment and the one clock.
 */
export function providerContext(overrides?: Partial<ProviderContext>): ProviderContext {
  const transport: Transport = overrides?.transport ?? defaultTransport();
  return {
    transport,
    credentials: overrides?.credentials ?? credentialsFromEnv(),
    now: overrides?.now ?? nowIso,
  };
}

/**
 * The context to hand one provider: same transport and clock, but that
 * provider's own credentials, so a missing places key never looks like a
 * missing weather key.
 */
export function contextFor(provider: Provider, base?: ProviderContext): ProviderContext {
  const ctx = base ?? providerContext();
  const scoped = credentialsFromEnv(provider.kind);
  const apiKey = scoped.apiKey ?? ctx.credentials.apiKey;
  const clientId = scoped.clientId ?? ctx.credentials.clientId;
  const clientSecret = scoped.clientSecret ?? ctx.credentials.clientSecret;
  return { transport: ctx.transport, now: ctx.now, credentials: { apiKey, clientId, clientSecret } };
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

export function sourceForProvider(descriptor: ProviderDescriptor): Source {
  const provider = descriptor.provider;
  return {
    id: provider.id,
    name: descriptor.name,
    sourceClass: provider.sourceClass,
    authority: provider.authority,
    homepage: descriptor.homepage,
    regionScope: [...provider.regionScope],
    freshnessTier: provider.freshnessTier,
    enabled: true,
  };
}

/**
 * Write every provider into `providers` and a matching row into `sources`.
 * Idempotent: re-registering updates in place and creates nothing new.
 */
export function registerProvidersInDb(db: Db): Result<{ providers: number; sources: number }> {
  try {
    return ok(
      db.transaction(() => {
        let providers = 0;
        let sources = 0;
        for (const descriptor of DESCRIPTORS) {
          const provider = descriptor.provider;
          db.run(
            `INSERT INTO providers (id, kind, source_class, authority, freshness_tier, region_scope, enabled, config_json)
             VALUES (?,?,?,?,?,?,1,?)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind, source_class = excluded.source_class,
               authority = excluded.authority, freshness_tier = excluded.freshness_tier,
               region_scope = excluded.region_scope, config_json = excluded.config_json`,
            provider.id,
            provider.kind,
            provider.sourceClass,
            provider.authority,
            provider.freshnessTier,
            JSON.stringify(provider.regionScope),
            JSON.stringify({ name: descriptor.name, homepage: descriptor.homepage }),
          );
          providers += 1;
          upsertSource(db, sourceForProvider(descriptor));
          sources += 1;
        }
        return { providers, sources };
      }),
    );
  } catch (cause) {
    return err(
      'internal',
      `failed to register providers: ${cause instanceof Error ? cause.message : String(cause)}`,
      {},
      cause,
    );
  }
}
