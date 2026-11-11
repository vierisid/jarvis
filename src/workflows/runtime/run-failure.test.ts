import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { delegationId, saveDelegation, type DelegationCheckpoint } from '../db/repos/delegation';
import { digest } from './effect-context';
import { getFlowVersion } from '../db/repos/flow-version';
import { closeWorkflowDb, initWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, updateRun, type FlowRun } from '../db/repos/flow-run';
import { saveWorkflowEffect, type WorkflowEffect } from '../db/repos/workflow-effect';
import { cancelFlowRun } from '../db/repos/run-cancellation';
import { getFlowRun } from '../db/repos/flow-run';
import { runFailure, runFailureNotice } from './run-failure';
import { failureText } from '../../failures/projection';

beforeEach(() => { initWorkflowDb(':memory:'); });
afterEach(() => { closeWorkflowDb(); });

const notifyStep = (name: string, next?: Record<string, unknown>) => ({ name, type: 'PIECE', displayName: 'Tell me',
  settings: { pieceName: '@jarvispieces/piece-jarvis-notify', pieceVersion: '0.0.1', actionName: 'notify', input: {} }, ...(next ? { nextAction: next } : {}) });
const codeStep = (next?: Record<string, unknown>) => ({ name: 'code', type: 'CODE', displayName: 'Post to the ledger', settings: { input: {} },
  ...(next ? { nextAction: next } : {}) });
const GRAPHS = {
  /** A Jarvis notify step followed by a CODE step. */
  notifyThenCode: notifyStep('notify', codeStep()),
  /** A CODE step followed by a Jarvis notify step. */
  codeThenNotify: codeStep(notifyStep('notify')),
  /** Jarvis pieces only: every effect goes through the boundary. */
  jarvisOnly: notifyStep('notify', notifyStep('notify_again')),
} as const;

function setup(status: FlowRun['status'] = 'RUNNING', graph: keyof typeof GRAPHS = 'notifyThenCode') {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Invoices', trigger: {
    name: 'trigger', type: 'EMPTY', nextAction: GRAPHS[graph] } as never });
  // A run that began has a start time, as the run handler records it.
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status,
    ...(status === 'RUNNING' ? { startTime: Date.now() } : {}) });
  const effect = (stepName: string, fields: Partial<WorkflowEffect>) => saveWorkflowEffect({
    id: `wfe_${stepName}_${fields.route ?? 'tool'}`, runId: run.id, projectId: run.projectId, flowId: flow.id, versionId: version.id,
    versionDigest: 'v', stepName, executionPath: [], route: 'tool', toolName: 't', actionCategory: 'write_data', requestDigest: 'r',
    arguments: {}, target: {}, provenance: {}, decision: 'allowed', reason: '', status: 'succeeded', approvalId: null, waitpointId: null,
    createdAt: Date.now(), ...fields });
  const fail = (failedStep: FlowRun['failedStep'], status: FlowRun['status'] = 'FAILED') => updateRun(run.id, { status, failedStep })!;
  return { run, effect, fail };
}

describe('runFailure (Q-19)', () => {
  test('the historical Notepad failure names the unsupported path without exposing raw text', () => {
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: 'Notepad', trigger: { name: 'trigger', type: 'EMPTY',
      nextAction: { name: 'launch', type: 'PIECE', settings: { pieceName: '@jarvispieces/piece-jarvis-tool', pieceVersion: '0.0.1',
        actionName: 'invoke', input: { toolName: 'desktop_launch_app' } } } } });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
    const failed = updateRun(run.id, { status: 'FAILED', failedStep: { name: 'launch', displayName: 'Open Notepad',
      errorMessage: 'Error: jarvis-tool: daemon response lacks an action outcome (500): {"error":"internal error: Unsupported direct workflow capability: desktop_launch_app has opaque code/UI effects; use a typed governed adapter"}' } })!;
    const failure = runFailure(failed)!;
    expect(failure).toMatchObject({ category: 'invalid_input', effect: 'none', code: 'WORKFLOW_TOOL_UNSUPPORTED' });
    expect(failure.headline).toContain('not supported by the workflow');
    expect(failure.next.some(n => n.step === 'edit_and_run_again')).toBe(true);
    expect(failure.detail).not.toContain('500');
    expect(runFailure({ ...failed, failedStep: { ...failed.failedStep!, errorMessage: 'Unsupported direct workflow capability: run_command has opaque code/UI effects' } })?.code).toBeNull();
  });

  test('a run that did not end badly has no failure', () => {
    const { run } = setup();
    expect(runFailure(run)).toBeNull();
    expect(runFailure(updateRun(run.id, { status: 'SUCCEEDED' })!)).toBeNull();
  });

  test('a readiness refusal reads from its typed issues', () => {
    const { run } = setup();
    const failed = updateRun(run.id, { status: 'FAILED', failedStep: { name: '<readiness>', displayName: 'Workflow readiness', errorMessage: 'not ready' },
      steps: { '<readiness>': { status: 'FAILED', output: { readiness: { ready: false, issues: [
        { node: 'notify', path: 'auth', code: 'CONNECTION_BINDING', message: 'Gmail is not connected' }] } } } } })!;
    expect(runFailure(failed)).toMatchObject({ category: 'missing_binding', effect: 'none', code: 'CONNECTION_BINDING',
      headline: 'The workflow did not run: a connection or other binding it needs is missing.' });
  });

  test('a Jarvis piece step with no effect record sent nothing, whatever its error says', () => {
    const { fail } = setup();
    const failure = runFailure(fail({ name: 'notify', displayName: 'Tell me', errorMessage: 'connection reset, may have sent' }))!;
    expect(failure).toMatchObject({ category: 'internal', effect: 'none', headline: 'The step "Tell me" failed.' });
    expect(failure.detail).toContain('connection reset');
  });

  test('an untracked CODE step may have taken effect', () => {
    const { fail } = setup();
    expect(runFailure(fail({ name: 'code', displayName: 'Post to the ledger', errorMessage: 'boom' }))).toMatchObject({
      category: 'internal', effect: 'unknown', next: [{ step: 'check_before_running_again' }, { step: 'open_details' }] });
  });

  test('a record from before typed outcomes still reads from its status', () => {
    const { effect, fail } = setup();
    effect('notify', { status: 'blocked', error: 'Workflow approval denied; effect was not executed' });
    expect(runFailure(fail({ name: 'notify', displayName: 'Tell me' }))).toMatchObject({ category: 'not_started', effect: 'none', code: 'NOT_DISPATCHED' });
  });

  test('an uncertain dispatch says it may have happened, and that earlier steps ran', () => {
    const { effect, fail } = setup();
    effect('notify', { route: 'notify', status: 'succeeded' });
    effect('code', { status: 'unknown', outcome: { status: 'unknown', code: 'DISPATCH_UNCERTAIN', message: 'lost', effect: 'may_have_occurred' } });
    expect(runFailure(fail({ name: 'code', displayName: 'Post to the ledger' }))).toMatchObject({ category: 'uncertain_effect', effect: 'unknown',
      outcome: 'It may already have taken effect. Steps before it had already run.' });
  });

  test('a step blocked partway, saying it may have acted, counts as having run for a later step', () => {
    // A blocked outcome that may have occurred (a skill stopped by the desktop switch midway,
    // or a resumable import stopped between slices) is not "never dispatched".
    for (const effect of ['may_have_occurred', 'not_started'] as const) {
      const { effect: save, fail } = setup('RUNNING', 'jarvisOnly');
      save('notify', { route: 'tool', status: 'blocked', outcome: { status: 'blocked', code: 'DESKTOP_DISABLED', message: 'desktop off', effect } });
      save('notify_again', { status: 'blocked', outcome: { status: 'blocked', code: 'AUTHORITY_DENIED', message: 'denied', effect: 'not_started' } });
      const outcome = runFailure(fail({ name: 'notify_again', displayName: 'Tell me' }))!.outcome;
      if (effect === 'may_have_occurred') expect(outcome).toBe('This step did nothing. Steps before it had already run.');
      else expect(outcome).not.toContain('had already run');
    }
  });

  test('a refused step after completed steps did nothing itself', () => {
    const { effect, fail } = setup();
    effect('notify', { route: 'notify', status: 'succeeded' });
    effect('code', { status: 'blocked', outcome: { status: 'blocked', code: 'AUTHORITY_DENIED', message: 'denied', effect: 'not_started' } });
    expect(runFailure(fail({ name: 'code', displayName: 'Post to the ledger' }))!.outcome).toBe('This step did nothing. Steps before it had already run.');
  });

  test('a stopped run says whether anything had gone out', () => {
    // Stopped while queued: it never began.
    const queued = setup('QUEUED');
    cancelFlowRun(queued.run.id);
    expect(runFailure(getFlowRun(queued.run.id)!)).toMatchObject({ category: 'cancelled', effect: 'none', outcome: 'Nothing was done.' });
    // Stopped while running: work in flight may have completed (the cancellation's own record says so).
    const running = setup();
    cancelFlowRun(running.run.id);
    expect(runFailure(getFlowRun(running.run.id)!)).toMatchObject({ category: 'cancelled', effect: 'unknown' });
    // Stopped after a step had sent something.
    const sent = setup('QUEUED');
    sent.effect('notify', { route: 'notify', status: 'succeeded' });
    cancelFlowRun(sent.run.id);
    expect(runFailure(getFlowRun(sent.run.id)!)).toMatchObject({ category: 'cancelled', effect: 'unknown' });
  });

  test('a notice outside the runtime gets the same sentence, never the run', () => {
    const { run, fail } = setup('RUNNING', 'jarvisOnly');
    expect(runFailureNotice(run.id)).toBeNull();
    fail({ name: '<engine>', displayName: 'engine', errorMessage: 'RPC timeout' });
    expect(runFailureNotice(run.id)).toBe('The run failed. Nothing was done. Run it again.');
    expect(runFailureNotice('missing-run')).toBeNull();
  });

  test('the engine failing in a workflow of Jarvis pieces with no dispatch did nothing', () => {
    const { fail } = setup('RUNNING', 'jarvisOnly');
    expect(runFailure(fail({ name: '<engine>', displayName: 'engine', errorMessage: 'RPC timeout' }))).toMatchObject({
      category: 'internal', effect: 'none', headline: 'The run failed.' });
  });

  // Review C2: a CODE step leaves no effect record, and an engine failure
  // leaves no trace, so it may have run.
  test('the engine failing in a workflow with a CODE step cannot claim nothing was done', () => {
    const { fail } = setup();
    expect(runFailure(fail({ name: '<engine>', displayName: 'engine', errorMessage: 'RPC timeout' }))).toMatchObject({
      category: 'internal', effect: 'unknown', headline: 'The run failed, and Jarvis cannot tell whether it took effect.',
      next: [{ step: 'check_before_running_again' }, { step: 'open_details' }] });
  });

  // The audit's 1000-item loop: the engine stopped the run at the size Jarvis keeps for one run.
  const LOG_CAP = 'executeFlow(run r1) -> LOG_SIZE_EXCEEDED\nAutomatic retry is disabled.';
  test('a run stopped at the data size it may keep says so, not that Jarvis cannot tell', () => {
    const { fail } = setup('RUNNING', 'jarvisOnly');
    const failure = runFailure(fail({ name: '<engine>', displayName: 'engine', errorMessage: LOG_CAP }))!;
    expect(failure).toMatchObject({ category: 'invalid_input', effect: 'none', code: 'RUN_LOG_SIZE_EXCEEDED',
      headline: 'The run stopped: it produced more data than Jarvis keeps for one run (10 MB).', outcome: 'Nothing after that point ran.' });
    expect(failure.next.map(n => n.step)).toEqual(['handle_less_data', 'open_details']);
    expect(failureText(failure)).not.toContain('cannot tell');
  });

  test('another engine status whose detail mentions the data limit is not read as it', () => {
    const { fail } = setup('RUNNING', 'jarvisOnly');
    const failure = runFailure(fail({ name: '<engine>', displayName: 'engine', errorMessage: 'executeFlow(run r1) -> INTERNAL_ERROR: x -> LOG_SIZE_EXCEEDED' }))!;
    expect(failure.code).not.toBe('RUN_LOG_SIZE_EXCEEDED');
  });

  test('a run stopped at the data size reads the steps before it the careful way', () => {
    const { run, fail } = setup('RUNNING', 'codeThenNotify');
    updateRun(run.id, { steps: { code: { status: 'SUCCEEDED', output: {} } } });
    expect(runFailure(fail({ name: '<engine>', displayName: 'engine', errorMessage: LOG_CAP }))).toMatchObject({
      effect: 'partial', outcome: 'Nothing after that point ran. Steps up to that point had already run.' });
  });

  test('a CODE step that ran before a failed Jarvis step: this step did nothing, but running again repeats it', () => {
    const { run, fail } = setup('RUNNING', 'codeThenNotify');
    updateRun(run.id, { steps: { code: { status: 'SUCCEEDED', output: {} } } });
    const failure = runFailure(fail({ name: 'notify', displayName: 'Tell me', errorMessage: 'bad input' }))!;
    expect(failure).toMatchObject({ effect: 'partial', outcome: 'This step did nothing. Steps before it had already run.' });
    expect(failure.next.map(n => n.step)).toEqual(['check_earlier_steps', 'open_details']);
  });

  test('a CODE step that may have run before a failed step, with no trace, may have acted', () => {
    const { fail } = setup('RUNNING', 'codeThenNotify');
    expect(runFailure(fail({ name: 'notify', displayName: 'Tell me' }))).toMatchObject({ effect: 'unknown',
      outcome: 'This step did nothing. Steps before it may already have run.' });
  });

  test('a CODE step after the failed step could not have run before it', () => {
    const { fail } = setup();
    expect(runFailure(fail({ name: 'notify', displayName: 'Tell me' }))).toMatchObject({ effect: 'none', outcome: 'Nothing was done.' });
  });

  // Review C1: the refused continuation did nothing, but the steps before the pause did.
  test('a resume refused after steps had run says so, and never offers a plain run again', () => {
    const { effect, fail } = setup('RUNNING', 'jarvisOnly');
    effect('notify', { route: 'notify', status: 'succeeded' });
    const failure = runFailure(fail({ name: '<resume>', displayName: 'Continue run', errorMessage: 'draft edited' }))!;
    expect(failure).toMatchObject({ category: 'not_started', effect: 'partial', code: 'WORKFLOW_CHANGED',
      headline: 'The run did not continue: the workflow changed while it was waiting.',
      outcome: 'Continuing it did nothing. Steps before the pause had already run.' });
    expect(failure.next.map(n => n.step)).toEqual(['check_earlier_steps', 'open_details']);
  });

  test('a resume refused before anything ran did nothing', () => {
    const { fail } = setup('RUNNING', 'jarvisOnly');
    expect(runFailure(fail({ name: '<resume>', displayName: 'Continue run' }))).toMatchObject({ effect: 'none', outcome: 'Nothing was done.',
      next: [{ step: 'run_again' }, { step: 'open_details' }] });
  });

  const expressionError = (reason: string) => 'engine executor: run r ended FAILED at step "notify": WorkflowExpressionError: '
    + `Unsupported workflow expression: ${reason} in {{ private_customer_email }}. token=secret-token\n    at /private/path/engine.js:1`;

  test('an input expression that failed on its data names the change first, on every surface', () => {
    const { run, fail } = setup('RUNNING', 'jarvisOnly');
    const failure = runFailure(fail({ name: 'notify', displayName: 'Tell me', errorMessage: expressionError('output size limit') }))!;
    // What took effect is unchanged: a Jarvis piece with no effect record sent nothing.
    expect(failure).toMatchObject({ category: 'internal', effect: 'none', headline: 'The step "Tell me" failed.', outcome: 'Nothing was done.' });
    expect(failure.next.map(n => n.step)).toEqual(['edit_and_run_again', 'open_details']);
    expect(failure.next[0]!.label).toContain("Narrow the earlier step's output");
    // Today's notice reads the same next step.
    expect(runFailureNotice(run.id)).toBe(`The step "Tell me" failed. Nothing was done. ${failure.next[0]!.label}`);
    const shown = JSON.stringify({ ...failure, detail: '' });
    for (const secret of ['private_customer_email', 'secret-token', '/private/path', 'WorkflowExpressionError']) expect(shown).not.toContain(secret);
  });

  test('expression guidance never makes a step that may have acted read as one that did nothing', () => {
    const { fail } = setup();
    const failure = runFailure(fail({ name: 'code', displayName: 'Post to the ledger', errorMessage: expressionError('non-JSON object') }))!;
    expect(failure).toMatchObject({ category: 'internal', effect: 'unknown' });
    expect(failure.next.map(n => n.step)).toEqual(['edit_and_run_again', 'check_before_running_again', 'open_details']);
    expect(failure.next[0]!.label).toContain('not plain JSON data');
  });

  test('expression guidance keeps the warning about earlier steps that already ran', () => {
    const { run, fail } = setup('RUNNING', 'codeThenNotify');
    updateRun(run.id, { steps: { code: { status: 'SUCCEEDED', output: {} } } });
    const failure = runFailure(fail({ name: 'notify', displayName: 'Tell me', errorMessage: expressionError('accessor property') }))!;
    expect(failure.effect).toBe('partial');
    expect(failure.next.map(n => n.step)).toEqual(['edit_and_run_again', 'check_earlier_steps', 'open_details']);
  });

  test('a typed outcome on the step decides the reading, not a message that quotes an expression failure', () => {
    const { effect, fail } = setup('RUNNING', 'jarvisOnly');
    effect('notify', { status: 'unknown', outcome: { status: 'unknown', code: 'DISPATCH_UNCERTAIN', message: 'x', effect: 'may_have_occurred' } });
    const failure = runFailure(fail({ name: 'notify', displayName: 'Tell me', errorMessage: expressionError('non-JSON object') }))!;
    expect(failure.next.some(n => n.step === 'edit_and_run_again')).toBe(false);
  });

  test('a loop step that failed may follow untracked steps later in the same loop body', () => {
    const flow = createFlow({});
    const loop = { name: 'loop', type: 'LOOP_ON_ITEMS', settings: { items: '{{trigger.items}}' },
      firstLoopAction: notifyStep('notify', codeStep()) };
    const version = createDraftVersion({ flowId: flow.id, displayName: 'Loop', trigger: { name: 'trigger', type: 'EMPTY', nextAction: loop } as never });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING', startTime: Date.now() });
    const failed = updateRun(run.id, { status: 'FAILED', failedStep: { name: 'notify', displayName: 'Tell me' } })!;
    expect(runFailure(failed)).toMatchObject({ effect: 'unknown', outcome: 'This step did nothing. Steps before it may already have run.' });
  });
});


test('delegated task failure is not hidden by successful spawn authorization', () => {
  const { run, effect, fail } = setup();
  effect('notify', { route: 'agent', status: 'succeeded', result: { dispatch: 'authorized' } });
  saveDelegation({ id: delegationId(run.id, 'notify', []), runId: run.id, stepName: 'notify', executionPath: [],
    versionDigest: digest(getFlowVersion(run.flowVersionId)!.trigger), roleId: 'test', goal: 'PRIVATE_GOAL',
    messages: [], toolsUsed: [], tokensUsed: { input: 0, output: 0 }, sequence: 1, iteration: 0, taint: [], failedToolCalls: [],
    status: 'completed', updatedAt: Date.now(), result: { status: 'completed', finalMessage: 'PRIVATE_ANSWER', toolCalls: [],
      outcome: { status: 'error', code: 'REQUIRED_TOOL_NOT_COMPLETED', effect: 'may_have_occurred', message: 'Required tools did not finish' } } });
  const result = runFailure(fail({ name: 'notify', displayName: 'Read Calendar' }))!;
  expect(result.code).toBe('REQUIRED_TOOL_NOT_COMPLETED');
  expect(result.headline).toContain('could not complete the tools required');
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  expect(result.next).toContainEqual(expect.objectContaining({ step: 'review_authority' }));
  expect(result.effect).toBe('unknown');
});

test('a delegate step inside a loop reads the failing iteration checkpoint', () => {
  const { run, effect, fail } = setup();
  effect('notify', { route: 'agent', status: 'succeeded', result: { dispatch: 'authorized' } });
  const at = (iteration: number, outcome: NonNullable<DelegationCheckpoint['result']>['outcome'], updatedAt: number): DelegationCheckpoint => ({
    id: delegationId(run.id, 'notify', [['loop', iteration]]), runId: run.id, stepName: 'notify', executionPath: [['loop', iteration]],
    versionDigest: digest(getFlowVersion(run.flowVersionId)!.trigger), roleId: 'test', goal: 'g', messages: [], toolsUsed: [],
    tokensUsed: { input: 0, output: 0 }, sequence: 1, iteration: 0, taint: [], failedToolCalls: [], status: 'completed', updatedAt,
    result: { status: 'completed', finalMessage: '', toolCalls: [], ...(outcome ? { outcome } : {}) } });
  saveDelegation(at(0, { status: 'succeeded' }, 1000));
  saveDelegation(at(1, { status: 'blocked', code: 'BROWSER_SIGN_IN_REQUIRED', effect: 'may_have_occurred', message: 'Sign in' }, 2000));
  expect(runFailure(fail({ name: 'notify', displayName: 'Read Calendar' }))!.code).toBe('BROWSER_SIGN_IN_REQUIRED');
});

// #1266: a human input step refused before it asked reached the run only as "failed, run it again".
describe('a human input step refused before it asked anyone', () => {
  /** The engine's step error for the sandbox API's typed refusal body, as it quotes it. */
  const engineError = (code: string, error: string) => `engine executor: run r ended FAILED at step "ask": ${JSON.stringify({ error,
    outcome: { status: 'blocked', code, message: error, effect: 'not_started' } }, null, 2)}\nAutomatic retry is disabled.`;
  const LIMIT = 'This workflow already has 20 requests waiting for an answer in Needs you (the limit is 20). Answer, reject or cancel some of them in Needs you, or stop runs that are waiting on them, then run it again.';
  function asking(pieceName: string, actionName: string) {
    const flow = createFlow({});
    const version = createDraftVersion({ flowId: flow.id, displayName: 'Check-ins', trigger: { name: 'trigger', type: 'EMPTY',
      nextAction: { name: 'ask', type: 'PIECE', displayName: 'Ask for the update', settings: { pieceName, pieceVersion: '0.0.1', actionName, input: {} } } } as never });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING', startTime: Date.now() });
    return (message: string) => updateRun(run.id, { status: 'FAILED', failedStep: { name: 'ask', displayName: 'Ask for the update', errorMessage: message } })!;
  }
  const STEPS = [['@jarvispieces/piece-jarvis-input', 'request_input'], ['@jarvispieces/piece-jarvis-input', 'request_approval'],
    ['@activepieces/piece-approval', 'create_approval_links'], ['@activepieces/piece-approval', 'wait_for_approval']] as const;

  test('at its workflow\'s limit of waiting requests: reads as that refusal, with its reason, for every asking step', () => {
    for (const [piece, action] of STEPS) {
      expect(runFailure(asking(piece, action)(engineError('HUMAN_INPUT_LIMIT', LIMIT)))).toMatchObject({ category: 'not_started', effect: 'none',
        code: 'HUMAN_INPUT_LIMIT', outcome: 'Nothing was done.',
        headline: 'The step "Ask for the update" did not run: this workflow already has 20 requests waiting for an answer in Needs you. Answer, reject or cancel some of them there, or stop runs waiting on them, first.',
        detail: `blocked HUMAN_INPUT_LIMIT: ${LIMIT}` });
    }
  });

  test('with Needs you off: reads as that refusal, saying how to turn it on', () => {
    expect(runFailure(asking('@jarvispieces/piece-jarvis-input', 'request_input')(engineError('HUMAN_INPUT_UNAVAILABLE', 'Needs you is off')))).toMatchObject({
      category: 'missing_binding', effect: 'none', code: 'HUMAN_INPUT_UNAVAILABLE',
      headline: 'The step "Ask for the update" did not run: Needs you is off or not ready on this Jarvis, so nothing could answer it. It needs the Brief dashboard (not JARVIS_DASHBOARD=legacy) with decisions on (JARVIS_BRIEF_DECISIONS=1); the details say which applies.' });
  });


  test('the same body from any other step, another code, or the code inside a string, is not read as it', () => {
    expect(runFailure(asking('@jarvispieces/piece-jarvis-notify', 'notify')(engineError('HUMAN_INPUT_LIMIT', LIMIT)))).toMatchObject({ category: 'internal', code: null });
    expect(runFailure(asking('@jarvispieces/piece-jarvis-input', 'request_input')(engineError('OTHER', LIMIT)))).toMatchObject({ category: 'internal', code: null });
    const quoted = `engine executor: step "ask": ${JSON.stringify({ error: 'internal error: bad title "outcome": {"code": "HUMAN_INPUT_LIMIT"}' })}`;
    expect(runFailure(asking('@jarvispieces/piece-jarvis-input', 'request_input')(quoted))).toMatchObject({ category: 'internal', code: null });
  });
});
