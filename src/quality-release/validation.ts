import { createHash } from 'node:crypto';
import { CONDITIONS, DISPOSITIONS, JOURNEYS, PREREQUISITES, QUALITY_CHECKS, SAFETY_KEYS, TASK_DISPOSITIONS,
  type Disposition, type Proof, type ReleaseRecord, type Runtime } from './contract';

export function hash(value: unknown): string {
  const ordered = (v: any): any => Array.isArray(v) ? v.map(ordered) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, ordered(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}
const object = (v: any): boolean => !!v && typeof v === 'object' && !Array.isArray(v);
export function profileHash(p: { id: string; deployment: string; runtime: Runtime; jobs: string[] }): string { return hash({ id: p.id, deployment: p.deployment, runtime: p.runtime, jobs: p.jobs }); }
export const sha = (v: any): boolean => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const digest = (v: any): boolean => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: any): boolean => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(v);
const count = (v: any): boolean => Number.isSafeInteger(v) && v >= 0;
const date = (v: any): boolean => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
const disposition = (v: any): boolean => DISPOSITIONS.includes(v);
const unique = (values: any[]) => new Set(values).size === values.length;
function runtime(v: any): boolean {
  return object(v) && sha(v.brain) && (v.hosting === null || sha(v.hosting)) && (v.sidecar === null || sha(v.sidecar))
    && digest(v.schema) && (v.model === null || id(v.model)) && (v.profileRevision === null || digest(v.profileRevision))
    && id(v.policy) && [v.prompt, v.catalog, v.environment].every(digest);
}
function proof(v: any): boolean {
  return v === null || object(v) && sha(v.candidate) && digest(v.runtimeHash) && digest(v.artifact)
    && typeof v.reviewed === 'boolean' && date(v.startedAt) && date(v.finishedAt)
    && Date.parse(v.finishedAt) >= Date.parse(v.startedAt) && ['deterministic', 'heldout', 'live_sandbox'].includes(v.kind);
}
function measurement(v: any): boolean {
  if (v === null) return true;
  if (!object(v)) return false;
  if (v.kind === 'rate') return [v.numerator, v.denominator, v.missedEligible].every(count) && v.numerator <= v.denominator;
  if (v.kind === 'count') return count(v.value);
  return v.kind === 'distribution' && count(v.count) && count(v.timeouts) && v.timeouts <= v.count
    && [v.p50, v.p90, v.p95, v.max].every(n => Number.isFinite(n) && n >= 0)
    && v.p50 <= v.p90 && v.p90 <= v.p95 && v.p95 <= v.max;
}
/** Malformed/duplicate/unknown rows are refused, never silently dropped. No input
 * error text or free-form source content is copied to the public scorecard. */
export function validRecord(v: any): v is ReleaseRecord {
  if (!object(v) || v.schemaVersion !== 1 || !sha(v.candidate) || !object(v.rubric)
    || !digest(v.rubric.q01Hash) || !digest(v.rubric.supplementHash)
    || !['proposed', 'frozen'].includes(v.rubric.status) || !(v.rubric.frozenAt === null || date(v.rubric.frozenAt))
    || typeof v.rubric.approved !== 'boolean' || typeof v.rubric.budgetsAgreed !== 'boolean'
    || !Array.isArray(v.prerequisites) || !unique(v.prerequisites.map((p: any) => p?.card))
    || !v.prerequisites.every((p: any) => object(p) && PREREQUISITES.includes(p.card) && sha(p.integratedHead) && disposition(p.disposition) && proof(p.proof))
    || !Array.isArray(v.profiles) || !v.profiles.length || !unique(v.profiles.map((p: any) => p?.id))) return false;
  return v.profiles.every((p: any) => object(p) && id(p.id) && ['local', 'hosted'].includes(p.deployment) && runtime(p.runtime)
    && Array.isArray(p.jobs) && p.jobs.every(id) && unique(p.jobs)
    && Array.isArray(p.journeys) && unique(p.journeys.map((r: any) => `${r?.journey}/${r?.condition}`))
    && p.journeys.every((r: any) => object(r) && JOURNEYS.includes(r.journey) && CONDITIONS.includes(r.condition)
      && disposition(r.disposition) && proof(r.proof) && (r.safety === null || object(r.safety) && SAFETY_KEYS.every(k => count(r.safety[k]))))
    && Array.isArray(p.quality) && unique(p.quality.map((r: any) => r?.check))
    && p.quality.every((r: any) => object(r) && QUALITY_CHECKS.includes(r.check) && disposition(r.disposition) && proof(r.proof)
      && (r.safety === null || object(r.safety) && SAFETY_KEYS.every(k => count(r.safety[k])))
      && digest(r.rubricHash) && [r.scheduled, r.measured, r.supportedTasks, r.negativeTasks].every(count)
      && r.measured <= r.scheduled && r.supportedTasks + r.negativeTasks <= r.scheduled
      && object(r.taskDispositions) && Object.entries(r.taskDispositions).every(([k, n]) => (TASK_DISPOSITIONS as readonly string[]).includes(k) && count(n))
      && Object.values(r.taskDispositions).reduce((sum: number, n: any) => sum + n, 0) === r.scheduled
      && r.measured === r.scheduled - (r.taskDispositions.not_run ?? 0) - (r.taskDispositions.unsupported ?? 0)
      && ['met', 'not_met', 'not_established'].includes(r.verdict) && measurement(r.measurement))
    && object(p.liveConnector) && disposition(p.liveConnector.disposition) && proof(p.liveConnector.proof));
}
