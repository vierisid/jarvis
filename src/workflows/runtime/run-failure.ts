/**
 * Q-19: a failed run as the person reads it, one projection that Runs and
 * Today both show. Derived on read from the run row and its effect records and
 * never stored, so it cannot disagree with the evidence it reads.
 *
 * The failed step's own record decides it: its typed outcome, a readiness
 * refusal's issues, an AI provider's error code, a cancellation. A failure
 * with no typed evidence reads as one that may have taken effect, unless the
 * step is a Jarvis piece with no effect record: every Jarvis piece reaches the
 * outside world only through the effect boundary, so no record means nothing
 * left Jarvis from that step.
 *
 * What the rest of the run did is read the same careful way. CODE steps and
 * Library pieces leave no effect record, so the run's step trace counts too,
 * and a run that left no trace (an engine failure, a production run that does
 * not stream progress) may have run any of them. Then the reading never says
 * nothing was done, and never offers a plain "run it again", which would
 * repeat them.
 */
import type { ActionFailure } from '../../actions/action-outcome';
import { providerCode } from '../../failures/evidence';
import { failureText, NOTHING_DONE, projectFailure, recoverySteps, type FailureEvidence, type FailureLinks, type UserFailure } from '../../failures/projection';
import { getFlowRun, type FlowRun } from '../db/repos/flow-run';
import { getFlowVersion } from '../db/repos/flow-version';
import { listWorkflowEffects, type WorkflowEffect } from '../db/repos/workflow-effect';
import { walkFlowNodes } from '../db/flow-graph';
import type { FlowTriggerNode } from '../db/repos/flow-version';

const ENDED_BADLY = new Set(['FAILED', 'TIMEOUT', 'INTERNAL_ERROR', 'QUOTA_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED', 'SCHEDULE_FAILURE', 'STOPPED']);

const JARVIS_PIECE_PREFIX = '@jarvispieces/';

function dispatched(effect: WorkflowEffect): boolean {
  if (effect.status === 'pending' || effect.status === 'blocked') return false;
  return !(effect.outcome && effect.outcome.status !== 'succeeded' && effect.outcome.effect === 'not_started');
}

function failure(effect: WorkflowEffect): ActionFailure | null {
  if (effect.outcome && effect.outcome.status !== 'succeeded') return effect.outcome;
  // Records from before typed outcomes: the status alone still says whether it dispatched.
  if (effect.status === 'blocked') return { status: 'blocked', code: 'NOT_DISPATCHED', message: effect.error ?? 'Not dispatched', effect: 'not_started' };
  if (effect.status === 'unknown' || effect.status === 'dispatching') {
    return { status: 'unknown', code: 'DISPATCH_UNCERTAIN', message: effect.error ?? 'Outcome unknown', effect: 'may_have_occurred' };
  }
  return null;
}

/** A step that can reach the outside world without an effect record: CODE, or a piece that is not Jarvis's own. */
function untracked(node: FlowTriggerNode): boolean {
  return node.type === 'CODE' || (node.type === 'PIECE' && !node.settings?.pieceName?.startsWith(JARVIS_PIECE_PREFIX));
}

/**
 * The steps that could have run before `step` failed: those ahead of it in the
 * graph's order (a router's other branches included, to be safe) and, inside a
 * loop, the rest of the loop body, which earlier iterations ran. With no step,
 * any of them.
 */
function couldHaveRunBefore(nodes: FlowTriggerNode[], step?: string): FlowTriggerNode[] {
  const at = step === undefined ? -1 : nodes.findIndex(node => node.name === step);
  if (at < 0) return nodes.filter(node => node.name !== step);
  const before = new Set(nodes.slice(0, at));
  for (const loop of nodes) {
    if (loop.type !== 'LOOP_ON_ITEMS' || !loop.firstLoopAction) continue;
    const body = walkFlowNodes(loop.firstLoopAction);
    if (body.some(node => node.name === step)) for (const node of body) before.add(node);
  }
  return [...before].filter(node => node.name !== step);
}

/**
 * What the run did apart from the step `except`: `yes` when an effect record
 * shows a dispatch or the trace shows an untracked step ran; `maybe` when the
 * run began, left no trace, and an untracked step could have run before;
 * `no` when nothing shows anything left Jarvis.
 */
export function otherSteps(run: FlowRun, effects: WorkflowEffect[], nodes: FlowTriggerNode[], except?: string): 'yes' | 'maybe' | 'no' {
  if (effects.some(effect => effect.stepName !== except && dispatched(effect))) return 'yes';
  const kinds = new Map(nodes.map(node => [node.name, untracked(node)]));
  const trace = Object.keys(run.steps ?? {}).filter(name => !name.startsWith('<') && name !== except);
  if (trace.some(name => kinds.get(name))) return 'yes';
  if (trace.length === 0 && run.startTime !== null && couldHaveRunBefore(nodes, except).some(untracked)) return 'maybe';
  return 'no';
}

/** A step's reading, adjusted for what the rest of the run had already done. */
function withOtherSteps(failure: UserFailure, other: 'yes' | 'maybe' | 'no', before: string, itself = 'This step did nothing.'): UserFailure {
  if (other === 'no') return failure;
  const said = other === 'yes' ? `${before} had already run.` : `${before} may already have run.`;
  const own = failure.next.map(n => n.step).filter(step => step !== 'run_again' && step !== 'open_details');
  return { ...failure, effect: failure.effect === 'none' ? (other === 'yes' ? 'partial' : 'unknown') : failure.effect,
    outcome: `${failure.outcome === NOTHING_DONE ? itself : failure.outcome} ${said}`,
    next: recoverySteps(...own, 'check_earlier_steps', 'open_details') };
}

function readinessIssues(run: FlowRun): Array<{ code: string; message?: string }> {
  const output = (run.steps?.['<readiness>'] as { output?: { readiness?: { issues?: unknown } } } | undefined)?.output;
  const issues = output?.readiness?.issues;
  return Array.isArray(issues)
    ? issues.filter((i): i is { code: string; message?: string } => !!i && typeof i === 'object' && typeof (i as { code?: unknown }).code === 'string')
      .map(i => ({ code: i.code, ...(typeof i.message === 'string' ? { message: i.message } : {}) }))
    : [];
}

/**
 * The failure of a run that ended badly, or null for one that did not. Pass
 * `effects` and `nodes` when the caller already has them; nothing is read for
 * a run that did not end badly.
 */
export function runFailure(run: FlowRun, effects?: WorkflowEffect[], nodes?: FlowTriggerNode[]): UserFailure | null {
  if (!ENDED_BADLY.has(run.status)) return null;
  const records = effects ?? listWorkflowEffects(run.id);
  const graph = nodes ?? walkFlowNodes(getFlowVersion(run.flowVersionId)?.trigger);
  const step = run.failedStep;
  const links: FailureLinks = { runId: run.id, flowId: run.flowId, ...(step ? { stepName: step.name } : {}) };

  if (run.status === 'STOPPED') {
    const sent = otherSteps(run, records, graph) !== 'no' || run.cancellation?.inFlightMayHaveCompleted === true;
    return projectFailure({ source: 'cancellation', dispatched: sent }, { label: 'The run', sideEffects: sent }, links);
  }
  if (!step || step.name === '<engine>') {
    return projectFailure({ source: 'unknown', message: step?.errorMessage ?? `The run ended ${run.status}` },
      { label: 'The run', sideEffects: otherSteps(run, records, graph) !== 'no' }, links);
  }
  if (step.name === '<readiness>') {
    return projectFailure({ source: 'readiness', issues: readinessIssues(run) }, { label: 'The workflow', sideEffects: false }, links);
  }
  if (step.name === '<resume>') {
    // The refused continuation did nothing; the steps before the pause may have.
    return withOtherSteps(projectFailure({ source: 'action', outcome: { status: 'blocked', code: 'WORKFLOW_CHANGED', effect: 'not_started',
      message: step.errorMessage ?? 'The workflow changed while the run was paused' } }, { label: 'The run', sideEffects: false }, links),
    otherSteps(run, records, graph), 'Steps before the pause', 'Continuing it did nothing.');
  }

  const label = `The step "${step.displayName}"`;
  const own = records.filter(effect => effect.stepName === step.name).sort((a, b) => a.createdAt - b.createdAt);
  const record = own.findLast(effect => failure(effect) !== null);
  const outcome = record ? failure(record) : null;
  let evidence: FailureEvidence;
  let sideEffects = true;
  if (record && outcome) {
    Object.assign(links, { effectId: record.id, ...(record.approvalId ? { approvalId: record.approvalId } : {}) });
    const provider = record.route === 'llm' ? providerCode(outcome.code) : null;
    if (provider) {
      // An AI call changes nothing outside Jarvis; what failed is the provider.
      evidence = { source: 'provider', code: provider, message: outcome.message };
      sideEffects = false;
    } else {
      evidence = { source: 'action', outcome };
    }
  } else {
    evidence = { source: 'unknown', message: step.errorMessage ?? `${step.displayName} failed` };
    // A record still pending (waiting on approval, or refused before its claim) never dispatched.
    const node = graph.find(n => n.name === step.name);
    sideEffects = own.some(dispatched) || !node || untracked(node);
  }
  // The sentence is about the failed step; it also says what the steps before it had done.
  return withOtherSteps(projectFailure(evidence, { label, sideEffects }, links), otherSteps(run, records, graph, step.name), 'Steps before it');
}

/**
 * A run's failure as one line for a notice, or null when it did not end badly.
 * Callers outside the workflow runtime get the sentence, never the run.
 */
export function runFailureNotice(runId: string): string | null {
  const run = getFlowRun(runId);
  const failure = run ? runFailure(run) : null;
  return failure ? failureText(failure) : null;
}
