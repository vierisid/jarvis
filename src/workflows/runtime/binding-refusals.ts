/**
 * #1080: a workflow that cannot do its work because of what it is bound to
 * says so where a person looks, and tells them once.
 *
 * Two kinds of refusal:
 *  - before a run starts, readiness (Q-05's BINDING_STALE: a pinned
 *    connection or computer changed since the workflow was enabled). That
 *    one holds until someone enables or publishes the workflow again. The
 *    trigger manager raises its notice (`triggers/manager.ts`, once per new
 *    refusal).
 *  - while a run executes, a step refused for its binding: the computer the
 *    run is pinned to is offline, gone or unusable, or a recipient it was
 *    reviewed with is no longer current in memory. These are per run, and an
 *    offline computer can come back, so the notice here is once per flow and
 *    code and computer or recipients until a run shows those working again.
 *
 * The dashboard reads the same evidence: the latest finished run of an
 * enabled workflow, when it ended on one of these and the workflow was not
 * enabled or published again since, is why it is blocked.
 */
import { getWorkflowDb } from '../db';
import { readBindingPins } from '../db/repos/binding-pins';
import { getFlowRun, type FlowRun } from '../db/repos/flow-run';
import { listWorkflowEffects, type WorkflowEffect } from '../db/repos/workflow-effect';
import { getFlowVersion } from '../db/repos/flow-version';
import { boundedApprovalLabel } from '../../authority/approval-delivery';
import { TOAST_TITLE_MAX } from '../../comms/toast-limits';
import { failureText } from '../../failures/projection';
import { WORKFLOW_STEP_LABEL_MAX_CHARS } from './effect-boundary';
import { runFailure } from './run-failure';

/**
 * Step failures that are about what the run is bound to, not about the step's
 * own work, and that leave a typed effect record to read them from. Not here:
 * WORKFLOW_MACHINE_REPLACED and WORKFLOW_MACHINE_UNAVAILABLE. Those are thrown
 * while the step's target is first resolved, before its effect record is
 * written, so no run shows them as a code; a pinned computer no longer
 * enrolled is refused before the run starts instead (readiness, BINDING_STALE).
 */
export const BINDING_FAILURE_CODES: ReadonlySet<string> = new Set([
  'WORKFLOW_MACHINE_OFFLINE', 'WORKFLOW_FACT_STALE', 'WORKFLOW_FACT_AMBIGUOUS',
]);

const READINESS_STEP = '<readiness>';
const ENDED = `('SUCCEEDED','FAILED','TIMEOUT','INTERNAL_ERROR','QUOTA_EXCEEDED','MEMORY_LIMIT_EXCEEDED','SCHEDULE_FAILURE','STOPPED')`;
const CODES = `(${[...BINDING_FAILURE_CODES].map((code) => `'${code}'`).join(',')})`;

export interface BindingBlock {
  /** The typed code it was classified from. */
  code: string;
  /**
   * `readiness`: refused before it ran, and it holds until the workflow is
   * enabled or published again. `runtime`: the latest run was refused for its
   * computer or a recipient, which can clear without anyone acting (an
   * offline computer comes back), so it reads as that run's outcome.
   */
  kind: 'readiness' | 'runtime';
  /** The Q-19 headline: what happened, one sentence. */
  message: string;
  runId: string;
  at: number;
}

/** The binding refusal this ended run shows, or null. */
function blockOf(run: FlowRun): BindingBlock | null {
  if (run.status === 'SUCCEEDED') return null;
  const failure = runFailure(run);
  if (!failure) return null;
  const readiness = run.failedStep?.name === READINESS_STEP;
  if (!readiness && !(failure.code && BINDING_FAILURE_CODES.has(failure.code))) return null;
  return { code: failure.code ?? 'WORKFLOW_NOT_READY', kind: readiness ? 'readiness' : 'runtime', message: failure.headline,
    runId: run.id, at: run.finishTime ?? run.updated };
}

/**
 * Why an enabled workflow is blocked, or null: the most recently created of
 * its runs that has ended (a single-step test run aside) was refused for
 * readiness or for its binding, and the workflow was not enabled or published
 * again since (that is how a person accepts a changed binding, Q-05). A later
 * run that succeeded, or failed for another reason, clears it.
 *
 * Read on every poll of the workflows list, so the run is projected only when
 * its row and effect records already show one of these refusals.
 */
export function flowBindingBlock(flow: { id: string; project_id: string; status: string }): BindingBlock | null {
  if (flow.status !== 'ENABLED') return null;
  const db = getWorkflowDb();
  // Ordered as idx_brief_run_history, so this reads the index, not the runs.
  const row = db.query<{ id: string; status: string; failed_step: string | null; finish_time: number | null; updated: number }, [string, string]>(
    `SELECT id, status, failed_step, finish_time, updated FROM flow_run WHERE project_id = ? AND flow_id = ? AND status IN ${ENDED}
      AND step_name_to_test IS NULL ORDER BY created DESC, id DESC LIMIT 1`).get(flow.project_id, flow.id);
  if (!row || row.status === 'SUCCEEDED' || row.status === 'STOPPED' || !row.failed_step) return null;
  const accepted = readBindingPins(flow.id)?.pinnedAt;
  if (accepted !== undefined && (row.finish_time ?? row.updated) < accepted) return null;
  let readiness = false;
  try { readiness = (JSON.parse(row.failed_step) as { name?: unknown }).name === READINESS_STEP; } catch { return null; }
  if (!readiness && !db.query(`SELECT 1 FROM workflow_effect WHERE run_id = ?
      AND json_valid(record) AND json_extract(record, '$.outcome.code') IN ${CODES} LIMIT 1`).get(row.id)) return null;
  const run = getFlowRun(row.id);
  return run ? blockOf(run) : null;
}

const MACHINE_CODES = new Set(['WORKFLOW_MACHINE_OFFLINE']);
/** A refusal whose computer or step its record does not name: any working computer, or any working recipient step, clears it. */
const ANY_MACHINE = 'machine:*';
const ANY_RECIPIENT = 'fact:*';

/** The computer an effect ran on, as its target records it. */
function machineOf(effect: WorkflowEffect): string | null {
  const target = effect.target as { sidecarId?: unknown; selection?: unknown } | undefined;
  if (!target || !('sidecarId' in target)) return null;
  return `machine:${typeof target.sidecarId === 'string' ? target.sidecarId : 'local'}`;
}

/**
 * The step that sends to reviewed recipients, as a key. Keyed by the step, not
 * by the recipient: fixing a stale recipient changes its value, so the value
 * the refusal named never comes back.
 */
function recipientsOf(effect: WorkflowEffect): string | null {
  const facts = (effect.bindings as { facts?: unknown } | undefined)?.facts;
  return Array.isArray(facts) && facts.length > 0 ? `fact:${effect.stepName}` : null;
}

/**
 * What a refusal was about: the computer its refused step was bound to, or
 * the step whose reviewed recipient no longer holds. A notice is told once
 * per code and subject, and a later success clears it only when a step ran
 * on that same computer, or that same step sent to its reviewed recipients
 * (`recovered`). A run that took another branch, or a step that
 * failed and was let through ("continue on failure"), proves nothing.
 */
function subjectOf(run: FlowRun, code: string): string {
  const refused = listWorkflowEffects(run.id).filter((effect) => effect.stepName === run.failedStep?.name
    && effect.outcome?.status !== 'succeeded' && (effect.outcome as { code?: unknown } | undefined)?.code === code);
  const effect = refused.sort((a, b) => a.createdAt - b.createdAt).at(-1);
  const subject = effect ? (MACHINE_CODES.has(code) ? machineOf(effect) : recipientsOf(effect)) : null;
  return subject ?? (MACHINE_CODES.has(code) ? ANY_MACHINE : ANY_RECIPIENT);
}

/** The subjects a succeeded run shows working: each computer a succeeded step ran on, each recipient step that succeeded. */
function recovered(run: FlowRun): Set<string> {
  const subjects = new Set<string>();
  for (const effect of listWorkflowEffects(run.id)) {
    if (effect.status !== 'succeeded') continue;
    const machine = machineOf(effect);
    const recipients = recipientsOf(effect);
    if (machine) subjects.add(machine).add(ANY_MACHINE);
    if (recipients) subjects.add(recipients).add(ANY_RECIPIENT);
  }
  return subjects;
}

/**
 * flowId -> `code|subject` -> when it was told, since that subject last
 * worked. In memory: a restart may notify once more. Bounded by the flows and
 * the computers and recipient steps they name. Enabling or publishing the
 * workflow again (its binding pins taken later than a notice) forgets it too.
 */
const notified = new Map<string, Map<string, number>>();

/** The keys told for this flow, without those from before it was last enabled or published. */
function toldFor(flowId: string): Map<string, number> | undefined {
  const told = notified.get(flowId);
  const accepted = told ? readBindingPins(flowId)?.pinnedAt : undefined;
  if (told && accepted !== undefined) for (const [key, at] of told) if (at < accepted) told.delete(key);
  if (told && !told.size) notified.delete(flowId);
  return told?.size ? told : undefined;
}
const keyOf = (code: string, subject: string) => `${code}|${subject}`;

/**
 * A run ended. Returns the notice to raise when it was refused for its
 * binding at runtime and this flow has not been told about that code and
 * subject since that subject last worked; null otherwise. Readiness refusals
 * are not raised here: the trigger manager raises those as they happen. The
 * caller marks it told with `markBindingNoticeTold` once someone could see it.
 * A single-step test run neither raises nor clears anything.
 */
export function runtimeBindingNotice(runId: string): BindingBlock & { flowId: string; subject: string } | null {
  const run = getFlowRun(runId);
  if (!run || run.stepNameToTest) return null;
  if (run.status === 'SUCCEEDED') {
    const told = toldFor(run.flowId);
    if (told) {
      const working = recovered(run);
      for (const key of [...told.keys()]) if (working.has(key.slice(key.indexOf('|') + 1))) told.delete(key);
      if (!told.size) notified.delete(run.flowId);
    }
    return null;
  }
  if (run.failedStep?.name === READINESS_STEP) return null;
  const block = blockOf(run);
  if (!block) return null;
  const subject = subjectOf(run, block.code);
  if (toldFor(run.flowId)?.has(keyOf(block.code, subject))) return null;
  return { ...block, flowId: run.flowId, subject };
}

/** The owner was told about this flow's refusal with this code and subject. */
export function markBindingNoticeTold(flowId: string, code: string, subject: string, at = Date.now()): void {
  let told = notified.get(flowId);
  if (!told) notified.set(flowId, told = new Map());
  told.set(keyOf(code, subject), at);
}

const NOTICE_TITLE = 'Workflow needs attention';
/** The workflow name's share of a toast title (`TOAST_TITLE_MAX`), after the title, ": " and a "..." cut mark. */
const NOTICE_NAME_MAX = TOAST_TITLE_MAX - NOTICE_TITLE.length - 2 - 3;

/**
 * Title and body of a "Workflow needs attention" notice for a run that ended
 * badly. The title names the workflow; the body is the Q-19 sentence Runs and
 * Today show, with the step's display name bounded to one line of 120 like
 * every workflow card and audit label. Both are author-controlled text.
 */
export function workflowRunNotice(runId: string, fallback: string): { title: string; body: string } {
  const run = getFlowRun(runId);
  const name = run ? getFlowVersion(run.flowVersionId)?.displayName?.trim() : undefined;
  const title = name ? `${NOTICE_TITLE}: ${boundedApprovalLabel(name, NOTICE_NAME_MAX)}` : NOTICE_TITLE;
  const step = run?.failedStep;
  const failure = run ? runFailure(step ? { ...run, failedStep: { ...step,
    displayName: boundedApprovalLabel(step.displayName ?? step.name, WORKFLOW_STEP_LABEL_MAX_CHARS) } } : run) : null;
  return { title, body: failure ? failureText(failure) : fallback };
}

/** What the owner is told, in the shape the daemon's notifier takes. */
export type BindingNotification = {
  id: string;
  kind: 'workflow';
  title: string;
  body: string;
  actions: Array<{ id: string; label: string; primary?: boolean }>;
};

/**
 * The RUN_FLOW handler's run-ended hook: raise a notice through `notify` for
 * a run refused for its binding, once per flow and code (`runtimeBindingNotice`).
 * The body is the Q-19 sentence Runs and Today show for that run. `notify`
 * returns false when nobody could see it (no computer connected); the notice
 * then counts as not told, and the next refusal tells it.
 */
export function bindingRefusalNotifier(notify: (notice: BindingNotification) => boolean | void): (runId: string) => void {
  return (runId) => {
    const notice = runtimeBindingNotice(runId);
    if (!notice) return;
    const delivered = notify({
      id: `workflow-binding:${runId}`, kind: 'workflow',
      ...workflowRunNotice(runId, `${notice.message} See its failed run for details.`),
      actions: [{ id: 'review', label: 'Open Jarvis', primary: true }, { id: 'dismiss', label: 'Dismiss' }],
    });
    if (delivered !== false) markBindingNoticeTold(notice.flowId, notice.code, notice.subject);
  };
}

/** Tests only. */
export function _resetBindingNoticesForTests(): void {
  notified.clear();
}
