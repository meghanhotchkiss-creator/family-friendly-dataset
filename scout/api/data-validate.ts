/**
 * The geography validation report.
 *
 * "28,291 airports imported" was true and useless: the run that produced it had
 * quietly dropped every airport outside four regions. So the report is written
 * as a set of questions an operator would actually ask before trusting the
 * data -- how many arrived, how many landed, which countries failed to resolve,
 * which coordinates are missing, which rows collapsed onto one id -- and it
 * ends in a verdict rather than a number.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/index.ts';
import { nowIso } from '../runtime/clock.ts';
import { DEFAULT_OFFLINE_DIR } from '../connectors/offline.ts';

/**
 * The nine countries the report asserts on.
 *
 * Chosen to break a resolver that only works for the places its author lives:
 * a non-US federal state (BR, IN, AU, CA), a country whose ISO regions are
 * nations rather than states (GB), one with numeric region codes (JP), one
 * outside the Euro-American default (ZA), and the two the pipeline was
 * originally written against (US, FR).
 */
export const TEST_COUNTRIES = ['GB', 'FR', 'JP', 'AU', 'ZA', 'US', 'CA', 'BR', 'IN'] as const;

export interface SourceFunnel {
  sourceId: string;
  status: string;
  ranAt: string | null;
  sourceRows: number;
  imported: number;
  quarantined: number;
  balanced: boolean;
  byReason: Record<string, number>;
}

export interface AirportValidation {
  sourceRows: number;
  imported: number;
  rejected: number;
  unresolvedCountry: number;
  unresolvedRegion: number;
  missingCoordinates: number;
  duplicateIdentity: number;
  /** Rows in the table vs distinct upstream idents: these must not diverge. */
  storedRows: number;
  distinctIdents: number;
  unresolvedCountryCodes: string[];
}

export interface CountryCheck {
  iso2: string;
  name: string | null;
  regionCode: string | null;
  airports: number;
  airportsWithAdmin1: number;
  adminRegions: number;
  ok: boolean;
  problems: string[];
}

/**
 * Cities that two sources describe differently enough to have become two rows.
 *
 * Measured rather than assumed, because the honest answer today is "some". A
 * city id is `country + admin1 + name`, and GeoNames writes admin1 as its own
 * code while OurAirports writes an ISO 3166-2 subdivision. The two agree for
 * some countries (GB: both say ENG) and not others (Ontario is `08` to GeoNames
 * and `ON` to ISO), so the join survives on name and geography, which is
 * entity resolution's job, not the sink's.
 *
 * Same name and same country alone would not measure this -- the United States
 * has twenty-two distinct Washingtons -- so a group counts only when the rows
 * are also within CITY_MATCH_KM of each other.
 */
export interface CityDuplication {
  /** Name groups holding rows that are also in the same place. */
  groups: number;
  /** Rows above one per group: the size of the reconciliation still owed. */
  excessRows: number;
  worst: { name: string; iso2: string; rows: number; admin1s: string[] }[];
}

/**
 * OurAirports' own country list, checked against ours.
 *
 * `countries.csv` is vendored but deliberately not ingested: it carries no
 * ISO-3 code and no currency, both of which the schema requires, so it cannot
 * be the country authority. What it can do is disagree -- and a country it
 * knows that we do not is a country whose airports will silently fail to
 * resolve, which is worth knowing before the funnel reports it as loss.
 */
export interface CountryRoster {
  checked: boolean;
  listed: number;
  matched: number;
  missing: { code: string; name: string }[];
  note: string;
}

export function checkCountryRoster(db: Db, dir: string = DEFAULT_OFFLINE_DIR): CountryRoster {
  const path = join(dir, 'ourairports-data', 'countries.csv');
  if (!existsSync(path)) {
    return {
      checked: false, listed: 0, matched: 0, missing: [],
      note: `not checked: ${path} is not present (run npm run data:fetch)`,
    };
  }
  const [header = '', ...rows] = readFileSync(path, 'utf8').trim().split('\n');
  const columns = header.split(',').map((c) => c.replace(/^"|"$/g, ''));
  const codeAt = columns.indexOf('code');
  const nameAt = columns.indexOf('name');
  const known = new Set(db.all<{ iso2: string }>('SELECT iso2 FROM countries').map((r) => r.iso2));

  const missing: { code: string; name: string }[] = [];
  let listed = 0;
  for (const line of rows) {
    // The roster columns carry no embedded commas, so a split is enough here;
    // anything that needs real CSV parsing goes through the adapter instead.
    const cells = line.split(',').map((c) => c.replace(/^"|"$/g, ''));
    const code = (cells[codeAt] ?? '').toUpperCase();
    if (!code) continue;
    listed += 1;
    if (!known.has(code)) missing.push({ code, name: cells[nameAt] ?? '' });
  }
  return {
    checked: true, listed, matched: listed - missing.length, missing,
    note: missing.length === 0
      ? 'every country OurAirports lists is in the countries table'
      : `${missing.length} listed by OurAirports and absent from the countries table`,
  };
}

export interface GeographyReport {
  generatedAt: string;
  coverage: Record<string, number>;
  funnels: SourceFunnel[];
  airports: AirportValidation;
  testCountries: CountryCheck[];
  countryRoster: CountryRoster;
  cityDuplication: CityDuplication;
  failures: string[];
  /** Known, measured gaps. Real, but not grounds to fail a build. */
  warnings: string[];
}

const count = (db: Db, table: string): number =>
  Number(db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)?.n ?? 0);

/** The most recent run per source, with its quarantine broken out by reason. */
export function sourceFunnels(db: Db): SourceFunnel[] {
  const runs = db.all<Record<string, unknown>>(
    `SELECT r.* FROM ingestion_runs r
     JOIN (SELECT source_id, MAX(started_at) started_at FROM ingestion_runs GROUP BY source_id) latest
       ON latest.source_id = r.source_id AND latest.started_at = r.started_at
     ORDER BY r.source_id`,
  );
  return runs.map((r) => {
    const byReason: Record<string, number> = {};
    for (const row of db.all<{ reason_code: string; n: number }>(
      'SELECT reason_code, COUNT(*) n FROM quarantine WHERE run_id = ? GROUP BY reason_code',
      String(r.run_id),
    )) {
      byReason[row.reason_code] = Number(row.n);
    }
    return {
      sourceId: String(r.source_id),
      status: String(r.status),
      ranAt: (r.finished_at as string) ?? null,
      sourceRows: Number(r.source_rows ?? 0),
      // What landed, not what was offered to the sink. `imported` alone counts
      // records that passed validation, so a run could report more imported
      // than it had source rows once the sink rejected some of them too.
      imported: Number(r.inserted_rows ?? 0) + Number(r.updated_rows ?? 0) + Number(r.unchanged_rows ?? 0)
        || Number(r.imported ?? 0),
      quarantined: Number(r.quarantined_rows ?? 0),
      balanced: Number(r.accounting_balanced ?? 1) === 1,
      byReason,
    };
  });
}

/** Pull one field out of the raw records this source quarantined. */
function quarantinedField(db: Db, sourceId: string, field: string): string[] {
  const seen = new Set<string>();
  for (const row of db.all<{ raw_record: string }>(
    'SELECT raw_record FROM quarantine WHERE source_id = ?', sourceId,
  )) {
    try {
      const value = (JSON.parse(row.raw_record) as Record<string, unknown>)[field];
      if (typeof value === 'string' && value !== '') seen.add(value.toUpperCase());
    } catch {
      // A raw record we cannot re-read is itself worth nothing here; the row is
      // still in quarantine and still counted.
    }
  }
  return [...seen].sort();
}

export function validateAirports(db: Db, sourceId = 'ourairports'): AirportValidation {
  const funnel = sourceFunnels(db).find((f) => f.sourceId === sourceId);
  const reasons = db.all<{ reason_code: string; details: string | null; n: number }>(
    `SELECT reason_code, details, COUNT(*) n FROM quarantine WHERE source_id = ?
     GROUP BY reason_code, details`,
    sourceId,
  );
  const sum = (predicate: (r: { reason_code: string; details: string | null }) => boolean): number =>
    reasons.filter(predicate).reduce((total, r) => total + Number(r.n), 0);

  // The adapter writes `missing lat, lon`, so the field that failed is named in
  // the detail rather than inferred from the reason code alone.
  const namesCoordinate = (details: string | null): boolean => /\b(lat|lon)\b/.test(details ?? '');

  return {
    sourceRows: funnel?.sourceRows ?? 0,
    imported: funnel?.imported ?? 0,
    rejected: funnel?.quarantined ?? 0,
    unresolvedCountry: sum((r) => r.reason_code === 'NO_MATCHING_COUNTRY'),
    unresolvedRegion:
      sum((r) => r.reason_code === 'UNRESOLVED_GEOGRAPHY') +
      sum((r) => r.reason_code === 'MISSING_REQUIRED_FIELD' && /\bregionCode\b/.test(r.details ?? '')),
    missingCoordinates:
      sum((r) => r.reason_code === 'MISSING_REQUIRED_FIELD' && namesCoordinate(r.details)) +
      sum((r) => r.reason_code === 'OUT_OF_RANGE' && namesCoordinate(r.details)),
    duplicateIdentity: sum((r) => r.reason_code === 'DUPLICATE_IDENTITY'),
    storedRows: Number(db.get<{ n: number }>('SELECT COUNT(*) n FROM airports WHERE ident IS NOT NULL')?.n ?? 0),
    distinctIdents: Number(
      db.get<{ n: number }>('SELECT COUNT(DISTINCT ident) n FROM airports WHERE ident IS NOT NULL')?.n ?? 0,
    ),
    unresolvedCountryCodes: quarantinedField(db, sourceId, 'iso_country'),
  };
}

export function measureCityDuplication(db: Db, worstLimit = 5): CityDuplication {
  // Same country and same name is NOT duplication: the United States has
  // twenty-two distinct Washingtons. What makes two rows the same city is that
  // they are also in the same place, so proximity is the test and the name is
  // only the blocking key -- the same rule entity resolution already uses.
  const candidates = db.all<{ name: string; iso2: string; admin1: string | null; lat: number; lon: number }>(
    `SELECT c.name, co.iso2, c.admin1, c.lat, c.lon
     FROM cities c JOIN countries co ON co.id = c.country_id
     WHERE (c.country_id, LOWER(c.name)) IN (
       SELECT country_id, LOWER(name) FROM cities GROUP BY country_id, LOWER(name) HAVING COUNT(*) > 1
     )
     ORDER BY co.iso2, LOWER(c.name)`,
  );

  const groups = new Map<string, typeof candidates>();
  for (const row of candidates) {
    const key = `${row.iso2}|${row.name.toLowerCase()}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const found: CityDuplication['worst'] = [];
  let excessRows = 0;
  for (const [key, rows] of groups) {
    // Union-find would be exact; single-link clustering is enough here and the
    // groups are small. Rows with no coordinates cannot be judged either way,
    // so they are left out rather than counted as matches.
    const located = rows.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon) && (r.lat !== 0 || r.lon !== 0));
    const clusters: (typeof located)[] = [];
    for (const row of located) {
      const hit = clusters.find((cluster) => cluster.some((other) => withinKm(row, other, CITY_MATCH_KM)));
      if (hit) hit.push(row);
      else clusters.push([row]);
    }
    const excess = located.length - clusters.length;
    if (excess <= 0) continue;
    excessRows += excess;
    const [iso2 = '', name = ''] = key.split('|');
    const biggest = clusters.reduce((a, b) => (b.length > a.length ? b : a));
    found.push({
      name: biggest[0]?.name ?? name,
      iso2,
      rows: biggest.length,
      admin1s: biggest.map((r) => r.admin1 ?? '(none)'),
    });
  }

  found.sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name));
  return { groups: found.length, excessRows, worst: found.slice(0, worstLimit) };
}

/**
 * Two rows this close, sharing a name and a country, are one city described
 * twice. Matches the threshold entity resolution derived empirically.
 */
export const CITY_MATCH_KM = 25;

function withinKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  km: number,
): boolean {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h))) <= km;
}

export function checkCountries(db: Db, iso2s: readonly string[] = TEST_COUNTRIES): CountryCheck[] {
  return iso2s.map((iso2) => {
    const country = db.get<{ id: string; name: string; region_code: string }>(
      'SELECT id, name, region_code FROM countries WHERE iso2 = ?', iso2,
    );
    const problems: string[] = [];
    if (!country) {
      return {
        iso2, name: null, regionCode: null, airports: 0, airportsWithAdmin1: 0,
        adminRegions: 0, ok: false, problems: ['no row in the countries table'],
      };
    }
    const airports = Number(
      db.get<{ n: number }>('SELECT COUNT(*) n FROM airports WHERE country_id = ?', country.id)?.n ?? 0,
    );
    const withAdmin1 = Number(
      db.get<{ n: number }>(
        'SELECT COUNT(*) n FROM airports WHERE country_id = ? AND admin1 IS NOT NULL', country.id,
      )?.n ?? 0,
    );
    const adminRegions = Number(
      db.get<{ n: number }>('SELECT COUNT(*) n FROM admin_regions WHERE country_iso2 = ?', iso2)?.n ?? 0,
    );
    if (!country.region_code) problems.push('country resolved to no travel region');
    if (airports === 0) problems.push('no airports resolved to this country');
    if (adminRegions === 0) problems.push('no administrative regions loaded');
    // A country whose airports mostly lack admin1 means the iso_region join is
    // silently failing for it, which is the failure this report exists to name.
    if (airports > 0 && withAdmin1 / airports < 0.9) {
      problems.push(
        `only ${((withAdmin1 / airports) * 100).toFixed(1)}% of airports resolved an administrative region`,
      );
    }
    return {
      iso2, name: country.name, regionCode: country.region_code,
      airports, airportsWithAdmin1: withAdmin1, adminRegions,
      ok: problems.length === 0, problems,
    };
  });
}

export function geographyReport(db: Db): GeographyReport {
  const airports = validateAirports(db);
  const testCountries = checkCountries(db);
  const funnels = sourceFunnels(db);
  const cityDuplication = measureCityDuplication(db);
  const countryRoster = checkCountryRoster(db);

  const failures: string[] = [];
  const warnings: string[] = [];
  if (countryRoster.checked && countryRoster.missing.length > 0) {
    warnings.push(
      `country roster: ${countryRoster.note} (${countryRoster.missing.map((m) => m.code).join(' ')})`,
    );
  } else if (!countryRoster.checked) {
    warnings.push(`country roster: ${countryRoster.note}`);
  }
  if (cityDuplication.excessRows > 0) {
    warnings.push(
      `${cityDuplication.excessRows.toLocaleString()} duplicate city rows across ` +
      `${cityDuplication.groups.toLocaleString()} names: sources disagree on the admin1 vocabulary`,
    );
  }
  for (const funnel of funnels.filter((f) => f.status === 'skipped')) {
    warnings.push(`${funnel.sourceId}: skipped, credentials or egress not available`);
  }
  for (const country of testCountries.filter((c) => !c.ok)) {
    failures.push(`${country.iso2}: ${country.problems.join('; ')}`);
  }
  for (const funnel of funnels.filter((f) => !f.balanced)) {
    failures.push(`${funnel.sourceId}: row accounting does not balance`);
  }
  // Two airports on one id is a silent loss the funnel cannot see: it counts
  // rows offered to the sink, not rows the table ended up with.
  if (airports.storedRows !== airports.distinctIdents) {
    failures.push(
      `airports: ${airports.storedRows} stored rows but ${airports.distinctIdents} distinct idents — ` +
      `${airports.storedRows - airports.distinctIdents} collapsed onto a shared id`,
    );
  }

  return {
    generatedAt: nowIso(),
    coverage: {
      countries: count(db, 'countries'),
      adminRegions: count(db, 'admin_regions'),
      cities: count(db, 'cities'),
      airports: count(db, 'airports'),
      runways: count(db, 'runways'),
      frequencies: count(db, 'airport_frequencies'),
      navaids: count(db, 'navaids'),
    },
    funnels,
    airports,
    testCountries,
    countryRoster,
    cityDuplication,
    failures,
    warnings,
  };
}

export function formatGeographyReport(report: GeographyReport): string {
  const lines: string[] = ['GEOGRAPHY VALIDATION', ''];

  lines.push('coverage');
  for (const [name, n] of Object.entries(report.coverage)) {
    lines.push(`  ${name.padEnd(14)} ${n.toLocaleString().padStart(9)}`);
  }

  const a = report.airports;
  lines.push('', 'airports (ourairports)');
  const rows: [string, number][] = [
    ['input rows', a.sourceRows],
    ['imported', a.imported],
    ['rejected', a.rejected],
    ['unresolved country', a.unresolvedCountry],
    ['unresolved region', a.unresolvedRegion],
    ['missing coordinates', a.missingCoordinates],
    ['duplicate identity', a.duplicateIdentity],
    ['stored rows', a.storedRows],
    ['distinct idents', a.distinctIdents],
  ];
  for (const [name, n] of rows) lines.push(`  ${name.padEnd(22)} ${n.toLocaleString().padStart(9)}`);
  if (a.unresolvedCountryCodes.length > 0) {
    lines.push(`  country codes with no match: ${a.unresolvedCountryCodes.join(' ')}`);
  }

  lines.push('', 'test countries');
  for (const c of report.testCountries) {
    const pct = c.airports === 0 ? 0 : (c.airportsWithAdmin1 / c.airports) * 100;
    lines.push(
      `  ${c.ok ? 'ok  ' : 'FAIL'} ${c.iso2}  ${(c.name ?? '—').padEnd(24)} ` +
      `region ${(c.regionCode ?? '—').padEnd(3)} ` +
      `${c.airports.toLocaleString().padStart(6)} airports  ` +
      `${c.adminRegions.toString().padStart(4)} admin regions  ` +
      `${pct.toFixed(1).padStart(5)}% with admin1`,
    );
    for (const problem of c.problems) lines.push(`         - ${problem}`);
  }

  lines.push('', 'source funnels');
  for (const f of report.funnels) {
    const reasons = Object.entries(f.byReason).map(([k, n]) => `${k}=${n}`).join(' ');
    lines.push(
      `  ${f.balanced ? ' ' : '!'} ${f.sourceId.padEnd(24)} ${f.status.padEnd(18)} ` +
      `${f.sourceRows.toLocaleString().padStart(8)} in  ${f.imported.toLocaleString().padStart(8)} imported  ` +
      `${f.quarantined.toLocaleString().padStart(5)} quarantined  ${reasons}`,
    );
  }

  const roster = report.countryRoster;
  lines.push('', 'country roster (OurAirports countries.csv)');
  lines.push(
    roster.checked
      ? `  ${roster.matched.toLocaleString()}/${roster.listed.toLocaleString()} matched — ${roster.note}`
      : `  ${roster.note}`,
  );
  for (const m of roster.missing) lines.push(`    ${m.code}  ${m.name}`);

  const d = report.cityDuplication;
  if (d.groups > 0) {
    lines.push('', 'city duplication (admin1 vocabularies not yet reconciled)');
    lines.push(`  ${d.groups.toLocaleString()} names, ${d.excessRows.toLocaleString()} rows above one each`);
    for (const w of d.worst) {
      lines.push(`    ${w.name} (${w.iso2}) x${w.rows}: ${w.admin1s.join(' | ')}`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push('', 'warnings');
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }

  lines.push('');
  lines.push(
    report.failures.length === 0
      ? 'VERDICT: pass'
      : `VERDICT: ${report.failures.length} failure(s)`,
  );
  for (const failure of report.failures) lines.push(`  - ${failure}`);
  return lines.join('\n');
}
