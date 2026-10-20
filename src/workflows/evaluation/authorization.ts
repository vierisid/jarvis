import type { QualityTask } from './types';

/** A task set an authorization covers, by the version and content hash a run's manifest records. */
export interface AuthorizedTaskSet { version: string; sha256: string }

/** A hosted run spends money, so it starts only under an explicit, dated
 * approval for one profile, named splits and named task sets. The transport
 * enforces both limits; tokens are input, cached input and output as the
 * provider reports them. A schemaVersion 1 authorization names no task set,
 * so it still parses but never starts a run (#1082): reissue it as version 2. */
export interface SpendAuthorization {
  schemaVersion: 1 | 2;
  approvedBy: string; approvedAt: string; validUntil: string;
  profileId: string; splits: QualityTask['split'][];
  /** Required from schemaVersion 2. */
  tasksets?: AuthorizedTaskSet[];
  maxRequests: number; maxTokens: number;
  note?: string;
}
const instant = (value: string, endOfDay: boolean) =>
  Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + (endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z') : value);

/** Structure only. Scope and dates are checked against a run by authorizationProblems. */
export function validateAuthorization(value: unknown): SpendAuthorization {
  const a = value as SpendAuthorization;
  if (a?.schemaVersion !== 1 && a?.schemaVersion !== 2) throw new Error('Spend authorization schemaVersion must be 1 or 2 (only 2 can start a run)');
  for (const key of ['approvedBy', 'approvedAt', 'validUntil', 'profileId'] as const)
    if (typeof a[key] !== 'string' || !a[key].trim()) throw new Error('Spend authorization requires ' + key);
  if (!Number.isFinite(instant(a.approvedAt, false)) || !Number.isFinite(instant(a.validUntil, true)))
    throw new Error('Spend authorization dates must be ISO dates or timestamps');
  if (!Array.isArray(a.splits) || !a.splits.length || !a.splits.every(s => s === 'development' || s === 'heldout'))
    throw new Error('Spend authorization must name the splits it covers');
  if (a.schemaVersion === 2 && (!Array.isArray(a.tasksets) || !a.tasksets.length || !a.tasksets.every(t =>
    typeof t?.version === 'string' && t.version.trim() && typeof t.sha256 === 'string' && /^[0-9a-f]{64}$/.test(t.sha256))))
    throw new Error('Spend authorization must name the task sets it covers, each by version and sha256');
  if (a.schemaVersion === 1 && a.tasksets !== undefined) throw new Error('tasksets requires schemaVersion 2');
  if (!Number.isSafeInteger(a.maxRequests) || a.maxRequests < 1 || a.maxRequests > 1000) throw new Error('maxRequests must be 1..1000');
  if (!Number.isSafeInteger(a.maxTokens) || a.maxTokens < 1) throw new Error('maxTokens must be a positive integer');
  if (a.note !== undefined && typeof a.note !== 'string') throw new Error('note must be text');
  return a;
}

export function authorizationProblems(a: SpendAuthorization,
  run: { profileId: string; split: string; taskset: AuthorizedTaskSet; now: Date }): string[] {
  const problems: string[] = [];
  const named = run.taskset.version + ' (sha256 ' + run.taskset.sha256 + ')';
  if (a.profileId !== run.profileId) problems.push('Spend authorization covers profile ' + a.profileId + ', not ' + run.profileId + '.');
  if (!a.splits.includes(run.split as QualityTask['split'])) problems.push('Spend authorization does not cover the ' + run.split + ' split.');
  if (a.schemaVersion !== 2 || !a.tasksets) problems.push('Spend authorization schemaVersion ' + a.schemaVersion
    + ' does not name the task sets it covers; reissue it as schemaVersion 2 with tasksets including ' + named + '.');
  else if (!a.tasksets.some(t => t.version === run.taskset.version && t.sha256 === run.taskset.sha256))
    problems.push('Spend authorization does not cover task set ' + named + '.');
  if (instant(a.approvedAt, false) > run.now.getTime()) problems.push('Spend authorization is dated after this run started.');
  if (instant(a.validUntil, true) < run.now.getTime()) problems.push('Spend authorization expired on ' + a.validUntil + '.');
  return problems;
}
