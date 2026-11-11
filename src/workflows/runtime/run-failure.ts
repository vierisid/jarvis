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
import { latestDelegation } from '../db/repos/delegation';
import { digest } from './effect-context';
import { listWorkflowEffects, type WorkflowEffect } from '../db/repos/workflow-effect';
import { walkFlowNodes } from '../db/flow-graph';
import type { FlowTriggerNode } from '../db/repos/flow-version';
import { nodeConnectionReferences, runConnectionBindingViews, type RunConnectionBindingView } from '../db/repos/binding-pins';
import { expressionFailureGuidance } from './expression-failure';
import { HUMAN_INPUT_LIMIT_CODE, HUMAN_INPUT_UNAVAILABLE_CODE, isHumanInputStep } from './human-input-contract';

const ENDED_BADLY = new Set(['FAILED', 'TIMEOUT', 'INTERNAL_ERROR', 'QUOTA_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED', 'SCHEDULE_FAILURE', 'STOPPED']);

const JARVIS_PIECE_PREFIX = '@jarvispieces/';

function dispatched(effect: WorkflowEffect): boolean {
  // Resumable work that ran slices did dispatch, pending or stopped: a stop
  // after them is blocked with an outcome that says effects may have occurred.
  if (effect.status === 'pending') return !!effect.partial;
  if (effect.status === 'blocked') return !!effect.outcome && effect.outcome.status !== 'succeeded' && effect.outcome.effect === 'may_have_occurred';
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

/** What the engine's fetch of a connection says when the run was refused it (Q-05): the engine itself reports only a bare loading error. */
export const CONNECTION_BINDING_REFUSED = 'CONNECTION_BINDING_REFUSED';

/**
 * #954: the binding of a connection this step names whose last fetch in this
 * run was not handed out, or null: a binding the run was refused (Q-05, the
 * credential was replaced or removed while the run was going), else an
 * expired token Jarvis could not refresh. A refusal says why the step failed
 * on its own, so a stale credential failure never stands in for it. The fetch
 * that failed did nothing; whether the step did anything before it (an earlier
 * attempt, an earlier round of a loop, a fetch mid-step) is `handedOut`'s and
 * the effect records' to say.
 *
 * A run read for a list carries no bindings, so they are read here, once, for
 * the failed step only; a list and the run's page then give the same advice.
 */
function credentialFailureFor(run: FlowRun, node: FlowTriggerNode): { binding: RunConnectionBindingView; code: string; message: string } | null {
  const named = new Set(nodeConnectionReferences(node).map(([externalId]) => externalId));
  const bindings = (run.connectionBindings ?? runConnectionBindingViews(run.id)).filter(binding => named.has(binding.externalId));
  const refused = bindings.find(binding => binding.refusal);
  if (refused?.refusal) return { binding: refused, code: CONNECTION_BINDING_REFUSED, message: refused.refusal.message };
  const failed = bindings.find(binding => binding.credentialFailure);
  return failed?.credentialFailure ? { binding: failed, code: failed.credentialFailure.code, message: failed.credentialFailure.message } : null;
}

/** The typed refusals of a human input step (#1266). */
const HUMAN_INPUT_REFUSALS = [HUMAN_INPUT_LIMIT_CODE, HUMAN_INPUT_UNAVAILABLE_CODE];
const HUMAN_INPUT_REFUSAL = new RegExp(`"outcome":\\s*\\{[^{}]*"code":\\s*"(${HUMAN_INPUT_REFUSALS.join('|')})"`);

/**
 * #1266: a human input step refused before it asked anyone: its workflow
 * already has as many requests waiting as it may, or nothing on this Jarvis
 * could answer one. The step leaves no effect record, so its typed refusal
 * reaches the run only in the engine's step error, as the sandbox API's
 * `{ error, outcome }` body; it is read from there for those steps and those
 * codes only. The input piece's one call is to Jarvis's own human-input
 * route, so the body carrying the code is Jarvis's.
 */
function humanInputRefusal(node: FlowTriggerNode | undefined, message: string | undefined): ActionFailure | null {
  if (!node || !isHumanInputStep(node.settings?.pieceName, node.settings?.actionName) || message === undefined) return null;
  const code = HUMAN_INPUT_REFUSAL.exec(message)?.[1];
  if (!code) return null;
  const said = /"error":\s*"((?:[^"\\]|\\.)*)"/.exec(message);
  let text = code;
  try { if (said) text = JSON.parse(`"${said[1]}"`); } catch { /* keep the code */ }
  return { status: 'blocked', code, effect: 'not_started', message: text };
}

/** Older direct UI refusals were recorded as untyped 500s. Match the exact saved tool and known daemon refusal. */
function unsupportedToolRefusal(node: FlowTriggerNode | undefined, message: string | undefined): ActionFailure | null {
  if (!node || node.settings?.pieceName !== '@jarvispieces/piece-jarvis-tool'
    || node.settings.actionName !== 'invoke' || !message) return null;
  const tool = node.settings.input?.toolName;
  if (typeof tool !== 'string' || !/^[a-z_]+$/.test(tool)) return null;
  if (!message.includes('WORKFLOW_TOOL_UNSUPPORTED:')
    && !message.includes(`Unsupported direct workflow capability: ${tool} has opaque code/UI effects`)) return null;
  return { status: 'blocked', code: 'WORKFLOW_TOOL_UNSUPPORTED', effect: 'not_started',
    message: 'This tool was not supported by the workflow execution path used by this run.' };
}

/**
 * The failure of a run that ended badly, or null for one that did not. Pass
 * `effects` and `nodes` when the caller already has them; nothing is read for
 * a run that did not end badly.
 */
export function runFailure(run: FlowRun, effects?: WorkflowEffect[], nodes?: FlowTriggerNode[]): UserFailure | null {
  if (!ENDED_BADLY.has(run.status)) return null;
  const records = effects ?? listWorkflowEffects(run.id);
  // Loaded at most once per run: for the graph when the caller has none, and
  // otherwise only when a delegation checkpoint has to be matched to it.
  let version: ReturnType<typeof getFlowVersion> | undefined;
  const loadVersion = () => (version ??= getFlowVersion(run.flowVersionId));
  const graph = nodes ?? walkFlowNodes(loadVersion()?.trigger);
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
  // A delegate step's own outcome is in its checkpoint, not in the spawn's
  // effect record; inside a loop, the latest iteration's checkpoint.
  const recorded = record ? failure(record) : null;
  const checkpoint = recorded ? null : latestDelegation(run.id, step.name);
  const delegated = checkpoint?.result?.outcome && checkpoint.versionDigest === digest(loadVersion()?.trigger)
    ? checkpoint.result.outcome : undefined;
  const node = graph.find(n => n.name === step.name);
  const outcome = recorded ?? (delegated && delegated.status !== 'succeeded' ? delegated : null) ?? humanInputRefusal(node, step.errorMessage)
    ?? (own.length === 0 ? unsupportedToolRefusal(node, step.errorMessage) : null);
  let evidence: FailureEvidence;
  let sideEffects = true;
  const credential = !outcome && node ? credentialFailureFor(run, node) : null;
  if (credential) {
    // A typed reason recorded by the connection fetch: that fetch handed nothing out.
    const { binding, code, message } = credential;
    const typed = projectFailure({ source: 'action', outcome: { status: 'blocked', code, message, effect: 'not_started' } },
      { label, sideEffects: false }, links);
    // The step may still have acted before it: a dispatch on its own record, or, for a step with no
    // records of its own, a credential this run handed out earlier (a retry, a loop round, a mid-step fetch).
    const acted = own.some(dispatched) || (!!binding.handedOut && untracked(node!));
    const reading = acted ? { ...typed, effect: 'unknown' as const,
      outcome: 'This run had already used this connection, so this step may already have taken effect.',
      next: recoverySteps(...typed.next.map(n => n.step).filter(s => s !== 'run_again' && s !== 'open_details'), 'check_before_running_again', 'open_details') }
      : typed;
    return withOtherSteps(reading, otherSteps(run, records, graph, step.name), 'Steps before it');
  }
  if (outcome) {
    if (record) Object.assign(links, { effectId: record.id, ...(record.approvalId ? { approvalId: record.approvalId } : {}) });
    const provider = record?.route === 'llm' ? providerCode(outcome.code) : null;
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
    sideEffects = own.some(dispatched) || !node || untracked(node);
  }
  // The sentence is about the failed step; it also says what the steps before it had done.
  const reading = withOtherSteps(projectFailure(evidence, { label, sideEffects }, links), otherSteps(run, records, graph, step.name), 'Steps before it');
  // An input expression that failed on its data: running it again unchanged
  // usually fails the same way, so the first step names what to change. Only the
  // advice changes; what took effect is read from the evidence above.
  const guidance = outcome ? null : expressionFailureGuidance(step.errorMessage);
  return guidance ? { ...reading, next: [{ step: 'edit_and_run_again', label: guidance },
    ...reading.next.filter(n => n.step !== 'run_again' && n.step !== 'edit_and_run_again')] } : reading;
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
