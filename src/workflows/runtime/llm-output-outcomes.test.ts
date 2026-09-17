import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWorkflowDb, initWorkflowDb, DEFAULT_IDS } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion, updateDraftVersion, type FlowTriggerNode } from '../db/repos/flow-version';
import { createFlowRun, getFlowRun, updateRun } from '../db/repos/flow-run';
import { listWorkflowEffects, saveWorkflowEffect } from '../db/repos/workflow-effect';
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
import { createJarvisLlmChatRoute, type LlmChatFn } from '../sandbox-api/routes/jarvis-llm';
import { SandboxApi } from '../sandbox-api/server';
import { buildEngineBundle, ENGINE_BUILD_PATHS } from '../runner/engine-runtime/build';
import { buildAllJarvisPieces, buildPiece } from '../runner/engine-runtime/build-pieces';
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
function routeCall(runId: string, llmChat: LlmChatFn) {
  return (body: Record<string, unknown>) => createJarvisLlmChatRoute({ llmChat })({
    req: new Request('http://127.0.0.1/v1/jarvis/llm/chat', { method: 'POST',
      headers: { 'X-Jarvis-Step-Name': 'ask', 'X-Jarvis-Execution-Path': '[]' },
      body: JSON.stringify({ prompt: 'Return the invoice as JSON', ...body }),
    }), claims: { runId, projectId: DEFAULT_IDS.project, sandboxId: 'test' } as any, params: {},
  });
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
  const approvals = new ApprovalManager();
  const services = buildSandboxServiceBackends({ toolRegistry: registry, authorityEngine: authority,
    approvalManager: approvals, emergencyController: new EmergencyController(), auditTrail: new AuditTrail(),
    credentialResolver: new CredentialResolver(), eventBuffer: new WorkflowEventBuffer(),
    llmManager, channelService: {} as any, wsService: {} as any });
  const call = routeCall(run.id, services.llmChat!);
  return { flow, run, version, action, services, call, authority, approvals, calls: () => calls, downstream };
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
    expect(listWorkflowEffects(f.run.id)[0]).not.toHaveProperty('outcome');
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

  test('a handled schema mismatch is returned as data with the text and no parsed value', async () => {
    const f = fixture('{"total": "twelve"}');
    const response = await f.call({ outputSchema: INVOICE_SCHEMA, requireSuccess: false });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ text: '{"total": "twelve"}', outcome: { status: 'error', code: 'OUTPUT_SCHEMA_MISMATCH' } });
    expect('parsed' in body).toBe(false);
  });

  test('a reply that meets the schema succeeds with the parsed value, with or without parseJson', async () => {
    for (const extra of [{}, { parseJson: true }]) {
      const f = fixture('{"total": 12.5}');
      const response = await f.call({ outputSchema: INVOICE_SCHEMA, ...extra });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: '{"total": 12.5}', parsed: { total: 12.5 }, outcome: { status: 'succeeded' } });
      expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: 'succeeded', result: { parsed: { total: 12.5 }, outcome: { status: 'succeeded' } } });
    }
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

  test('a receipt written before the contract is evaluated at the route, not stamped succeeded', async () => {
    const f = fixture('{"total": 1}');
    expect((await f.call({ parseJson: true })).status).toBe(200);
    // The old daemon stored `{ text }` after a failed parse. Rewrite the
    // receipt into that shape; the boundary will hand it back on resume.
    const legacy = listWorkflowEffects(f.run.id)[0]!;
    legacy.result = { text: 'not json' };
    saveWorkflowEffect(legacy);
    const resumed = await f.call({ parseJson: true });
    expect(resumed.status).toBe(422);
    const body = await resumed.json();
    expect(body).toMatchObject({ text: 'not json', outcome: { code: 'INVALID_JSON_OUTPUT' } });
    expect('parsed' in body).toBe(false);
    expect(f.calls()).toBe(1);
  });

  test('a backend that answers with text alone gets the contract applied by the route', async () => {
    const f = fixture('unused');
    const bare = routeCall(f.run.id, async () => ({ text: 'not json' }));
    expect((await bare({ parseJson: true })).status).toBe(422);
    expect((await bare({})).status).toBe(200);
    const json = routeCall(f.run.id, async () => ({ text: '{"a": 1}' }));
    expect(await (await json({ parseJson: true })).json()).toEqual({ text: '{"a": 1}', parsed: { a: 1 }, outcome: { status: 'succeeded' } });
  });

  test('an approval parks the call with 202, and the resumed call validates against the approved schema', async () => {
    const f = fixture('{"total": "twelve"}');
    f.authority.setGovernedCategories(['read_data']);
    const parked = await f.call({ outputSchema: INVOICE_SCHEMA });
    expect(parked.status).toBe(202);
    expect(await parked.json()).toMatchObject({ text: '', approval: { effectId: expect.any(String) } });
    expect(f.calls()).toBe(0);
    const effect = listWorkflowEffects(f.run.id)[0]!;
    expect(effect).toMatchObject({ status: 'pending', decision: 'approval_required', arguments: { outputSchema: INVOICE_SCHEMA } });
    f.approvals.approve(effect.approvalId!, 'test');
    // A different schema is a different request; the recorded effect refuses it.
    await expect(f.call({ outputSchema: { type: 'array' } })).rejects.toThrow('changed since it was recorded');
    expect(f.calls()).toBe(0);
    const resumed = await f.call({ outputSchema: INVOICE_SCHEMA });
    expect(resumed.status).toBe(422);
    expect(await resumed.json()).toMatchObject({ outcome: { code: 'OUTPUT_SCHEMA_MISMATCH' } });
    expect(f.calls()).toBe(1);
  });
});

// Deliberately not gated on a cached bundle or `JARVIS_TEST_ENGINE_BUILD`,
// like the desktop-outcome suite: this is the headline evidence, and a gate
// on a cache another test file happens to fill would skip or run depending on
// the order `bun test` picks up files in.
describe('LLM output contract through the real engine', () => {
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

  test('required malformed JSON fails the step and nothing downstream runs', async () => {
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

  test('a handled step routes on the outcome and the branch reads the code and the text', async () => {
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

  test('a reply that meets the schema feeds its parsed fields downstream', async () => {
    const f = fixture('{"total": 42}');
    const ask = askAction({ outputSchema: JSON.stringify(INVOICE_SCHEMA) });
    ask.nextAction = toolAction('deliver', { path: '/synthetic', content: '{{ask.parsed.total}}' });
    const run = await runFlow(f, { ...f.version.trigger, nextAction: ask });
    expect(run.status).toBe('SUCCEEDED');
    expect(f.downstream).toHaveLength(1);
    expect(String((f.downstream[0] as { content: unknown }).content)).toBe('42');
  }, 60_000);

  test('a schema that is not JSON fails the step before any prompt is sent', async () => {
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

describe('compiled ask piece asserts the outcome', () => {
  let requests = 0;
  const failure = { status: 'error', code: 'INVALID_JSON_OUTPUT', message: 'synthetic contract failure', effect: 'may_have_occurred' };

  async function invoke(reply: unknown, status = 200, props: Record<string, unknown> = {}) {
    const built = await buildPiece(join(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/jarvis/ask'));
    const action = (await import(built.bundlePath)).jarvisAskPiece.getAction('ask');
    requests = 0;
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async () => {
      requests++;
      return new Response(JSON.stringify(reply), { status, headers: { 'Content-Type': 'application/json' } });
    } });
    try {
      return await action.run({ propsValue: { prompt: 'Return JSON', parseJson: true, ...props },
        server: { apiUrl: `http://127.0.0.1:${server.port}`, token: 'test' }, step: { name: 'ask', executionPath: [] },
        run: { waitForWaitpoint: () => { throw new Error('waiting for approval'); } },
      });
    } finally { server.stop(true); }
  }

  test('a required step throws the outcome message, whatever the HTTP status', async () => {
    await expect(invoke({ text: 'not json', outcome: failure }, 422)).rejects.toThrow('synthetic contract failure');
    await expect(invoke({ text: 'not json', outcome: failure }, 200)).rejects.toThrow('synthetic contract failure');
  }, 60_000);

  test('a handled step returns the failure for the graph', async () => {
    const reply = { text: 'not json', outcome: failure };
    expect(await invoke(reply, 200, { requireSuccess: false })).toEqual(reply);
  }, 60_000);

  test('a missing or malformed outcome fails closed', async () => {
    for (const outcome of [undefined, null, { status: 'success' }, { status: 'error' }]) {
      await expect(invoke({ text: 'legacy', outcome }, 200, { requireSuccess: false })).rejects.toThrow('lacks an action outcome');
    }
  }, 60_000);

  test('a refused request is reported with its status and reason', async () => {
    await expect(invoke({ error: 'outputSchema: unsupported schema keyword "pattern" at /' }, 400))
      .rejects.toThrow('daemon responded 400: {"error":"outputSchema: unsupported schema keyword');
  }, 60_000);

  test('an approval pauses before the piece expects an outcome', async () => {
    await expect(invoke({ text: '', approval: { effectId: 'effect', approvalId: 'approval', waitpointId: 'wait' } }, 202))
      .rejects.toThrow('waiting for approval');
  }, 60_000);

  test('a schema that is not JSON fails before the daemon is called', async () => {
    await expect(invoke({ text: '{}', parsed: {}, outcome: { status: 'succeeded' } }, 200, { outputSchema: '{"type":' }))
      .rejects.toThrow('outputSchema is not valid JSON');
    expect(requests).toBe(0);
  }, 60_000);

  test('a met contract returns text, parsed and the outcome', async () => {
    const reply = { text: '{"a":1}', parsed: { a: 1 }, outcome: { status: 'succeeded' } };
    expect(await invoke(reply, 200, { outputSchema: '{"type":"object"}' })).toEqual(reply);
    expect(requests).toBe(1);
  }, 60_000);
});
