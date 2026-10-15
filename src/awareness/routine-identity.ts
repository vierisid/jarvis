import { ROUTINES } from './routine-catalog.ts';
import type { JobKind } from './opportunity-types.ts';

export const REPORT_CADENCES = ['daily', 'weekly', 'monthly'] as const;
export type ReportCadence = typeof REPORT_CADENCES[number];
export function reportCadence(value: unknown): ReportCadence | undefined {
  return REPORT_CADENCES.includes(value as ReportCadence) ? value as ReportCadence : undefined;
}
export function routineKey(kind: JobKind, cadence?: ReportCadence): string {
  return `job-v1:${kind}${kind === 'recurring_report' && cadence ? `:${cadence}` : ''}`;
}
export function hypothesisRoutineKey(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const h = value as { kind?: unknown; routine?: { cadence?: unknown } };
  const parsed = parseRoutineKey(`job-v1:${h.kind}`);
  return parsed ? routineKey(parsed.kind, reportCadence(h.routine?.cadence)) : null;
}
export function parseRoutineKey(value: string): { key: string; kind: JobKind; cadence?: ReportCadence } | null {
  const parts = value.replace(/^opportunity:/, '').split(':');
  const kind = ROUTINES.find(r => r.kind === parts[1])?.kind;
  if (parts[0] !== 'job-v1' || !kind || parts.length > 3) return null;
  const cadence = reportCadence(parts[2]);
  if (parts.length === 3 && (kind !== 'recurring_report' || !cadence)) return null;
  return { key: routineKey(kind, cadence), kind, ...(cadence ? { cadence } : {}) };
}

/** An old report with unknown cadence cannot prove a materially different job. */
export function sameRoutine(a: string, b: string): boolean {
  const left = parseRoutineKey(a), right = parseRoutineKey(b);
  return !!left && !!right && left.kind === right.kind
    && (left.key === right.key || !left.cadence || !right.cadence);
}
