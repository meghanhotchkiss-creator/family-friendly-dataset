/** Connection Sentinel: provider health, latency, auth, schema drift, staleness. */

import type { ProviderStatus } from './provider.ts';

export const INCIDENT_KINDS = [
  'unreachable', 'auth_failure', 'rate_limited', 'schema_drift',
  'stale_data', 'latency_regression',
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const SEVERITIES = ['info', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Incident {
  id: string;
  providerId: string;
  kind: IncidentKind;
  severity: Severity;
  openedAt: string;
  closedAt: string | null;
  detail: string;
}

export interface SchemaFingerprintRecord {
  id: string;
  providerId: string;
  fingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Rolled-up platform status served by the health API. */
export interface SystemHealth {
  status: ProviderStatus;
  checkedAt: string;
  providers: {
    id: string; kind: string; status: ProviderStatus;
    latencyMs: number | null; schemaOk: boolean; error: string | null;
  }[];
  subsystems: { name: string; status: ProviderStatus; detail: string }[];
  openIncidents: number;
  /** Latency budget in ms above which a provider is called degraded. */
  latencyBudgetMs: number;
}

export const LATENCY_BUDGET_MS = 2000;
export const LATENCY_CRITICAL_MS = 8000;
