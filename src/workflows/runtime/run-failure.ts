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
import { nodeConnectionReferences, type RunConnectionBindingView } from '../db/repos/binding-pins';
import { expressionFailureGuidance, failedOnMissingReference, loopInputFailure, missingReference } from './expression-failure';
import { HUMAN_INPUT_LIMIT_CODE, HUMAN_INPUT_REJECTED_CODE, HUMAN_INPUT_UNAVAILABLE_CODE, isHumanInputStep } from './human-input-contract';
import { IN_RUN_STEP_PIECES } from './step-admission';
import { WORKFLOW_SKILL_NOT_FOUND_CODE, WORKFLOW_TOOL_UNSUPPORTED_CODE } from './effect-capabilities';

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

/** Whether a step sits inside a loop's body, where an earlier round may already have run it. */
function inLoopBody(nodes: FlowTriggerNode[], node: FlowTriggerNode): boolean {
  return nodes.some(loop => loop.type === 'LOOP_ON_ITEMS' && !!loop.firstLoopAction
    && walkFlowNodes(loop.firstLoopAction).some(inner => inner.name === node.name));
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
    // "Nothing was done." is about this step only once earlier steps ran, so it says so; a cause after it stays.
    outcome: `${failure.outcome.startsWith(NOTHING_DONE) ? `${itself}${failure.outcome.slice(NOTHING_DONE.length)}` : failure.outcome} ${said}`,
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
 * #954: the binding of a connection this step names whose last fetch in this
 * run was not handed out (an expired token Jarvis could not refresh), or
 * null. A binding the run was refused (Q-05) says why the step failed on its
 * own, so a stale credential failure never stands in for it. The fetch that
 * failed did nothing; whether the step did anything before it (an earlier
 * attempt, an earlier round of a loop, a fetch mid-step) is `handedOut`'s and
 * the effect records' to say.
 */
function credentialFailureFor(run: FlowRun, node: FlowTriggerNode): RunConnectionBindingView | null {
  const named = new Set(nodeConnectionReferences(node).map(([externalId]) => externalId));
  const bindings = (run.connectionBindings ?? []).filter(binding => named.has(binding.externalId));
  if (bindings.some(binding => binding.refusal)) return null;
  return bindings.find(binding => binding.credentialFailure) ?? null;
}

const JARVIS_TOOL_PIECE = '@jarvispieces/piece-jarvis-tool';

/**
 * The typed refusals a step's own piece can raise before or instead of doing
 * its work: a human input step refused (#1266) or rejected by the person, a
 * Wait for Approval step that was not approved (#1322), and a tool step naming
 * a tool no workflow can run or a skill that is not saved.
 */
function typedRefusalCodes(node: FlowTriggerNode): string[] {
  if (isHumanInputStep(node.settings?.pieceName, node.settings?.actionName)) {
    return [HUMAN_INPUT_LIMIT_CODE, HUMAN_INPUT_UNAVAILABLE_CODE, HUMAN_INPUT_REJECTED_CODE, 'APPROVAL_DENIED', 'APPROVAL_EXPIRED'];
  }
  return node.settings?.pieceName === JARVIS_TOOL_PIECE ? [WORKFLOW_TOOL_UNSUPPORTED_CODE, WORKFLOW_SKILL_NOT_FOUND_CODE] : [];
}

/**
 * #1266: a step refused before it did anything, or stopped by a person's
 * rejection. These steps leave no effect record for it, so the typed refusal
 * reaches the run only in the engine's step error, as the sandbox API's
 * `{ error, outcome }` body; it is read from there for those steps and those
 * codes only. Each one's single call is to Jarvis's own route, so the body
 * carrying the code is Jarvis's.
 */
function typedStepRefusal(node: FlowTriggerNode | undefined, message: string | undefined): ActionFailure | null {
  const codes = node ? typedRefusalCodes(node) : [];
  if (!node || codes.length === 0 || message === undefined) return null;
  const code = new RegExp(`"outcome":\\s*\\{[^{}]*"code":\\s*"(${codes.join('|')})"`).exec(message)?.[1];
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

/** Every string in a step's settings, whitespace removed. */
function settingStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value.replace(/\s+/gu, ''));
  else if (Array.isArray(value)) for (const item of value) settingStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) settingStrings(item, out);
  return out;
}

/**
 * Whether the engine stopped this step while resolving its input, read from the
 * run's structure rather than from the error text alone: the engine records a
 * step's resolved input only after resolving it, so the step has no record or
 * one with an empty input, and the reference the error names is in the step's
 * own settings.
 */
function stoppedResolvingInput(run: FlowRun, node: FlowTriggerNode, message: string): boolean {
  const entry = run.steps?.[node.name] as { output?: unknown; input?: unknown } | undefined;
  const record = (entry?.output && typeof entry.output === 'object' && 'status' in entry.output ? entry.output : entry) as { input?: unknown } | undefined;
  const input = record?.input;
  if (record && !(input && typeof input === 'object' && Object.keys(input).length === 0)) return false;
  const named = missingReference(message);
  return named !== null && settingStrings(node.settings).some(text => text.includes(named));
}

/** A step that makes no call outside Jarvis: its piece only works on data inside the run. */
function makesNoOutsideCall(node: FlowTriggerNode): boolean {
  return node.type === 'PIECE' && IN_RUN_STEP_PIECES.has(node.settings?.pieceName ?? '');
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
  if (step?.name === '<engine>') {
    const input = loopInputFailure(step.errorMessage);
    if (input) {
      // The engine reads a loop's list before the loop has a record, so it ends the run with no step. The loop
      // is found from the graph; reading its list did nothing, and the steps before it may have.
      const flat = (text: unknown) => typeof text === 'string' ? text.replace(/\s+/gu, '') : '';
      const loop = graph.find(n => n.type === 'LOOP_ON_ITEMS' && flat(n.settings?.items).includes(flat(input.expression)));
      const named = loop ? { ...links, stepName: loop.name } : links;
      const label = loop ? `The step "${loop.displayName}"` : 'The run';
      return withOtherSteps(projectFailure({ source: 'local', message: input.text(loop ? 'This loop' : 'A loop in this workflow') },
        { label, sideEffects: false }, named), otherSteps(run, records, graph, loop?.name), 'Steps before it');
    }
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
  const outcome = recorded ?? (delegated && delegated.status !== 'succeeded' ? delegated : null) ?? typedStepRefusal(node, step.errorMessage)
    ?? (own.length === 0 ? unsupportedToolRefusal(node, step.errorMessage) : null);
  let evidence: FailureEvidence;
  let sideEffects = true;
  const binding = !outcome && node ? credentialFailureFor(run, node) : null;
  if (binding?.credentialFailure) {
    // A typed reason recorded by the connection fetch: that fetch handed nothing out.
    const { code, message } = binding.credentialFailure;
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
    // An AI step's record, or an agent step whose first model call was refused
    // (its delegation outcome carries the provider's code and no tool ran).
    const provider = record?.route === 'llm' || outcome === delegated ? providerCode(outcome.code) : null;
    if (provider) {
      // An AI call changes nothing outside Jarvis; what failed is the provider.
      evidence = { source: 'provider', code: provider, message: outcome.message };
      sideEffects = false;
    } else {
      evidence = { source: 'action', outcome };
    }
  } else {
    const message = step.errorMessage ?? `${step.displayName} failed`;
    // A step with no call outside Jarvis, or one that failed resolving its own
    // input, did nothing: the reading says so and names the cause. Such a step
    // inside a loop may have run in an earlier round, so only a step that makes
    // no outside call at all is read this way there.
    const noOutsideCall = !!node && makesNoOutsideCall(node);
    // A step with no effect record has only its error text to say where it stopped, and an outside
    // piece can put any text there: it counts only when the step record shows its input was never
    // resolved and the reference it names is one the step's own settings read.
    const beforeDispatch = !!node && failedOnMissingReference(message) && !own.some(dispatched)
      && (!untracked(node) || (!inLoopBody(graph, node) && stoppedResolvingInput(run, node, message)));
    evidence = noOutsideCall || beforeDispatch ? { source: 'local', message } : { source: 'unknown', message };
    // A record still pending (waiting on approval, or refused before its claim) never dispatched.
    sideEffects = own.some(dispatched) || !node || (untracked(node) && !noOutsideCall && !beforeDispatch);
  }
  // The sentence is about the failed step; it also says what the steps before it had done.
  const reading = withOtherSteps(projectFailure(evidence, { label, sideEffects }, links), otherSteps(run, records, graph, step.name), 'Steps before it');
  // An input expression that failed on its data: running it again unchanged
  // usually fails the same way, so the first step names what to change. Only the
  // advice changes; what took effect is read from the evidence above.
  const guidance = outcome ? null : expressionFailureGuidance(step.errorMessage);
  return guidance ? { ...reading, next: [{ step: 'edit_and_run_again', label: guidance },
    ...reading.next.filter(n => n.step !== 'run_again' && n.step !== 'edit_and_run_again' && n.step !== 'fix_step')] } : reading;
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
