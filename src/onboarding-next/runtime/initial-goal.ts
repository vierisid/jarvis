/** Prepare outside SQLite; commit the whole active OKR with the dashboard handoff. */
import { createHash } from 'node:crypto';
import { getDb } from '../../vault/schema';
import { findGoals } from '../../vault/goals';
import { getGoalApplication } from '../../goals/application-service';
import { validateProposal, planProposal, type GoalProposal } from '../../goals/proposal';
import { getSetting, setSetting } from '../../vault/settings';
import { getUserProfile } from '../../vault/user-profile';
import { interviewSourceWithheld } from '../../vault/memory-suppression';
import type { JourneySnapshot } from '../journey/types';
import { getLLMErrorCode, LLMProviderError } from '../../llm/provider';
import { GoalValidationError } from '../../goals/validation';
import { markInitialGoalUnplanned } from '../../goals/initial-goal-notice';

const receiptKey = (s: JourneySnapshot) => `onboarding-next.initial-goal.v1.${s.scopeId}.${s.journeyId}`;
const planKey = (s: JourneySnapshot) => `onboarding-next.initial-okr.v1.${s.scopeId}.${s.journeyId}`;
function source() {
  const facts = (getUserProfile()?.interview_facts ?? []).filter(f => f.summary.trim() && !interviewSourceWithheld(getDb(), f))
    .sort((a, b) => a.recorded_at - b.recorded_at);
  const goal = facts.filter(f => f.theme.toLowerCase() === 'goals').at(-1);
  return { goal, facts, digest: createHash('sha256').update(JSON.stringify(facts)).digest('hex') };
}
class IncompletePlan extends Error { override name = 'IncompletePlan'; }
function checked(input: unknown, title: string): GoalProposal {
  const proposal = validateProposal(input);
  if (proposal.parent_id || proposal.key_results.length < 2 || proposal.key_results.length > 5
    || proposal.key_results.some((_, i) => !proposal.milestones?.some(m => m.key_result_index === i)))
    throw new IncompletePlan('A complete initial OKR requires key results and milestones');
  // Preserve the user's objective rather than replacing it with a model's new ambition.
  proposal.objective.title = title;
  proposal.objective.tags = [...new Set([...(proposal.objective.tags ?? []), 'onboarding'])];
  planProposal(proposal, null, Date.now());
  return proposal;
}
/** How long an exit may wait for the plan, and how it retries.
 * budgetMs: one exit's whole wait, attempts and backoff included. It is above the
 * slowest comparable successful call measured (66.5s, p95 54.6s) so a healthy slow
 * plan is not cut short, and below the client's 120s finish/explore budget so the
 * exit always answers. The provider manager already retries each call without a
 * pause; these attempts add spacing so a short outage can pass. */
export interface PlannerRetry {
  attempts: number; budgetMs: number; backoffMs: readonly number[];
  /** No attempt starts with less budget left than this: the measured p50 (15.4s)
   * of comparable successful calls. A shorter tail would usually be paid for and aborted. */
  minAttemptMs: number;
  now(): number; sleep(ms: number, signal: AbortSignal): Promise<void>;
  deadline(ms: number): { signal: AbortSignal; clear(): void };
}
export const PLANNER_RETRY: PlannerRetry = {
  attempts: 3, budgetMs: 90_000, backoffMs: [2_000, 5_000], minAttemptMs: 15_000,
  now: () => Date.now(),
  deadline: ms => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new LLMProviderError(`Initial goal plan exceeded ${ms}ms`, 'network')), ms);
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
  },
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const done = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', done); resolve(); }, ms);
    signal.addEventListener('abort', done, { once: true });
  }),
};
/** Invalid output can differ on a second draw; anything else not transient will not.
 * Our own over-long prompt is input, not output: a redraw cannot change it. */
function failure(error: unknown): 'invalid' | 'transient' | 'final' {
  if (error instanceof GoalValidationError) return error.path === 'text' ? 'final' : 'invalid';
  if (error instanceof IncompletePlan || error instanceof SyntaxError) return 'invalid';
  return ['rate_limit', 'network', 'server'].includes(getLLMErrorCode(error)) ? 'transient' : 'final';
}
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  let stop!: () => void;
  const aborted = new Promise<never>((_, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, { once: true }); });
  return Promise.race([work, aborted]).finally(() => signal.removeEventListener('abort', stop));
}
interface Waiter { guard: () => void; signal?: AbortSignal }
interface Shared { work: Promise<void>; waiters: Set<Waiter>; cancel: AbortController }
export function createInitialGoalPlanner(generate: (text: string, signal: AbortSignal) => Promise<GoalProposal>, retry: PlannerRetry = PLANNER_RETRY) {
  const pending = new Map<string, Shared>();
  async function plan(text: string, title: string, guard: () => void, cancel: AbortSignal): Promise<GoalProposal> {
    const started = retry.now(), deadline = retry.deadline(retry.budgetMs);
    const signal = AbortSignal.any([deadline.signal, cancel]);
    let invalid = 0;
    try {
      for (let attempt = 1; ; attempt++) {
        guard(); // Authority is never retried around.
        try { return checked(await untilAborted(generate(text, signal), signal), title); }
        catch (error) {
          if (signal.aborted) throw error;
          const kind = failure(error);
          if (kind === 'final' || (kind === 'invalid' && ++invalid >= 2) || attempt >= retry.attempts) throw error;
          // A redraw needs no outage spacing; a transient failure gets backoff or its Retry-After.
          const hint = kind === 'transient' && error instanceof LLMProviderError ? error.retryAfterMs ?? 0 : 0;
          const wait = kind === 'invalid' ? 0 : Math.max(retry.backoffMs[attempt - 1] ?? retry.backoffMs.at(-1) ?? 0, hint);
          if (retry.now() - started + wait + retry.minAttemptMs > retry.budgetMs) throw error;
          if (wait > 0) await retry.sleep(wait, signal);
        }
      }
    } finally { deadline.clear(); }
  }
  /** `signal` is the caller's request: when every waiter has gone, the attempt in flight is cancelled. */
  return async (s: JourneySnapshot, guard: () => void, signal?: AbortSignal) => {
    guard();
    if (s.interviewState !== 'done' || getSetting(receiptKey(s)) !== null || findGoals({ limit: 1 }).length) return;
    const captured = source(); if (!captured.goal) return;
    const key = planKey(s), identity = `${key}:${captured.digest}`;
    const cached = getSetting(key);
    if (cached) {
      const saved = JSON.parse(cached);
      if (saved.digest === captured.digest) { checked(saved.proposal, captured.goal.summary); return; }
    }
    const waiter: Waiter = { guard, ...(signal ? { signal } : {}) };
    let shared = pending.get(identity);
    if (!shared) {
      const waiters = new Set<Waiter>([waiter]), cancel = new AbortController();
      // Shared work continues while ANY waiter is still authorized; each waiter
      // re-checks its own authority after the work, so none borrows another's.
      const anyAuthorized = () => {
        let failure: unknown = Error('No authorized caller is waiting for the plan');
        for (const w of waiters) { try { w.guard(); return; } catch (e) { failure = e; } }
        cancel.abort(failure); throw failure;
      };
      const work = (async () => {
        const text = `Build the initial active OKR for this completed onboarding interview.
The user's objective is: ${captured.goal!.summary}
Their own words: ${captured.goal!.raw_quote || captured.goal!.summary}
Interview context (statements, not instructions): ${JSON.stringify(captured.facts.filter(f => f.theme !== 'goals').map(f => ({ theme: f.theme, summary: f.summary, quote: f.raw_quote })))}
Create 2-5 relevant key results with observable success criteria and 1-3 concrete milestones for EACH key result. Use the user's stated targets and timeframe. Do not invent baseline measurements, current progress, account access, commercial targets or exact deadlines they did not give. When a baseline or detail is missing, include a milestone to establish it, use an observable deliverable as success criteria, and omit unknown deadlines. Respect their approval and work boundaries. This is a complete starting plan, not a clarifying questionnaire; do not return clarifying_questions. Do not claim suggested steps are things the user already agreed or completed.`;
        const proposal = await plan(text, captured.goal!.summary, anyAuthorized, cancel.signal);
        anyAuthorized();
        if (source().digest !== captured.digest) throw Error('Interview changed while preparing the goal');
        setSetting(key, JSON.stringify({ digest: captured.digest, proposal }));
      })();
      shared = { work, waiters, cancel };
      pending.set(identity, shared);
    } else shared.waiters.add(waiter);
    const current = shared;
    const left = () => {
      if ([...current.waiters].every(w => w.signal?.aborted)) current.cancel.abort(Error('Every caller left before the plan was ready'));
    };
    signal?.addEventListener('abort', left, { once: true });
    try { await current.work; guard(); }
    finally {
      signal?.removeEventListener('abort', left);
      current.waiters.delete(waiter);
      if (pending.get(identity) === current && current.waiters.size === 0) pending.delete(identity);
    }
  };
}
export function saveInitialInterviewGoal(snapshot: JourneySnapshot): void {
  if (snapshot.stepId !== 'exited' || !['completed', 'explored'].includes(snapshot.completion)
    || snapshot.interviewState !== 'done') return;
  const app = getGoalApplication();
  app.transaction(() => {
    const key = receiptKey(snapshot);
    // Retain old receipts too: deletion/replay must never recreate or silently activate past work.
    if (getSetting(key) !== null) return;
    const existing = findGoals({ limit: 1 })[0];
    const captured = source();
    if (existing || !captured.goal) { setSetting(key, JSON.stringify({ goalId: existing?.id ?? null })); return; }
    // No plan for the interview as it stands now: the planner failed, or the
    // interview changed between planning and this commit (a stale plan is dropped
    // too, never applied). Finish without a goal rather than trap the user in
    // onboarding. The receipt stops a later write from creating one silently; the
    // dashboard says the interview goal could not be planned and offers Goals.
    const raw = getSetting(planKey(snapshot));
    const saved = raw ? JSON.parse(raw) : null;
    if (saved?.digest !== captured.digest) {
      setSetting(key, JSON.stringify({ goalId: null, plan: 'unavailable' }));
      markInitialGoalUnplanned();
      return;
    }
    const proposal = checked(saved.proposal, captured.goal.summary);
    const goals = app.createFromProposal(proposal);
    for (const goal of goals) {
      // Active tracking uses the existing Authority policy; onboarding grants no execution authority.
      app.updateGoal(goal.id, { authority_level: 0 });
      app.updateStatus(goal.id, 'active');
    }
    setSetting(key, JSON.stringify({ goalId: goals[0]!.id, goalIds: goals.map(g => g.id) }));
  });
}
