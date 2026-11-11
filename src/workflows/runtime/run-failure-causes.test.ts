import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeWorkflowDb, initWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, updateRun, type FlowRun } from '../db/repos/flow-run';
import { delegationId, saveDelegation } from '../db/repos/delegation';
import { getFlowVersion } from '../db/repos/flow-version';
import { WORKFLOW_RETRY_GUIDANCE } from '../queue/retry-policy';
import { failureText } from '../../failures/projection';
import { digest } from './effect-context';
import { runFailure } from './run-failure';
import { publicRun } from './run-public';

beforeEach(() => { initWorkflowDb(':memory:'); });
afterEach(() => { closeWorkflowDb(); });

const STACK = [
  '    at execute (/home/someone/.cache/jarvis/engine/index.js:186246:15)',
  '    at async run (/home/someone/jarvis/dist/src/index.js:12:3)',
].join('\n');
/** The step error as the run handler stores it: the executor's wrapper, the engine's error report, the retry guidance. */
const report = (step: string, message: string) => `engine executor: run r1 ended FAILED at step "${step}": Error: ${message}\n${STACK}\n${WORKFLOW_RETRY_GUIDANCE}`;

const piece = (pieceName: string, actionName: string, displayName: string, name = 'step_1') =>
  ({ name, type: 'PIECE', displayName, settings: { pieceName, pieceVersion: '0.0.1', actionName, input: {} } });

function failedRun(node: Record<string, unknown>, errorMessage: string, steps?: Record<string, unknown>): FlowRun {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Checks', trigger: { name: 'trigger', type: 'EMPTY', nextAction: node } as never });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING', startTime: Date.now() });
  return updateRun(run.id, { status: 'FAILED', ...(steps ? { steps } : {}),
    failedStep: { name: node.name as string, displayName: node.displayName as string, errorMessage } })!;
}

describe('a step that makes no outside call failed', () => {
  const divide = () => failedRun(piece('@activepieces/piece-math-helper', 'division_math', 'Divide'), report('step_1', 'Second number cannot be zero'));

  test('says nothing was done and why, not that it cannot tell', () => {
    const failure = runFailure(divide())!;
    expect(failure).toMatchObject({ effect: 'none', headline: 'The step "Divide" failed.', outcome: 'Nothing was done. Second number cannot be zero.' });
    expect(failureText(failure)).toBe('The step "Divide" failed. Nothing was done. Second number cannot be zero. Fix the step, then run it again.');
    expect(failure.next.map(n => n.step)).toEqual(['fix_step', 'open_details']);
  });

  test('the same for every local helper piece, and for a bad regex, date and JSON', () => {
    const cases: Array<[string, string, string]> = [
      ['text-helper', 'find', 'Invalid regular expression: missing )'],
      ['date-helper', 'format_date', 'Failed to parse the date'],
      ['csv', 'convert_csv_to_json', 'Could not parse the CSV'],
      ['xml', 'convert-json-to-xml', 'Invalid XML name'],
    ];
    for (const [name, action, message] of cases) {
      const failure = runFailure(failedRun(piece(`@activepieces/piece-${name}`, action, 'Check'), report('step_1', message)))!;
      expect(failure).toMatchObject({ effect: 'none', headline: 'The step "Check" failed.', outcome: `Nothing was done. ${message}.` });
    }
  });

  test('a step that calls out is still read as possibly done', () => {
    const failure = runFailure(failedRun(piece('@activepieces/piece-slack', 'send_message', 'Post'), report('step_1', 'boom')))!;
    expect(failure).toMatchObject({ effect: 'unknown', outcome: 'It may already have taken effect.' });
  });

  test('earlier steps that may have acted are still reported', () => {
    const flow = createFlow({});
    const first = { ...piece('@activepieces/piece-slack', 'send_message', 'Post', 'first'),
      nextAction: piece('@activepieces/piece-math-helper', 'division_math', 'Divide', 'second') };
    const version = createDraftVersion({ flowId: flow.id, displayName: 'Checks', trigger: { name: 'trigger', type: 'EMPTY', nextAction: first } as never });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING', startTime: Date.now() });
    const failed = updateRun(run.id, { status: 'FAILED', steps: { first: { output: { type: 'PIECE', status: 'SUCCEEDED', input: {} } } },
      failedStep: { name: 'second', displayName: 'Divide', errorMessage: report('second', 'Second number cannot be zero') } })!;
    expect(runFailure(failed)).toMatchObject({ effect: 'partial', outcome: 'This step did nothing. Second number cannot be zero. Steps before it had already run.' });
  });
});

describe('the cause reaches the person and the stack never does', () => {
  test('no surface text or detail carries a stack frame, a path or the engine wrapper', () => {
    const run = failedRun(piece('@activepieces/piece-math-helper', 'division_math', 'Divide'), report('step_1', 'Second number cannot be zero'));
    const failure = runFailure(run)!;
    const text = JSON.stringify(failure);
    for (const leaked of ['/home/', 'index.js', '    at ', 'engine executor', 'Automatic retry']) expect(text).not.toContain(leaked);
    expect(failure.detail).toBe('Second number cannot be zero');
  });

  test('the same for a step that may have acted: its detail is the message, not the report', () => {
    const failure = runFailure(failedRun(piece('@activepieces/piece-slack', 'send_message', 'Post'), report('step_1', 'channel not found')))!;
    expect(failure.detail).toBe('channel not found');
  });

  test('the run API view cuts the stack from the failed step and from every step output', () => {
    const message = report('step_1', 'Second number cannot be zero');
    const run = failedRun(piece('@activepieces/piece-math-helper', 'division_math', 'Divide'), message, {
      step_1: { output: { type: 'PIECE', status: 'FAILED', input: {}, errorMessage: `Error: Second number cannot be zero\n${STACK}` } },
      loop: { output: { type: 'LOOP_ON_ITEMS', status: 'FAILED', input: {}, output: { iterations: [
        { inner: { type: 'PIECE', status: 'FAILED', input: {}, errorMessage: `Error: bad item\n${STACK}` } }] } } },
    });
    const view = publicRun(run);
    expect(view.failedStep?.errorMessage).toBe('Second number cannot be zero');
    expect(JSON.stringify(view)).not.toContain('index.js');
    expect(JSON.stringify(view)).not.toContain('/home/');
    expect((view.steps as { step_1: { output: { errorMessage: string } } }).step_1.output.errorMessage).toBe('Second number cannot be zero');
    expect(JSON.stringify(view.steps)).toContain('bad item');
    // The stored run keeps the report for the server's own readers.
    expect(run.failedStep?.errorMessage).toContain('index.js');
  });
});

describe('a reference with no value', () => {
  const missing = '"{{trigger.body.name}}" has no value in this run.';

  const post = (input: Record<string, unknown> = { text: 'Hi {{ trigger.body.name }}' }) =>
    ({ ...piece('@activepieces/piece-slack', 'send_message', 'Post'), settings: { pieceName: '@activepieces/piece-slack', pieceVersion: '0.0.1', actionName: 'send_message', input } });

  test('names the reference and says nothing was done, even for a step that can call out', () => {
    const failure = runFailure(failedRun(post(), report('step_1', missing)))!;
    expect(failure).toMatchObject({ effect: 'none', headline: 'The step "Post" failed.',
      outcome: 'Nothing was done. "{{trigger.body.name}}" has no value in this run.' });
    expect(failure.next.map(n => n.step)).toEqual(['fix_step', 'open_details']);
  });

  test('a router step with a missing operand reads as the router step failing', () => {
    const router = { name: 'router', type: 'ROUTER', displayName: 'Check the plan', settings: { executionType: 'EXECUTE_FIRST_MATCH', branches: [] } };
    const failure = runFailure(failedRun(router, report('router', missing)))!;
    expect(failure.links.stepName).toBe('router');
    expect(failure.headline).toBe('The step "Check the plan" failed.');
    expect(failure.outcome).toContain('"{{trigger.body.name}}" has no value in this run.');
  });

  test('the same when the engine recorded the step with no resolved input', () => {
    const failure = runFailure(failedRun(post(), report('step_1', missing), { step_1: { output: { type: 'PIECE', status: 'FAILED', input: {} } } }))!;
    expect(failure.effect).toBe('none');
  });

  test('an outside step that resolved its input and then returned that sentence is not read as having done nothing', () => {
    // A server's reply can say anything; the step record shows the input was resolved, so the step ran.
    // The engine pretty-prints an error whose message is JSON, with no class name before it.
    const reply = `engine executor: run r1 ended FAILED at step "step_1": ${JSON.stringify({ message: missing }, null, 2)}\n${WORKFLOW_RETRY_GUIDANCE}`;
    const failure = runFailure(failedRun(post(), reply,
      { step_1: { output: { type: 'PIECE', status: 'FAILED', input: { text: 'Hi Ana' } } } }))!;
    expect(failure.effect).toBe('unknown');
  });

  test('an outside step whose error names a reference its settings do not read is not read as having done nothing', () => {
    const failure = runFailure(failedRun(post({ text: 'Hello' }), report('step_1', missing)))!;
    expect(failure.effect).toBe('unknown');
  });

  test('a step that did something and then quotes that sentence is not read as having done nothing', () => {
    const failure = runFailure(failedRun(piece('@activepieces/piece-slack', 'send_message', 'Post'), report('step_1', `Posted, then failed: ${missing}`)))!;
    expect(failure.effect).toBe('unknown');
  });

  test('a step that already ran in an earlier loop round is not read as having done nothing', () => {
    const flow = createFlow({});
    const loop = { name: 'loop', type: 'LOOP_ON_ITEMS', displayName: 'Each', settings: { items: '{{trigger.body}}' },
      firstLoopAction: piece('@activepieces/piece-slack', 'send_message', 'Post') };
    const version = createDraftVersion({ flowId: flow.id, displayName: 'Loop', trigger: { name: 'trigger', type: 'EMPTY', nextAction: loop } as never });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING', startTime: Date.now() });
    const failed = updateRun(run.id, { status: 'FAILED', failedStep: { name: 'step_1', displayName: 'Post', errorMessage: report('step_1', missing) } })!;
    expect(runFailure(failed)!.effect).not.toBe('none');
  });
});

describe('a rejected human request', () => {
  const body = (code: string, error: string) => `engine executor: run r ended FAILED at step "step_1": ${JSON.stringify({ error,
    outcome: { status: 'blocked', code, message: error, effect: 'not_started' } }, null, 2)}\n${WORKFLOW_RETRY_GUIDANCE}`;

  test('says the request was rejected and nothing after it ran, with no advice to run it again', () => {
    const failure = runFailure(failedRun(piece('@jarvispieces/piece-jarvis-input', 'request_approval', 'Ask the owner'), body('HUMAN_INPUT_REJECTED', 'Human request rejected')))!;
    expect(failure).toMatchObject({ category: 'approval_denied', effect: 'none', code: 'HUMAN_INPUT_REJECTED',
      headline: 'The step "Ask the owner" did not continue: the request was rejected.', outcome: 'Nothing after it ran.' });
    expect(failure.next.map(n => n.step)).toEqual(['open_details']);
    expect(failureText(failure)).not.toContain('internal error');
    expect(failureText(failure)).not.toContain('Run it again');
  });
});

describe('a tool no workflow can run', () => {
  test('says so and to fix the step, never to run it again', () => {
    const body = `engine executor: run r ended FAILED at step "step_1": ${JSON.stringify({ error: 'Unsupported direct workflow capability: run_command has opaque code/UI effects',
      outcome: { status: 'blocked', code: 'WORKFLOW_TOOL_UNSUPPORTED', message: 'Unsupported', effect: 'not_started' } })}`;
    const failure = runFailure(failedRun(piece('@jarvispieces/piece-jarvis-tool', 'invoke', 'Run a command'), body))!;
    expect(failure).toMatchObject({ category: 'invalid_input', effect: 'none', code: 'WORKFLOW_TOOL_UNSUPPORTED' });
    // #1314 owns this code's wording: it did not run, and the step must change before running again.
    expect(failure.headline).toContain('did not run: this action is not supported');
    expect(failure.next.map(n => n.step)).not.toContain('run_again');
  });
});

describe('an agent step whose AI provider refused the key', () => {
  test('says nothing was done and points to AI settings', () => {
    const node = piece('@jarvispieces/piece-jarvis-agent', 'delegate', 'Research', 'agent');
    const run = failedRun(node, report('agent', 'The delegated agent failed'));
    saveDelegation({ id: delegationId(run.id, 'agent', []), runId: run.id, stepName: 'agent', executionPath: [],
      versionDigest: digest(getFlowVersion(run.flowVersionId)!.trigger), roleId: 'test', goal: 'g', messages: [], toolsUsed: [],
      tokensUsed: { input: 0, output: 0 }, sequence: 0, iteration: 0, taint: [], failedToolCalls: [], status: 'completed', updatedAt: 1,
      result: { status: 'error', finalMessage: '', toolCalls: [], error: 'Sub-agent error: 401',
        outcome: { status: 'error', code: 'PROVIDER_AUTH', message: '401 invalid x-api-key', effect: 'not_started' } } });
    const failure = runFailure(run)!;
    expect(failure).toMatchObject({ category: 'missing_binding', effect: 'none', outcome: 'Nothing was done.',
      headline: 'The step "Research" failed: the AI provider did not accept its credentials.' });
    expect(failure.next.map(n => n.step)).toEqual(['check_ai_settings', 'open_details']);
    expect(failureText(failure)).toContain('AI settings');
    expect(failureText(failure)).not.toContain('may or may not');
  });
});

describe('what a screen shows as the failed step message', () => {
  test('an expression size failure reads as the size advice, not the engine boilerplate', () => {
    const run = failedRun(piece('@jarvispieces/piece-jarvis-notify', 'notify', 'Tell me'), report('step_1',
      'Unsupported workflow expression: output size limit in {{ b1 }}. Workflow expressions are data only: property paths, literals, arithmetic'));
    const shown = publicRun(run).failedStep!.errorMessage!;
    expect(shown).toContain("larger or more deeply nested than a workflow step can carry");
    expect(shown).not.toMatch(/Workflow expressions are data only|\{\{/);
  });

  test('an engine failure on a loop list reads as plain advice', () => {
    const run = updateRun(failedRun(piece('@jarvispieces/piece-jarvis-notify', 'notify', 'Tell me'), 'x').id, { status: 'INTERNAL_ERROR',
      failedStep: { name: '<engine>', displayName: 'engine', errorMessage: 'executeFlow(run r) -> INTERNAL_ERROR: WorkflowExpressionError: Unsupported workflow expression: array size limit in {{ trigger.items }}. Workflow' } })!;
    const shown = publicRun(run).failedStep!.errorMessage!;
    expect(shown).toContain('10,000 values');
    expect(shown).not.toMatch(/INTERNAL_ERROR|executeFlow/);
  });
});
