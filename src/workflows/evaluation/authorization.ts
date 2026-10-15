import type { QualityTask } from './types';

/** A hosted run spends money, so it starts only under an explicit, dated
 * approval for one profile and named splits. The transport enforces both
 * limits; tokens are input, cached input and output as the provider reports them. */
export interface SpendAuthorization {
  schemaVersion: 1;
  approvedBy: string; approvedAt: string; validUntil: string;
  profileId: string; splits: QualityTask['split'][];
  maxRequests: number; maxTokens: number;
  note?: string;
}
const instant = (value: string, endOfDay: boolean) =>
  Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + (endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z') : value);

/** Structure only. Scope and dates are checked against a run by authorizationProblems. */
export function validateAuthorization(value: unknown): SpendAuthorization {
  const a = value as SpendAuthorization;
  if (a?.schemaVersion !== 1) throw new Error('Spend authorization requires schemaVersion 1');
  for (const key of ['approvedBy', 'approvedAt', 'validUntil', 'profileId'] as const)
    if (typeof a[key] !== 'string' || !a[key].trim()) throw new Error('Spend authorization requires ' + key);
  if (!Number.isFinite(instant(a.approvedAt, false)) || !Number.isFinite(instant(a.validUntil, true)))
    throw new Error('Spend authorization dates must be ISO dates or timestamps');
  if (!Array.isArray(a.splits) || !a.splits.length || !a.splits.every(s => s === 'development' || s === 'heldout'))
    throw new Error('Spend authorization must name the splits it covers');
  if (!Number.isSafeInteger(a.maxRequests) || a.maxRequests < 1 || a.maxRequests > 1000) throw new Error('maxRequests must be 1..1000');
  if (!Number.isSafeInteger(a.maxTokens) || a.maxTokens < 1) throw new Error('maxTokens must be a positive integer');
  if (a.note !== undefined && typeof a.note !== 'string') throw new Error('note must be text');
  return a;
}

export function authorizationProblems(a: SpendAuthorization, run: { profileId: string; split: string; now: Date }): string[] {
  const problems: string[] = [];
  if (a.profileId !== run.profileId) problems.push('Spend authorization covers profile ' + a.profileId + ', not ' + run.profileId + '.');
  if (!a.splits.includes(run.split as QualityTask['split'])) problems.push('Spend authorization does not cover the ' + run.split + ' split.');
  if (instant(a.approvedAt, false) > run.now.getTime()) problems.push('Spend authorization is dated after this run started.');
  if (instant(a.validUntil, true) < run.now.getTime()) problems.push('Spend authorization expired on ' + a.validUntil + '.');
  return problems;
}
