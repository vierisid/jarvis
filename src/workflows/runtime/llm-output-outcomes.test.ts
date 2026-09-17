import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWorkflowDb, initWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion, updateDraftVersion, type FlowTriggerNode } from '../db/repos/flow-version';
import { createFlowRun, getFlowRun, updateRun } from '../db/repos/flow-run';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { enqueue } from '../db/repos/job-queue';
import { ToolRegistry } from '../../actions/tools/registry';
import type { LLMManager } from '../../llm/manager';
import { AuthorityEngine } from '../../authority/engine';
import { EmergencyController } from '../../authority/emergency';
import { ApprovalManager } from '../../authority/approval';
import { AuditTrail } from '../../authority/audit';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';
import { createJarvisLlmChatRoute } from '../sandbox-api/routes/jarvis-llm';
import { SandboxApi } from '../sandbox-api/server';
import { buildEngineBundle, findCachedBundle } from '../runner/engine-runtime/build';
import { buildAllJarvisPieces } from '../runner/engine-runtime/build-pieces';
import { EngineRuntime } from '../runner/engine-runtime/engine-runtime';
import { EngineFlowExecutor } from '../runner/engine-runtime/engine-flow-executor';
import { createRunFlowHandler } from '../runner/handler';
import { Worker } from '../queue/worker';

let directory: string, dbPath: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-llm-output-'));
  dbPath = join(directory, 'workflow.db');
  initWorkflowDb(dbPath);
});
afterEach(() => {
  closeWorkflowDb();
  rmSync(directory, { recursive: true, force: true });
});

const INVOICE_SCHEMA = { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] };

function askAction(input: Record<string, unknown>): FlowTriggerNode {
  return { name: 'ask', type: 'PIECE', displayName: 'ask', settings: {
    pieceName: '@jarvispieces/piece-jarvis-ask', pieceVersion: '0.0.1', actionName: 'ask',
    input: { prompt: 'Return the invoice as JSON', ...input },
  } };
}
function toolAction(name: string, params: Record<string, unknown>): FlowTriggerNode {
  return { name, type: 'PIECE', displayName: name, settings: {
    pieceName: '@jarvispieces/piece-jarvis-tool', pieceVersion: '0.0.1', actionName: 'invoke',
    input: { toolName: 'write_file', params },
  } };
}

/** Real service backends and Authority; only the model is scripted. */
function fixture(reply: string) {
  let calls = 0;
  const llmManager = { chat: async () => { calls++; return { content: reply }; } } as unknown as LLMManager;
  const registry = new ToolRegistry();
  const downstream: unknown[] = [];
  registry.register({ name: 'write_file', category: 'file-ops', description: 'Synthetic effect', parameters: {},
    execute: async args => { downstream.push(args); return 'receipt'; } });
  const flow = createFlow();
  const action = askAction({ parseJson: true });
  const version = createDraftVersion({ flowId: flow.id, displayName: 'LLM output contract',
    trigger: { name: 'trigger', type: 'EMPTY', nextAction: action } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const authority = new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
    learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' });
  const services = buildSandboxServiceBackends({ toolRegistry: registry, authorityEngine: authority,
    approvalManager: new ApprovalManager(), emergencyController: new EmergencyController(), auditTrail: new AuditTrail(),
    credentialResolver: new CredentialResolver(), eventBuffer: new WorkflowEventBuffer(),
    llmManager, channelService: {} as any, wsService: {} as any });
  const call = (body: Record<string, unknown>) => createJarvisLlmChatRoute(services)({
    req: new Request('http://127.0.0.1/v1/jarvis/llm/chat', { method: 'POST',
      headers: { 'X-Jarvis-Step-Name': 'ask', 'X-Jarvis-Execution-Path': '[]' },
      body: JSON.stringify({ prompt: 'Return the invoice as JSON', ...body }),
    }), claims: { runId: run.id, projectId: DEFAULT_IDS.project, sandboxId: 'test' } as any, params: {},
  });
  return { flow, run, version, action, services, call, calls: () => calls, downstream };
}

describe('LLM output contract through the route and the durable receipt', () => {
  test('required JSON that is not JSON is an error, and the text is kept beside it', async () => {
    const f = fixture('Sure! Here is the invoice: total 12');
    const response = await f.call({ parseJson: true });
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toEqual({ text: 'Sure! Here is the invoice: total 12',
      outcome: { status: 'error', code: 'INVALID_JSON_OUTPUT', effect: 'may_have_occurred', message: expect.stringContaining('not valid JSON') } });
    expect('parsed' in body).toBe(false);
    // The provider was called once and answered; that completed effect is
    // what the receipt records, with the failed contract inside its result.
    expect(f.calls()).toBe(1);
    expect(listWorkflowEffects(f.run.id)).toMatchObject([{ status: 'succeeded', route: 'llm', stepName: 'ask',
      result: { text: 'Sure! Here is the invoice: total 12', outcome: { code: 'INVALID_JSON_OUTPUT' } } }]);
  });

  test('a handled step receives the same outcome as data, still without a parsed value', async () => {
    const f = fixture('not json');
    const response = await f.call({ parseJson: true, requireSuccess: false });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ text: 'not json', outcome: { status: 'error', code: 'INVALID_JSON_OUTPUT' } });
    expect('parsed' in body).toBe(false);
  });

  test('valid JSON that misses the declared schema is a distinct error naming the path', async () => {
    const f = fixture('{"total": "twelve"}');
    const response = await f.call({ outputSchema: INVOICE_SCHEMA });
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({ text: '{"total": "twelve"}',
      outcome: { status: 'error', code: 'OUTPUT_SCHEMA_MISMATCH', effect: 'may_have_occurred', message: expect.stringContaining('/total') } });
    expect('parsed' in body).toBe(false);
  });

  test('a reply that meets the schema succeeds with the parsed value', async () => {
    const f = fixture('{"total": 12.5}');
    const response = await f.call({ outputSchema: INVOICE_SCHEMA });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: '{"total": 12.5}', parsed: { total: 12.5 }, outcome: { status: 'succeeded' } });
    expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: 'succeeded', result: { parsed: { total: 12.5 }, outcome: { status: 'succeeded' } } });
  });

  test('a step that did not ask for JSON succeeds with text, whatever the text is', async () => {
    const f = fixture('{not json');
    const response = await f.call({});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: '{not json', outcome: { status: 'succeeded' } });
  });

  test('a schema the validator cannot honor is refused before any prompt is sent', async () => {
    const f = fixture('{"total": 1}');
    const response = await f.call({ outputSchema: { type: 'object', patternProperties: {} } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'outputSchema: unsupported schema keyword "patternProperties" at /' });
    expect(f.calls()).toBe(0);
    expect(listWorkflowEffects(f.run.id)).toHaveLength(0);
  });

  test('requires a boolean handled-result declaration', async () => {
    const f = fixture('{}');
    expect((await f.call({ parseJson: true, requireSuccess: 'false' })).status).toBe(400);
    expect(f.calls()).toBe(0);
  });

  test('a failed contract is a terminal receipt: restart returns it without calling the model again', async () => {
    const f = fixture('not json');
    const first = await f.call({ parseJson: true });
    const body = await first.json();
    closeWorkflowDb(); initWorkflowDb(dbPath);
    const second = await f.call({ parseJson: true });
    expect(second.status).toBe(422);
    expect(await second.json()).toEqual(body);
    expect(f.calls()).toBe(1);
    expect(listWorkflowEffects(f.run.id)).toHaveLength(1);
  });

  test('the handled-result flag is not part of the effect identity', async () => {
    const f = fixture('{"total": 1}');
    const first = await (await f.call({ parseJson: true })).json();
    const second = await f.call({ parseJson: true, requireSuccess: true });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(first);
    expect(f.calls()).toBe(1);
  });
});

describe('LLM output contract through the real engine', () => {
  const skip = findCachedBundle() === null && process.env.JARVIS_TEST_ENGINE_BUILD !== '1';

  async function runFlow(f: ReturnType<typeof fixture>, trigger: FlowTriggerNode) {
    updateDraftVersion(f.version.id, { trigger });
    updateRun(f.run.id, { status: 'QUEUED' });
    const api = new SandboxApi({ services: f.services });
    await api.start({ port: 0 });
    const bundle = await buildEngineBundle();
    await buildAllJarvisPieces();
    const runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath });
    const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({
      executor: new EngineFlowExecutor(runtime, { terminalTimeoutMs: 3000 }),
    }) } });
    try {
      enqueue({ jobType: 'RUN_FLOW', flowRunId: f.run.id, maxAttempts: 1, payload: { runId: f.run.id } });
      await worker.drain();
      return getFlowRun(f.run.id)!;
    } finally { await runtime.shutdown(); await api.stop(); }
  }

  test.skipIf(skip)('required malformed JSON fails the step and nothing downstream runs', async () => {
    const f = fixture('Here you go: {"total": 12}');
    const ask = askAction({ parseJson: true });
    ask.nextAction = toolAction('deliver', { path: '/synthetic', content: 'should not run' });
    const run = await runFlow(f, { ...f.version.trigger, nextAction: ask });
    expect(run.status).toBe('FAILED');
    expect(run.failedStep?.errorMessage).toContain('not valid JSON');
    expect(f.downstream).toHaveLength(0);
    expect(f.calls()).toBe(1);
    expect(listWorkflowEffects(f.run.id)).toMatchObject([{ status: 'succeeded', route: 'llm', result: { outcome: { code: 'INVALID_JSON_OUTPUT' } } }]);
  }, 60_000);

  test.skipIf(skip)('a handled step routes on the outcome and the branch reads the code and the text', async () => {
    const f = fixture('not json');
    const ask = askAction({ parseJson: true, requireSuccess: false });
    ask.nextAction = { name: 'contract', type: 'ROUTER', settings: { executionType: 'EXECUTE_FIRST_MATCH', branches: [
      { branchName: 'failed', branchType: 'CONDITION', conditions: [[{ firstValue: '{{ask.outcome.status}}',
        operator: 'TEXT_EXACTLY_MATCHES', secondValue: 'error', caseSensitive: true }]] },
      { branchName: 'met', branchType: 'FALLBACK' },
    ] }, children: [
      toolAction('handle', { path: '/synthetic', content: '{{ask.outcome.code}}', reply: '{{ask.text}}' }),
      toolAction('deliver', { path: '/synthetic', content: 'should not run' }),
    ] };
    const run = await runFlow(f, { ...f.version.trigger, nextAction: ask });
    expect(run.status).toBe('SUCCEEDED');
    expect(f.downstream).toEqual([{ path: '/synthetic', content: 'INVALID_JSON_OUTPUT', reply: 'not json' }]);
  }, 60_000);

  test.skipIf(skip)('a reply that meets the schema feeds its parsed fields downstream', async () => {
    const f = fixture('{"total": 42}');
    const ask = askAction({ outputSchema: JSON.stringify(INVOICE_SCHEMA) });
    ask.nextAction = toolAction('deliver', { path: '/synthetic', content: '{{ask.parsed.total}}' });
    const run = await runFlow(f, { ...f.version.trigger, nextAction: ask });
    expect(run.status).toBe('SUCCEEDED');
    expect(f.downstream).toHaveLength(1);
    expect(String((f.downstream[0] as { content: unknown }).content)).toBe('42');
  }, 60_000);

  test.skipIf(skip)('a schema that is not JSON fails the step before any prompt is sent', async () => {
    const f = fixture('{"total": 42}');
    const ask = askAction({ outputSchema: '{"type": "object"' });
    ask.nextAction = toolAction('deliver', { path: '/synthetic', content: 'should not run' });
    const run = await runFlow(f, { ...f.version.trigger, nextAction: ask });
    expect(run.status).toBe('FAILED');
    expect(run.failedStep?.errorMessage).toContain('outputSchema is not valid JSON');
    expect(f.calls()).toBe(0);
    expect(f.downstream).toHaveLength(0);
    expect(listWorkflowEffects(f.run.id)).toHaveLength(0);
  }, 60_000);
});
