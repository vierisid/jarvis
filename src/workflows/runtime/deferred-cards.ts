/**
 * #1039: per-flow budgets for waiting workflow cards, and the steps that wait
 * for a place in one.
 *
 * A governed step whose card would go past its flow's budget does not fail
 * (owner, 2026-10-21: "defer, don't fail"). It parks on a DEFER waitpoint
 * with no card, and the timer scheduler releases it, oldest first, once a
 * place frees: a card approved or denied, or a run with a card ended. The
 * step then runs again and raises its card. This is the Pause hold's shape
 * (`emergency-hold.ts`): a waitpoint only the daemon releases, and a step
 * judged afresh when it runs again. Nothing waiting is destroyed, and no
 * card is raised past the budget.
 *
 * Q-06 and Q-08 apply as to any waiting run. Turning the workflow off or
 * deleting it stops the run (`flow-turn-off.ts`); a turn-off the release
 * finds first stops it rather than waking it. Pause releases nothing; Kill
 * stops the run.
 */
import { maxWaitingSpawnCards } from '../../agents/lifecycle-gate';
import { getWorkflowDb } from '../db';
import { stopTurnedOffRun, turnedOffReason } from '../db/repos/flow-turn-off';
import { getWaitpoint } from '../db/repos/waitpoint';
import type { WorkflowEffect } from '../db/repos/workflow-effect';
import { claimContinuation } from './continuation';
import { emergencyHold } from './emergency-hold';

/**
 * How many workflow cards one flow may have waiting on a decision for an act
 * that does not start an agent (#1039): a notify step's `send_message`, a
 * piece's `send_email`, and every other governed category.
 *
 * The same number as the start budget, not a new one. That budget's own
 * reasoning (`maxWaitingSpawnCards`: "well past what a person follows at
 * once") is the approval-fatigue argument this bound exists for, and it is
 * the only bound on waiting cards per source the owner has decided (#989,
 * #1012). A function, not a copy, so the two cannot drift.
 */
export function maxWaitingWorkflowCards(): number {
  return maxWaitingSpawnCards();
}

export type CardBudget = 'start' | 'other';

/**
 * Which budget a workflow card waits in, or null for one that is never
 * capped. A start (`spawn_agent`: a delegation step, a started workflow, a
 * delegated agent's own spawn) has #1017's budget, with its own message. A
 * stop (`terminate_agent`) is never capped: holding back the question whether
 * to stop an agent would leave it running. Every other card shares one budget
 * per flow. Separate budgets, so a flood of one kind never starves the other.
 *
 * Keyed on the category the card is recorded with, `action_category`, which
 * is the DECISION's category (`decision.actionCategory`), not the category
 * the step was invoked as: a decision can name a stricter one than the
 * invocation (a fold over several, an above-level substitution), and the
 * card, its count and the step's own check must all use the same one.
 */
export const budgetOf = (category: string): CardBudget | null =>
  category === 'spawn_agent' ? 'start' : category === 'terminate_agent' ? null : 'other';

export const budgetCap = (budget: CardBudget): number =>
  budget === 'start' ? maxWaitingSpawnCards() : maxWaitingWorkflowCards();

const LIVE = `('QUEUED','RUNNING','PAUSED')`;
/**
 * A step waiting for a place, exactly as `idx_workflow_effect_deferred`
 * (db/schema.ts) is filtered, so the planner reads the index rather than
 * parsing every pending record: a flood that nobody answers grows this set
 * by up to 60 a minute per flow (the webhook limit).
 */
const DEFERRED = `e.status = 'pending' AND e.approval_id IS NULL AND json_extract(e.record, '$.deferral.budget') IS NOT NULL`;
/**
 * A waiting step holds its place only while it is live: parked (or about to
 * park) on its DEFER waitpoint, or held by Pause at its step after it was
 * released (the boundary then names that HOLD on the record, so it is this
 * record's own, never another pass of the same step's), or with the
 * continuation that wakes either still queued or running. One whose step did not ask again when its
 * run woke (the step failed first and the run went on), or that a later
 * deferral of the same run superseded, holds no place: otherwise one such
 * record, the oldest in the queue, would keep a place for as long as its run
 * lived, and every later step of the flow would wait behind it. If it asks
 * again it keeps its age (`deferral.since` is kept while the budget is the
 * same), so a step Pause held after its release is not sent to the back.
 */
const LIVE_DEFERRAL = `EXISTS (SELECT 1 FROM waitpoint w WHERE w.id = e.waitpoint_id AND w.type IN ('DEFER','HOLD')
  AND (w.resumed_at IS NULL OR EXISTS (SELECT 1 FROM workflow_job j WHERE j.flow_run_id = e.run_id AND j.job_type = 'RUN_FLOW'
    AND j.status IN ('QUEUED','RUNNING') AND json_extract(j.payload, '$.waitpointId') = w.id)))`;
const FLOW = `json_extract(e.record, '$.flowId')`;
const BUDGET = `json_extract(e.record, '$.deferral.budget')`;
const SINCE = `json_extract(e.record, '$.deferral.since')`;

/**
 * Workflow cards waiting on a decision in `budget`, from runs of `flowId`
 * (#1017, #1039). Counted by the card's recorded category (see `budgetOf`).
 *
 * The flow is the source, not the run: a repeatedly triggered workflow is a
 * new run each time, so a per-run count bounds nothing. Each flow has its own
 * budgets, separate from the deferred budget of each agent the lifecycle gate
 * counts, so the bound is per source as #1012 put it, not one global number.
 *
 * Only cards of runs still able to act on them count. A run that is stopped
 * has its cards closed by the cancellation, and one that ended any other way
 * by the terminal sweep (`child-run-scheduler.ts`); until the sweep reaches
 * it, approving its card resumes nothing, so it must not use up the budget of
 * the runs that can. A card whose run no longer exists names no flow and is
 * not counted either.
 */
export function waitingWorkflowCards(flowId: string, budget: CardBudget): number {
  const rows = getWorkflowDb().query<{ category: string }, [string]>(`SELECT a.action_category AS category
    FROM approval_requests a JOIN flow_run r ON r.id = substr(a.agent_id, ${'workflow:'.length + 1})
    WHERE a.status = 'pending' AND a.execution_mode = 'workflow' AND a.agent_id LIKE 'workflow:%'
      AND r.flow_id = ? AND r.status IN ${LIVE}`).all(flowId);
  return rows.filter((row) => budgetOf(row.category) === budget).length;
}

/**
 * Where `deferredAhead` stops counting: past the budget the number only goes
 * on the hold text. Never below the budget itself, so a larger cap could not
 * let a step through early.
 */
export const deferredAheadLimit = (budget: CardBudget): number => Math.max(100, budgetCap(budget));

/**
 * Steps of live runs of the same flow already waiting for a place in
 * `budget` ahead of `effect`, up to `deferredAheadLimit`: all of them
 * for a step not yet waiting, the older ones for a step that is. A place that
 * frees goes to the oldest, so a step arriving later never takes it from one
 * that has waited longer. Bounded, because a flood nobody answers is exactly
 * when this runs most (each new step asks it), and a full count would grow
 * with the queue; any number at or past the budget gives the same answer.
 */
export function deferredAhead(effect: WorkflowEffect, budget: CardBudget): number {
  const since = effect.deferral?.budget === budget ? effect.deferral.since : null;
  const row = getWorkflowDb().query<{ n: number }, [string, string, string, number | null, number | null, number | null, string, number]>(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM workflow_effect e JOIN flow_run r ON r.id = e.run_id
      WHERE ${DEFERRED} AND e.id <> ? AND ${FLOW} = ? AND ${BUDGET} = ? AND r.status IN ${LIVE} AND ${LIVE_DEFERRAL}
        AND (? IS NULL OR ${SINCE} < ?
          OR (${SINCE} = ? AND e.rowid < (SELECT rowid FROM workflow_effect WHERE id = ?)))
      LIMIT ?)`,
  ).get(effect.id, effect.flowId, budget, since, since, since, effect.id, deferredAheadLimit(budget));
  return row?.n ?? 0;
}

/**
 * Release waiting steps into the places their flows' budgets now have,
 * oldest first. A step already released and not yet run again keeps its
 * place, so a place is never handed out twice. Call on the timer tick, after
 * the sweeps that close cards. Returns how many were released.
 */
export function releaseDeferredSteps(now = Date.now()): number {
  if (emergencyHold()) return 0;
  const db = getWorkflowDb();
  // Only flows with room are read further, and only as far as their room
  // goes: a flow at its budget costs one count, however long its queue.
  const groups = db.query<{ flow_id: string; budget: string }, []>(
    // Named, because the planner otherwise reads `idx_workflow_effect_pending`
    // and parses every pending record. Measured at 86,400 waiting steps (a
    // day of the webhook limit): about 97 ms a tick that way, 5 ms this way.
    // Deliberately hard: the schema always creates the index
    // (db/schema.ts); a database without it fails this loudly, and the tick
    // logs it, rather than quietly scanning every record.
    `SELECT DISTINCT ${FLOW} AS flow_id, ${BUDGET} AS budget FROM workflow_effect e INDEXED BY idx_workflow_effect_deferred
      WHERE ${DEFERRED}`).all();
  // Read whole, then acted on: stopping a run rewrites rows of this table,
  // which must not happen under an open cursor over it. A place a stopped
  // run gives up is used on the next tick.
  const queue = db.query<{ id: string; run_id: string; waitpoint_id: string | null; run_status: string }, [string, string, number]>(
    `SELECT e.id, e.run_id, e.waitpoint_id, r.status AS run_status
      FROM workflow_effect e JOIN flow_run r ON r.id = e.run_id
      WHERE ${DEFERRED} AND ${FLOW} = ? AND ${BUDGET} = ? AND r.status IN ${LIVE} AND ${LIVE_DEFERRAL}
      ORDER BY ${SINCE}, e.rowid LIMIT ?`);
  let released = 0;
  for (const group of groups) {
    if (group.budget !== 'start' && group.budget !== 'other') continue;
    const budget: CardBudget = group.budget;
    const room = budgetCap(budget) - waitingWorkflowCards(group.flow_id, budget);
    if (room <= 0) continue;
    // The oldest `room` live waiting steps are the ones with a place. Each
    // keeps it whatever is done with it below: one already continuing raises
    // its card when its step runs again, one turned off and still executing
    // stops when it parks, and one stopped here frees its place for the next
    // tick.
    for (const row of queue.all(group.flow_id, budget, room)) {
      try {
        // A workflow turned off since this run began does not continue: a
        // parked run is stopped instead (Q-06), as the approval scheduler
        // does. One still executing finishes its step and stops when it
        // parks; it is not stopped mid-step.
        if (turnedOffReason(row.run_id)) {
          if (row.run_status === 'PAUSED') stopTurnedOffRun(group.flow_id, row.run_id);
          continue;
        }
        // Its run is already continuing (released earlier, or never parked).
        if (row.run_status !== 'PAUSED' || !row.waitpoint_id) continue;
        const waitpoint = getWaitpoint(row.waitpoint_id);
        if (!waitpoint || waitpoint.type !== 'DEFER' || waitpoint.resumedAt !== null) continue;
        if (claimContinuation({ runId: row.run_id, waitpoint, kind: 'deferred', resumePayload: {}, now }) === 'resumed') released++;
      } catch (error) {
        console.error(`[Workflow Authority] releasing waiting step ${row.id} failed:`, error);
      }
    }
  }
  return released;
}
