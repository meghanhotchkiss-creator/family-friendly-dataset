/**
 * One clock. Every timestamp in the platform comes from here so tests can make
 * time deterministic without monkey-patching Date.
 */

let frozenAt: string | null = null;

export function nowIso(): string {
  return frozenAt ?? new Date().toISOString();
}

export function freezeClock(iso: string): void {
  frozenAt = iso;
}

export function unfreezeClock(): void {
  frozenAt = null;
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.max(0, (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000);
}

export function plusSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}
