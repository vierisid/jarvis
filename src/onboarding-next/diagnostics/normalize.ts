import { FAILURE_CODES, ID_FIELDS, KINDS, LIMITS, OUTCOMES, PROVIDERS, STEPS, type DiagnosticInput } from './types.ts';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const identity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= LIMITS.idLength;
const member = (value: unknown, values: readonly unknown[]) => values.includes(value);

/** Construct an allowlisted projection; never stringify, spread, or log input.
 * Even credential-shaped IDs become keyed pseudonyms before they leave here. */
export function normalize(input: unknown, pseudonym: (field: string, value: string) => string): DiagnosticInput | null {
  if (!object(input)) return null;
  // Snapshot each field once: a getter must not swap a validated category for
  // private content between validation and projection.
  const { schemaVersion, eventId, kind, stage, outcome, failureCode, correlation: ids } = input;
  if (schemaVersion !== 1 || !identity(eventId) || !member(kind, KINDS) || !member(stage, STEPS)
    || !member(outcome, OUTCOMES) || !member(failureCode, FAILURE_CODES) || !object(ids)) return null;
  const correlation: Record<string, string> = {};
  for (const field of ID_FIELDS) {
    const value = ids[field];
    if (value !== undefined) {
      if (!identity(value)) return null;
      correlation[field] = pseudonym(field, value);
    }
  }
  if (!correlation.journeyId || !correlation.operationId) return null;
  const duration = input.durationMs;
  if (duration !== null && (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0)) return null;
  // Large actual durations saturate rather than creating unbounded numeric labels.
  const result: DiagnosticInput = {
    schemaVersion: 1, eventId: pseudonym('eventId', eventId),
    kind: kind as DiagnosticInput['kind'], stage: stage as DiagnosticInput['stage'],
    correlation: correlation as DiagnosticInput['correlation'],
    outcome: outcome as DiagnosticInput['outcome'], failureCode: failureCode as DiagnosticInput['failureCode'],
    durationMs: duration === null ? null : Math.min(LIMITS.durationMs, Math.round(duration as number)),
  };
  if (result.outcome === 'succeeded' && result.failureCode !== 'none') return null;
  if (result.outcome === 'failed' && result.failureCode === 'none') return null;
  if (result.kind === 'step_transition') {
    const { from, to } = input;
    if (!member(from, STEPS) || !member(to, STEPS)) return null;
    result.from = from as DiagnosticInput['from']; result.to = to as DiagnosticInput['to'];
  }
  if (result.kind === 'build_phase') {
    const phase = input.phase;
    if (!member(phase, ['understanding', 'building', 'validating', 'saving'])) return null;
    result.phase = phase as DiagnosticInput['phase'];
  }
  if (result.kind === 'recovery') {
    const recovery = input.recovery;
    if (!member(recovery, ['reconnect', 'resume', 'retry', 'reconcile'])) return null;
    result.recovery = recovery as DiagnosticInput['recovery'];
  }
  const model = input.model;
  if (model !== undefined) {
    if (!object(model)) return null;
    const { provider, profileId } = model;
    if (!identity(profileId)) return null;
    result.model = { provider: member(provider, PROVIDERS) ? provider as typeof PROVIDERS[number] : 'unknown',
      profileId: pseudonym('profileId', profileId) };
  }
  return result;
}
