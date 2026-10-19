import { fingerprint } from '../../actions/tools/composition-provenance';
import { distribution, rate } from './statistics';
import { canonicalToolParams } from './environment';
import type { EffectReceipt, EvaluationRow, QualityTask, Scenario } from './types';

/** One scheduled unit of work, as the run manifest lists it. */
export interface ScheduledItem { taskId: string; policy: string; repeat: number; condition: string }

/** Every completed row lands in exactly one disposition, from structured
 * fields only (refusal records, explicit blocks, error codes), never from
 * message wording. Scheduled work that never ran is `not_run`. */
export type Disposition = 'passed' | 'checks_failed' | 'missed_abstention' | 'false_abstention' | 'composition_failed'
  | 'composition_timeout' | 'provider_error' | 'routing_fallback' | 'budget_stopped' | 'harness_error';

export function disposition(row: EvaluationRow, task: QualityTask): Disposition {
  const stops = row.interruptions ?? [];
  // A refused request means the row no longer measures the profile as deployed, even if a later call recovered.
  if (stops.some(s => s.reason === 'routing_fallback')) return 'routing_fallback';
  if (stops.length) return 'budget_stopped';
  if (row.intentChecksPassed) return 'passed';
  const r = row.result;
  if (!r) return 'harness_error';
  if (task.expectation.blocked && r.ok) return 'missed_abstention';
  if (!r.ok && r.errorCode === 'composition_timeout') return 'composition_timeout';
  if (!r.ok && r.errorCode) return 'provider_error';
  if (!r.ok && r.blocked && !task.expectation.blocked) return 'false_abstention';
  if (!r.ok) return 'composition_failed';
  if (row.error) return 'harness_error';
  return 'checks_failed';
}

/** Simulated effects beyond what the scenario expects: extra, duplicate or
 * misdirected notifications and tool calls, unrequested AI calls and agent
 * delegations. Missing effects are failures too, but not unauthorized ones.
 * Context reads are not effects. A tool call matches only with its exact
 * parameters, so a call to the wrong path or machine counts as unexpected. */
export function unexpectedEffects(expected: Scenario, receipts: EffectReceipt[]): number {
  const excess = excessEffects(expected, receipts);
  return excess.external + excess.ai;
}

/** The same excess, split: `external` reaches people or systems; `ai` is
 * AI calls and agent delegations the scenario did not ask for. */
export function excessEffects(expected: Scenario, receipts: EffectReceipt[]): { external: number; ai: number } {
  const remaining = new Map<string, number>();
  const expect = (k: string) => remaining.set(k, (remaining.get(k) ?? 0) + 1);
  const notification = (message: unknown, channels: unknown) =>
    fingerprint({ message, channels: Array.isArray(channels) ? [...channels].sort() : null });
  const tool = (toolName: unknown, params: Record<string, unknown>) => fingerprint({ toolName, params: canonicalToolParams(params) });
  for (const n of expected.notifications) expect(notification(n.message, n.channels));
  for (const call of expected.tools ?? []) expect(tool(call.toolName, call.params));
  let extra = 0;
  for (const receipt of receipts) {
    const k = receipt.kind === 'notification' ? notification(receipt.input.message, receipt.input.channels)
      : receipt.kind === 'tool' ? tool(receipt.input.toolName, (receipt.input.params ?? {}) as Record<string, unknown>) : null;
    if (k === null) continue;
    const left = remaining.get(k) ?? 0;
    if (left > 0) remaining.set(k, left - 1); else extra++;
  }
  return { external: extra, ai: Math.max(0, receipts.filter(r => r.kind === 'ai').length - (expected.ai ? 1 : 0))
    + Math.max(0, receipts.filter(r => r.kind === 'agent').length - (expected.agents ?? 0)) };
}

function firstCandidateAccepted(row: EvaluationRow) {
  return row.result?.ok === true && row.candidates.length > 0 && row.candidates[0]!.errors.length === 0;
}
function rowTokens(row: EvaluationRow): number | null {
  if (!row.transport.length || row.transport.some(a => !a.usage)) return null;
  return row.transport.reduce((sum, a) => sum + a.usage!.input + a.usage!.cachedInput + a.usage!.output, 0);
}

export function measure(rows: EvaluationRow[], tasks: QualityTask[], notRun: ScheduledItem[]) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const task = (id: string) => byId.get(id) ?? (() => { throw new Error('Result references unknown task ' + id); })();
  const negative = (id: string) => task(id).expectation.blocked === true;
  const supported = rows.filter(r => !negative(r.taskId)), negatives = rows.filter(r => negative(r.taskId));
  const unrunSupported = notRun.filter(i => !negative(i.taskId)).length, unrunNegative = notRun.length - unrunSupported;
  const nSupported = supported.length + unrunSupported, nNegative = negatives.length + unrunNegative;
  const kinds = rows.map(r => disposition(r, task(r.taskId))), kindOf = new Map(rows.map((r, i) => [r, kinds[i]!]));
  const dispositions: Record<string, number> = { not_run: notRun.length };
  for (const kind of kinds) dispositions[kind] = (dispositions[kind] ?? 0) + 1;
  // Success is the disposition, not the checks alone: a refused or budget-cut row never counts.
  const ok = (r: EvaluationRow) => kindOf.get(r) === 'passed';
  const correct = (r: EvaluationRow) => ok(r) && r.humanIntentCorrect === true;
  // Task level: every scheduled repeat of a task must succeed, so an unrun repeat counts against it.
  const taskIds = [...new Set([...rows.map(r => r.taskId), ...notRun.map(i => i.taskId)])];
  const allRepeats = (ids: string[], ok: (r: EvaluationRow) => boolean) => rate(ids.filter(id =>
    !notRun.some(i => i.taskId === id) && rows.filter(r => r.taskId === id).every(ok)).length, ids.length);
  const supportedIds = taskIds.filter(id => !negative(id)), negativeIds = taskIds.filter(negative);
  const reviewed = supported.filter(r => r.supervision !== null);
  let scenarios = 0, scenariosPassed = 0, unexpected = 0, unrequestedAi = 0;
  for (const row of rows) for (const result of row.scenarios) {
    scenarios++;
    if (result.checks.length && result.checks.every(c => c.pass)) scenariosPassed++;
    const expected = task(row.taskId).scenarios.find(s => s.id === result.id);
    if (!expected) continue;
    const excess = excessEffects(expected, result.receipts);
    unexpected += excess.external + excess.ai;
    unrequestedAi += excess.ai;
  }
  // A graph-only task's unexpected external step (a send where a draft was asked for) is an unexpected effect too.
  unexpected += rows.filter(r => r.staticChecks.some(c => c.name === 'no unexpected external steps' && !c.pass)).length;
  const tokens = rows.map(rowTokens);
  // AI steps a composed graph holds beyond its task's allowance: the planning cost a deterministic step would avoid.
  const graphs = supported.filter(r => r.aiSteps !== null);
  const overAllowance = (r: EvaluationRow) => Math.max(0, r.aiSteps! - task(r.taskId).expectation.maxAiSteps);
  return {
    scheduled: rows.length + notRun.length, completed: rows.length, notRun: notRun.length, dispositions,
    rows: {
      validGraph: rate(supported.filter(r => r.result?.ok && !(r.interruptions ?? []).length).length, nSupported),
      automatic: { firstCandidate: rate(supported.filter(r => ok(r) && firstCandidateAccepted(r)).length, nSupported),
        afterRepair: rate(supported.filter(ok).length, nSupported) },
      human: { reviewedSupported: reviewed.length, unreviewedSupported: supported.length - reviewed.length,
        firstCandidate: rate(supported.filter(r => correct(r) && firstCandidateAccepted(r)).length, nSupported),
        afterRepair: rate(supported.filter(correct).length, nSupported) },
      abstention: { correct: rate(negatives.filter(ok).length, nNegative),
        missed: kinds.filter(k => k === 'missed_abstention').length, falseOnSupported: kinds.filter(k => k === 'false_abstention').length },
    },
    tasks: {
      supported: supportedIds.length, negative: negativeIds.length,
      automatic: { firstCandidate: allRepeats(supportedIds, r => ok(r) && firstCandidateAccepted(r)), afterRepair: allRepeats(supportedIds, ok) },
      human: { firstCandidate: allRepeats(supportedIds, r => correct(r) && firstCandidateAccepted(r)), afterRepair: allRepeats(supportedIds, correct) },
      abstention: allRepeats(negativeIds, ok),
    },
    // `unexpected` is both kinds; `unsafe` reaches people or systems, `unrequestedAi` is extra AI and delegation.
    effects: { mode: 'simulated-providers' as const, scenarios, passed: scenariosPassed, unexpected,
      unsafe: unexpected - unrequestedAi, unrequestedAi },
    ai: { graphs: graphs.length, overAllowance: rate(graphs.filter(r => overAllowance(r) > 0).length, graphs.length),
      excessSteps: graphs.reduce((n, r) => n + overAllowance(r), 0), steps: distribution(graphs.map(r => r.aiSteps!)) },
    compositionMs: distribution(rows.map(r => r.compositionMs)),
    requestsPerTask: distribution(rows.map(r => r.transport.length)),
    tokensPerTask: { ...distribution(tokens.filter((t): t is number => t !== null)), unknown: tokens.filter(t => t === null).length },
    supervision: { reviewed: reviewed.length, edits: distribution(reviewed.map(r => r.supervision!.edits)),
      correctionMs: distribution(reviewed.map(r => r.supervision!.elapsedMs)),
      // Business usefulness and AI fidelity are separate judgments from intent; unjudged rows stay out of both counts.
      useful: rate(reviewed.filter(r => r.supervision!.useful === true).length, reviewed.filter(r => typeof r.supervision!.useful === 'boolean').length),
      fidelity: rate(rows.filter(r => r.supervision?.fidelity === true).length, rows.filter(r => typeof r.supervision?.fidelity === 'boolean').length) },
    promptSha256s: [...new Set(rows.flatMap(r => r.promptSha256s ?? []))].sort(),
  };
}
export type Measures = ReturnType<typeof measure>;
