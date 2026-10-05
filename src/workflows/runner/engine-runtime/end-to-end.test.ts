import { configureWorkflowReadiness } from '../../db/repos/flow-readiness';
import { PieceCatalog, metadataToCatalogEntry } from '../../runtime/piece-catalog';
/**
 * Phase F end-to-end smoke: spawn the engine, load Jarvis pieces from disk,
 * run a real flow with a manual trigger + echo action, assert SUCCEEDED.
 *
 * This is the gate the proposal called out -- if this works, porting the rest
 * of the Jarvis pieces is mechanical. Skipped when the engine bundle isn't on
 * disk; when run, builds the pieces (idempotent) before spawning.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { closeWorkflowDb, initWorkflowDb } from "../../db";
import { createFlow, setFlowCodeStepsEnabled } from "../../db/repos/flow";
import { publishFlowVersion } from "../../db/repos/flow-publication";
import {
  createDraftVersion,
  getFlowVersion,
  lockVersion,
  updateDraftVersion,
  setSampleInputEntry,
} from "../../db/repos/flow-version";
import type { FlowTriggerNode } from "../../db/repos/flow-version";
import { createFlowRun, getFlowRun } from "../../db/repos/flow-run";
import { DEFAULT_IDS } from "../../db/schema";
import { CredentialResolver } from "../../credentials/adapter";
import { SandboxApi } from "../../sandbox-api/server";
import type { LlmChatFn } from "../../sandbox-api/routes/jarvis-llm";
import type { ToolsInvokeFn } from "../../sandbox-api/routes/jarvis-tools";
import type { NotifyFn } from "../../sandbox-api/routes/jarvis-notify";
import type { JarvisContextProvider } from "../../sandbox-api/routes/jarvis-context";
import type { AgentDelegateFn } from "../../sandbox-api/routes/jarvis-agent";
import type { WorkflowsStartFn } from "../../sandbox-api/routes/jarvis-workflows";
import { findCachedBundle, buildEngineBundle, ENGINE_BUILD_PATHS } from "./build";
import { buildAllJarvisPieces } from "./build-pieces";
import { EngineRuntime } from "./engine-runtime";
import { EngineFlowExecutor } from './engine-flow-executor';
import { Worker } from '../../queue/worker';
import { createRunFlowHandler } from '../handler';
import { createWorkflowRoutes } from '../../api/routes';

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const initialCached = findCachedBundle();
const skipBundleTests = initialCached === null && !buildOptIn;
const piecesAlreadyBuilt = existsSync(
  resolve(
    ENGINE_BUILD_PATHS.VENDOR_PACKAGES,
    "pieces/jarvis/test/dist/src/index.js",
  ),
);
const skipE2eTests = skipBundleTests || (!piecesAlreadyBuilt && !buildOptIn);

const PIECE_TEST_NAME = "@jarvispieces/piece-jarvis-test";
const PIECE_ASK_NAME = "@jarvispieces/piece-jarvis-ask";
const PIECE_TOOL_NAME = "@jarvispieces/piece-jarvis-tool";
const PIECE_NOTIFY_NAME = "@jarvispieces/piece-jarvis-notify";
const PIECE_CONTEXT_NAME = "@jarvispieces/piece-jarvis-context";
const PIECE_AGENT_NAME = "@jarvispieces/piece-jarvis-agent";
const PIECE_TRIGGER_NAME = "@jarvispieces/piece-jarvis-trigger";
const PIECE_VERSION = "0.0.1";

describe("Engine end-to-end (F gate)", () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;
  let llmCalls: Array<{ prompt: string; system?: string; parseJson?: boolean }> = [];

  const llmChat: LlmChatFn = async (req) => {
    llmCalls.push(req);
    return { text: `(stubbed reply to: ${req.prompt})` };
  };

  beforeAll(async () => {
    initWorkflowDb(":memory:");
    api = new SandboxApi({
      services: { credentialResolver: new CredentialResolver(), llmChat },
    });
    await api.start({ port: 0 });

    let cached = initialCached;
    if (!cached && buildOptIn) {
      cached = await buildEngineBundle();
    }
    if (!cached) return;
    if (buildOptIn) {
      await buildAllJarvisPieces();
    }
    runtime = new EngineRuntime({ api, bundlePath: cached.bundlePath });
    const metadataHandle = await runtime.acquire({ runId: 'readiness-metadata', projectId: DEFAULT_IDS.project });
    try {
      const metadata = await metadataHandle.extractPieceMetadata({ pieceName: PIECE_TEST_NAME, pieceVersion: PIECE_VERSION });
      const askMetadata = await metadataHandle.extractPieceMetadata({ pieceName: PIECE_ASK_NAME, pieceVersion: PIECE_VERSION });
      configureWorkflowReadiness({ pieces: new PieceCatalog([metadataToCatalogEntry(metadata), metadataToCatalogEntry(askMetadata)]) });
    } finally { await metadataHandle.release(); }
  }, 30_000);

  afterAll(async () => {
    // Engines first: reclaim anything this runtime spawned while the
    // SandboxApi it talks to is still up (#491).
    await runtime?.shutdown();
    await api.stop();
    closeWorkflowDb();
  });

  test.skipIf(skipE2eTests)('readiness runtime guards stop absent and empty inputs before a real piece calls its backend', async () => {
    for (const prompt of [undefined, '{{trigger.missing}}', 'prefix {{trigger.missing}}', '{{trigger.missing ?? ""}}', '{{trigger.missing ?? "fallback"}}']) {
      const before = llmCalls.length;
      const flow = createFlow();
      const version = createDraftVersion({ flowId: flow.id, displayName: 'Runtime readiness', trigger: {
        name: 'trigger', type: 'EMPTY', nextAction: {
          name: 'ask', type: 'PIECE', settings: { pieceName: PIECE_ASK_NAME, pieceVersion: PIECE_VERSION, actionName: 'ask', input: prompt === undefined ? {} : { prompt } },
        },
      } });
      const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, environment: 'TESTING' });
      const handle = await runtime!.acquire({ runId: run.id, projectId: DEFAULT_IDS.project });
      try {
        const result = await handle.executeFlow({ flowVersion: version });
        const valid = prompt?.includes('"fallback"') === true;
        expect(result.status).toBe(valid ? 'SUCCEEDED' : 'FAILED');
        expect(llmCalls.length - before).toBe(valid ? 1 : 0);
      } finally { await handle.release(); }
    }
  }, 45_000);

  test.skipIf(skipE2eTests)('R3: API preview executes its saved override through the outer worker despite unfinished neighbors', async () => {
    const before = llmCalls.length;
    const flow = createFlow();
    const version = createDraftVersion({ flowId: flow.id, displayName: 'Preview draft', trigger: {
      name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'schedule', input: { cron_expression: 'unfinished schedule' } },
      nextAction: { name: 'selected', type: 'PIECE', settings: { pieceName: PIECE_ASK_NAME, pieceVersion: PIECE_VERSION, actionName: 'ask', input: {} },
        nextAction: { name: 'unfinished', type: 'PIECE', settings: { pieceName: PIECE_ASK_NAME, pieceVersion: PIECE_VERSION, actionName: 'ask', input: {} } },
      },
    } });
    setSampleInputEntry(version.id, 'selected', { prompt: 'preview override' });
    const request = Object.assign(new Request('http://local/run', { method: 'POST', body: JSON.stringify({ stepNameToTest: 'selected', environment: 'TESTING' }) }), { params: { id: flow.id } });
    const response = await createWorkflowRoutes()['/api/workflows/:id/run']!.POST!(request);
    expect(response.status).toBe(202);
    const run = await response.json() as { id: string };
    const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime!) }) } });
    await worker.drain();
    expect(getFlowRun(run.id)?.status).toBe('SUCCEEDED');
    expect(llmCalls.slice(before).map(c => c.prompt)).toEqual(['preview override']);
    expect(getFlowRun(run.id)?.steps?.unfinished).toBeUndefined();
    expect(getFlowVersion(version.id)!.trigger.nextAction!.settings!.input).toEqual({});
    expect(() => publishFlowVersion(flow.id, version.id)).toThrow();
  }, 30_000);

  test.skipIf(skipE2eTests)('R1: presence routers inspect missing outputs without relaxing other expressions', async () => {
    const ask = (name: string, prompt: string): FlowTriggerNode => ({ name, type: 'PIECE', settings: { pieceName: PIECE_ASK_NAME, pieceVersion: PIECE_VERSION, actionName: 'ask', input: { prompt } } });
    for (const [operand, operator, expected] of [
      ['{{first.missing}}', 'DOES_NOT_EXIST', 'matched'],
      ['{{first.missing}}', 'EXISTS', 'fallback'],
      ['{{first}}', 'EXISTS', 'matched'],
      ['{{first.missing}}', 'TEXT_EXACTLY_MATCHES', null],
    ] as const) {
      const before = llmCalls.length;
      const first = ask('first', 'inspect output');
      first.nextAction = { name: 'router', type: 'ROUTER', settings: { executionType: 'EXECUTE_FIRST_MATCH', branches: [
        { branchType: 'CONDITION', branchName: 'Match', conditions: [[{ firstValue: operand, operator, ...(operator === 'TEXT_EXACTLY_MATCHES' ? { secondValue: '' } : {}) }]] },
        { branchType: 'FALLBACK', branchName: 'Otherwise' },
      ] }, children: [ask('matched', 'matched'), ask('fallback', 'fallback')] };
      const flow = createFlow();
      const version = createDraftVersion({ flowId: flow.id, displayName: 'Presence', trigger: { name: 'trigger', type: 'EMPTY', nextAction: first } });
      const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, environment: 'TESTING' });
      const handle = await runtime!.acquire({ runId: run.id, projectId: DEFAULT_IDS.project });
      try {
        if (expected) {
          const result = await handle.executeFlow({ flowVersion: version });
          expect(result.status).toBe('SUCCEEDED');
        } else {
          await expect(handle.executeFlow({ flowVersion: version })).rejects.toThrow('absent value');
        }
        expect(llmCalls.slice(before).map(c => c.prompt)).toEqual(expected ? ['inspect output', expected] : ['inspect output']);
      } finally { await handle.release(); }
    }
  }, 60_000);

  const optional = '{{trigger.optional}}';
  const exists = { firstValue: optional, operator: 'EXISTS' };
  const absent = { firstValue: optional, operator: 'DOES_NOT_EXIST' };
  const contains = { firstValue: optional, operator: 'TEXT_CONTAINS', secondValue: 'approved' };
  for (const executionType of ['EXECUTE_FIRST_MATCH', 'EXECUTE_ALL_MATCH'] as const) {
    for (const fixture of [
      { label: 'false AND guard skips comparison', conditions: [[exists, contains]], payload: {}, expected: 'fallback', evaluated: [1] },
      { label: 'true OR group skips later group', conditions: [[absent], [contains]], payload: {}, expected: 'matched', evaluated: [1] },
      { label: 'true guard evaluates a matching comparison', conditions: [[exists, contains]], payload: { optional: 'approved' }, expected: 'matched', evaluated: [2] },
      { label: 'true guard evaluates a false comparison', conditions: [[exists, contains]], payload: { optional: 'rejected' }, expected: 'fallback', evaluated: [2] },
      { label: 'false OR group proceeds to the next', conditions: [[absent], [contains]], payload: { optional: 'approved' }, expected: 'matched', evaluated: [1, 1] },
      { label: 'evaluated absent comparison remains an error', conditions: [[absent, contains]], payload: {}, expected: null, evaluated: [] },
      { label: 'false OR group cannot hide an absent comparison', conditions: [[exists], [contains]], payload: {}, expected: null, evaluated: [] },
    ]) {
      test.skipIf(skipE2eTests)(`R7: ${fixture.label} (${executionType})`, async () => {
        const before = llmCalls.length;
        const ask = (name: string): FlowTriggerNode => ({ name, type: 'PIECE', settings: { pieceName: PIECE_ASK_NAME, actionName: 'ask', input: { prompt: name } } });
        const flow = createFlow();
        const trigger: FlowTriggerNode = { name: 'trigger', type: 'EMPTY', nextAction: { name: 'router', type: 'ROUTER', settings: {
          executionType, branches: [
            { branchType: 'CONDITION', branchName: 'Match', conditions: fixture.conditions },
            { branchType: 'FALLBACK', branchName: 'Otherwise' },
          ],
        }, children: [ask('matched'), ask('fallback')] } };
        const version = createDraftVersion({ flowId: flow.id, displayName: fixture.label, trigger });
        const req = Object.assign(new Request('http://local/run', { method: 'POST', body: JSON.stringify({ environment: 'TESTING', payload: fixture.payload }) }), { params: { id: flow.id } });
        const response = await createWorkflowRoutes()['/api/workflows/:id/run']!.POST!(req);
        expect(response.status).toBe(202);
        const { id: runId } = await response.json() as { id: string };
        const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime!) }) } });
        await worker.drain();
        const run = getFlowRun(runId)!;
        expect(run.status).toBe(fixture.expected ? 'SUCCEEDED' : 'FAILED');
        expect(llmCalls.slice(before).map(call => call.prompt)).toEqual(fixture.expected ? [fixture.expected] : []);
        if (fixture.expected) {
          // The outer worker wraps each engine StepOutput in { output }.
          const router = (run.steps!.router as { output: {
            input: { branches: Array<{ conditions: unknown[][] }> };
            output: { branches: Array<{ evaluation: boolean }> };
          } }).output;
          expect(router.input.branches[0]!.conditions.map(group => group.length)).toEqual(fixture.evaluated);
          expect(router.output.branches.map(branch => branch.evaluation)).toEqual([fixture.expected === 'matched', fixture.expected === 'fallback']);
        }
        expect(getFlowVersion(version.id)!.trigger).toEqual(trigger);
      }, 45_000);
    }
  }

  for (const executionType of ['EXECUTE_FIRST_MATCH', 'EXECUTE_ALL_MATCH'] as const) {
    for (const payload of [{}, { optional: 'approved' }]) {
      test.skipIf(skipE2eTests)(`review: router evaluates only reachable branches (${executionType}, ${JSON.stringify(payload)})`, async () => {
        const before = llmCalls.length;
        const ask = (name: string): FlowTriggerNode => ({ name, type: 'PIECE', settings: { pieceName: PIECE_ASK_NAME, actionName: 'ask', input: { prompt: name } } });
        const flow = createFlow();
        const trigger: FlowTriggerNode = { name: 'trigger', type: 'EMPTY', nextAction: { name: 'router', type: 'ROUTER', settings: {
          executionType, branches: [
            { branchType: 'CONDITION', branchName: 'Missing', conditions: [[absent]] },
            { branchType: 'CONDITION', branchName: 'Approved', conditions: [[contains]] },
            { branchType: 'FALLBACK', branchName: 'Otherwise' },
          ],
        }, children: [ask('missing'), ask('approved'), ask('fallback')] } };
        const version = createDraftVersion({ flowId: flow.id, displayName: 'Cross-branch short circuit', trigger });
        const req = Object.assign(new Request('http://local/run', { method: 'POST', body: JSON.stringify({ environment: 'TESTING', payload }) }), { params: { id: flow.id } });
        const response = await createWorkflowRoutes()['/api/workflows/:id/run']!.POST!(req);
        expect(response.status).toBe(202);
        const { id } = await response.json() as { id: string };
        const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime!) }) } });
        await worker.drain();
        const run = getFlowRun(id)!;
        const fails = executionType === 'EXECUTE_ALL_MATCH' && !('optional' in payload);
        expect(run.status).toBe(fails ? 'FAILED' : 'SUCCEEDED');
        expect(llmCalls.slice(before).map(call => call.prompt)).toEqual(fails ? [] : ['optional' in payload ? 'approved' : 'missing']);
        if (!fails && !('optional' in payload)) {
          const router: any = (run.steps!.router as any).output;
          expect(router.input.branches[1].conditions).toEqual([]);
          expect(router.output.branches.map((b: any) => b.evaluation)).toEqual([true, false, false]);
        }
        expect(getFlowVersion(version.id)!.trigger).toEqual(trigger);
      }, 45_000);
    }
  }

  for (const left of [true, false]) {
    test.skipIf(skipE2eTests)(`review: real engine joins the executed router branch (${left})`, async () => {
      const before = llmCalls.length;
      const echo = (name: string, value: unknown): FlowTriggerNode => ({ name, type: 'PIECE', settings: { pieceName: PIECE_TEST_NAME, actionName: 'echo', input: { value } } });
      const flow = createFlow();
      const trigger: FlowTriggerNode = { name: 'trigger', type: 'EMPTY', nextAction: { name: 'router', type: 'ROUTER', settings: {
        executionType: 'EXECUTE_FIRST_MATCH', branches: [
          { branchType: 'CONDITION', branchName: 'Left', conditions: [[{ operator: 'BOOLEAN_IS_TRUE', firstValue: '{{trigger.left}}' }]] },
          { branchType: 'FALLBACK', branchName: 'Right' },
        ],
      }, children: [echo('a', { out: 'left' }), echo('b', { out: 'right' })], nextAction: { name: 'joined', type: 'PIECE', settings: { pieceName: PIECE_ASK_NAME, actionName: 'ask', input: { prompt: '{{a.echo.out ?? b.echo.out}}' } } } } };
      createDraftVersion({ flowId: flow.id, displayName: 'Join', trigger });
      const req = Object.assign(new Request('http://local/run', { method: 'POST', body: JSON.stringify({ payload: { left } }) }), { params: { id: flow.id } });
      const response = await createWorkflowRoutes()['/api/workflows/:id/run']!.POST!(req);
      expect(response.status).toBe(202);
      const { id } = await response.json() as { id: string };
      const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime!) }) } });
      await worker.drain();
      const run = getFlowRun(id)!;
      expect(run.failedStep).toBeNull();
      expect(run.status).toBe('SUCCEEDED');
      expect(llmCalls.slice(before).map(call => call.prompt)).toEqual([left ? 'left' : 'right']);
    }, 30_000);
  }

  // "Starts with" has two spellings: the engine's value TEXT_START_WITH (the dashboard's) and its
  // key name TEXT_STARTS_WITH (a composed workflow's). Through readiness and the real engine, both
  // must route only a matching prefix; the key name used to match every input.
  for (const operator of ['TEXT_START_WITH', 'TEXT_STARTS_WITH'] as const) {
    for (const [from, expected] of [['billing@oak.test', 'matched'], ['ana@cedar.test', 'fallback']] as const) {
      test.skipIf(skipE2eTests)(`router: ${operator} routes only a matching prefix (${from})`, async () => {
        const before = llmCalls.length;
        const ask = (name: string): FlowTriggerNode => ({ name, type: 'PIECE', settings: { pieceName: PIECE_ASK_NAME, actionName: 'ask', input: { prompt: name } } });
        const flow = createFlow();
        const trigger: FlowTriggerNode = { name: 'trigger', type: 'EMPTY', nextAction: { name: 'router', type: 'ROUTER', settings: {
          executionType: 'EXECUTE_FIRST_MATCH', branches: [
            { branchType: 'CONDITION', branchName: 'Billing', conditions: [[{ firstValue: '{{trigger.from}}', operator, secondValue: 'billing@' }]] },
            { branchType: 'FALLBACK', branchName: 'Otherwise' },
          ],
        }, children: [ask('matched'), ask('fallback')] } };
        createDraftVersion({ flowId: flow.id, displayName: operator, trigger });
        const req = Object.assign(new Request('http://local/run', { method: 'POST', body: JSON.stringify({ environment: 'TESTING', payload: { from } }) }), { params: { id: flow.id } });
        const response = await createWorkflowRoutes()['/api/workflows/:id/run']!.POST!(req);
        expect(response.status).toBe(202);
        const { id } = await response.json() as { id: string };
        const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime!) }) } });
        await worker.drain();
        expect(getFlowRun(id)!.status).toBe('SUCCEEDED');
        expect(llmCalls.slice(before).map(call => call.prompt)).toEqual([expected]);
      }, 45_000);
    }
  }

  test.skipIf(skipE2eTests)('router: an operator the engine does not implement fails the step instead of matching', async () => {
    const before = llmCalls.length;
    const ask = (name: string): FlowTriggerNode => ({ name, type: 'PIECE', settings: { pieceName: PIECE_ASK_NAME, actionName: 'ask', input: { prompt: name } } });
    const flow = createFlow();
    // Readiness refuses this graph, so run it straight through the engine: the engine must fail closed as well.
    const version = createDraftVersion({ flowId: flow.id, displayName: 'Unknown operator', trigger: { name: 'trigger', type: 'EMPTY', nextAction: {
      name: 'router', type: 'ROUTER', settings: { executionType: 'EXECUTE_FIRST_MATCH', branches: [
        { branchType: 'CONDITION', branchName: 'Typo', conditions: [[{ firstValue: 'ana@cedar.test', operator: 'TEXT_STARTSWITH', secondValue: 'billing@' }]] },
        { branchType: 'FALLBACK', branchName: 'Otherwise' },
      ] }, children: [ask('matched'), ask('fallback')] } } });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, environment: 'TESTING' });
    const handle = await runtime!.acquire({ runId: run.id, projectId: DEFAULT_IDS.project });
    try {
      await expect(handle.executeFlow({ flowVersion: version })).rejects.toThrow('TEXT_STARTSWITH is not supported');
    } finally { await handle.release(); }
    expect(llmCalls.slice(before)).toEqual([]);
  }, 45_000);

  test.skipIf(skipE2eTests)(
    "manual trigger + echo action runs to SUCCEEDED",
    async () => {
      const flow = createFlow({ projectId: DEFAULT_IDS.project });
      const trigger: FlowTriggerNode = {
        name: "trigger",
        type: "PIECE_TRIGGER",
        displayName: "Manual",
        settings: {
          pieceName: PIECE_TEST_NAME,
          pieceVersion: PIECE_VERSION,
          triggerName: "manual",
          input: { payload: { hello: "world" } },
        },
        nextAction: {
          name: "step_1",
          type: "PIECE",
          displayName: "Echo",
          settings: {
            pieceName: PIECE_TEST_NAME,
            pieceVersion: PIECE_VERSION,
            actionName: "echo",
            input: { value: { from: "test" } },
          },
        },
      };
      const v = createDraftVersion({
        flowId: flow.id,
        displayName: "manual-echo",
        trigger,
      });
      updateDraftVersion(v.id, { trigger, valid: true });
      lockVersion(v.id);

      const run = createFlowRun({
        flowId: flow.id,
        flowVersionId: v.id,
        environment: "TESTING",
      });
      const handle = await runtime!.acquire({
        runId: run.id,
        projectId: DEFAULT_IDS.project,
      });
      let stderrBuf = "";
      handle.stderr?.on("data", (d) => { stderrBuf += d.toString(); });
      try {
        const finalRun = await handle.executeFlow({
          flowVersion: getFlowVersion(v.id)!,
        });
        if (finalRun.status !== "SUCCEEDED") {
          console.error(`[engine stderr]\n${stderrBuf.slice(0, 4000)}`);
        }
        expect(finalRun.status).toBe("SUCCEEDED");
      } finally {
        await handle.release();
      }
      const persisted = getFlowRun(run.id);
      expect(persisted?.status).toBe("SUCCEEDED");
    },
    45_000,
  );

  test.skipIf(skipE2eTests)(
    "a trigger with NO triggerName (e.g. a schedule run manually) still runs its steps, not TriggerNameNotSetError",
    async () => {
      // Regression: running a workflow MANUALLY whose trigger is not the manual
      // one (a SCHEDULE trigger came through with a nil triggerName) used to die
      // at engine start with `TriggerNameNotSetError` / "FAILED at engine, no
      // per-step trace". The engine now short-circuits executeOnStart when there
      // is no triggerName and walks straight into the action chain.
      const flow = createFlow({ projectId: DEFAULT_IDS.project });
      const trigger: FlowTriggerNode = {
        name: "trigger",
        type: "PIECE_TRIGGER",
        displayName: "Schedule",
        settings: {
          pieceName: PIECE_TEST_NAME,
          pieceVersion: PIECE_VERSION,
          // triggerName DELIBERATELY absent — the exact shape a manual run of a
          // non-manual trigger produced.
          input: {},
        },
        nextAction: {
          name: "step_1",
          type: "PIECE",
          displayName: "Echo",
          settings: {
            pieceName: PIECE_TEST_NAME,
            pieceVersion: PIECE_VERSION,
            actionName: "echo",
            input: { value: { from: "schedule-manual" } },
          },
        },
      };
      const v = createDraftVersion({
        flowId: flow.id,
        displayName: "schedule-manual-echo",
        trigger,
      });
      updateDraftVersion(v.id, { trigger, valid: true });
      lockVersion(v.id);

      const run = createFlowRun({
        flowId: flow.id,
        flowVersionId: v.id,
        environment: "TESTING",
      });
      const handle = await runtime!.acquire({
        runId: run.id,
        projectId: DEFAULT_IDS.project,
      });
      let stderrBuf = "";
      handle.stderr?.on("data", (d) => { stderrBuf += d.toString(); });
      try {
        const finalRun = await handle.executeFlow({
          flowVersion: getFlowVersion(v.id)!,
        });
        if (finalRun.status !== "SUCCEEDED") {
          console.error(`[engine stderr]\n${stderrBuf.slice(0, 4000)}`);
        }
        expect(finalRun.status).toBe("SUCCEEDED");
      } finally {
        await handle.release();
      }
      expect(getFlowRun(run.id)?.status).toBe("SUCCEEDED");
    },
    45_000,
  );

  test.skipIf(skipE2eTests)(
    "manual trigger + jarvis-ask action calls daemon's /v1/jarvis/llm/chat",
    async () => {
      llmCalls = [];
      const flow = createFlow({ projectId: DEFAULT_IDS.project });
      const trigger: FlowTriggerNode = {
        name: "trigger",
        type: "PIECE_TRIGGER",
        displayName: "Manual",
        settings: {
          pieceName: PIECE_TEST_NAME,
          pieceVersion: PIECE_VERSION,
          triggerName: "manual",
          input: { payload: {} },
        },
        nextAction: {
          name: "step_1",
          type: "PIECE",
          displayName: "Ask",
          settings: {
            pieceName: PIECE_ASK_NAME,
            pieceVersion: PIECE_VERSION,
            actionName: "ask",
            input: { prompt: "what's 2+2?" },
          },
        },
      };
      const v = createDraftVersion({
        flowId: flow.id,
        displayName: "manual-ask",
        trigger,
      });
      updateDraftVersion(v.id, { trigger, valid: true });
      lockVersion(v.id);

      const run = createFlowRun({
        flowId: flow.id,
        flowVersionId: v.id,
        environment: "TESTING",
      });
      const handle = await runtime!.acquire({
        runId: run.id,
        projectId: DEFAULT_IDS.project,
      });
      let stderrBuf = "";
      handle.stderr?.on("data", (d) => { stderrBuf += d.toString(); });
      try {
        const finalRun = await handle.executeFlow({
          flowVersion: getFlowVersion(v.id)!,
        });
        if (finalRun.status !== "SUCCEEDED") {
          console.error(`[engine stderr]\n${stderrBuf.slice(0, 4000)}`);
        }
        expect(finalRun.status).toBe("SUCCEEDED");
        expect(llmCalls.length).toBe(1);
        expect(llmCalls[0]?.prompt).toBe("what's 2+2?");
      } finally {
        await handle.release();
      }
    },
    45_000,
  );
});

describe("Engine end-to-end (G+H pieces)", () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;
  const calls: {
    tool: Array<{ toolName: string; params: Record<string, unknown> }>;
    notify: Array<{ message: string }>;
    context: Array<{ method: string }>;
    agent: Array<{ goal: string }>;
    workflows: Array<{ flowId: string }>;
  } = { tool: [], notify: [], context: [], agent: [], workflows: [] };

  const toolsInvoke: ToolsInvokeFn = async (req) => {
    calls.tool.push(req);
    return { result: { ok: true }, toolName: req.toolName };
  };
  const notify: NotifyFn = async (req) => {
    calls.notify.push({ message: req.message });
    return { delivered: ["dashboard"], failed: [] };
  };
  const contextProvider: JarvisContextProvider = {
    vaultSearch: async () => {
      calls.context.push({ method: "vaultSearch" });
      return { result: [] };
    },
    vaultGetEntity: async () => ({ result: null }),
    awarenessRecent: async () => ({ result: [] }),
    commitmentsList: async () => ({ result: [] }),
  };
  const agentDelegate: AgentDelegateFn = async (req) => {
    calls.agent.push({ goal: req.goal });
    return { finalMessage: "ok", toolCalls: [], status: "completed" };
  };
  const workflowsStart: WorkflowsStartFn = async (req) => {
    calls.workflows.push({ flowId: req.flowId });
    return { runId: "run_stub" };
  };

  beforeAll(async () => {
    initWorkflowDb(":memory:");
    api = new SandboxApi({
      services: {
        credentialResolver: new CredentialResolver(),
        toolsInvoke,
        notify,
        contextProvider,
        agentDelegate,
        workflowsStart,
      },
    });
    await api.start({ port: 0 });

    let cached = initialCached;
    if (!cached && buildOptIn) cached = await buildEngineBundle();
    if (!cached) return;
    if (buildOptIn) await buildAllJarvisPieces();
    runtime = new EngineRuntime({ api, bundlePath: cached.bundlePath });
    const metadataHandle = await runtime.acquire({ runId: 'readiness-metadata', projectId: DEFAULT_IDS.project });
    try {
      const metadata = await metadataHandle.extractPieceMetadata({ pieceName: PIECE_TEST_NAME, pieceVersion: PIECE_VERSION });
      configureWorkflowReadiness({ pieces: new PieceCatalog([metadataToCatalogEntry(metadata)]) });
    } finally { await metadataHandle.release(); }
  }, 30_000);

  afterAll(async () => {
    // Engines first: reclaim anything this runtime spawned while the
    // SandboxApi it talks to is still up (#491).
    await runtime?.shutdown();
    await api.stop();
    closeWorkflowDb();
  });

  test.skipIf(skipE2eTests)(
    "manual trigger -> tool -> notify -> context -> agent -> trigger.run_workflow chain hits every endpoint",
    async () => {
      // Reset trackers in case the suite is rerun.
      calls.tool.length = 0;
      calls.notify.length = 0;
      calls.context.length = 0;
      calls.agent.length = 0;
      calls.workflows.length = 0;

      const flow = createFlow({ projectId: DEFAULT_IDS.project });
      const trigger: FlowTriggerNode = {
        name: "trigger",
        type: "PIECE_TRIGGER",
        displayName: "Manual",
        settings: {
          pieceName: PIECE_TEST_NAME,
          pieceVersion: PIECE_VERSION,
          triggerName: "manual",
          input: { payload: {} },
        },
        nextAction: {
          name: "step_tool",
          type: "PIECE",
          displayName: "Tool",
          settings: {
            pieceName: PIECE_TOOL_NAME,
            pieceVersion: PIECE_VERSION,
            actionName: "invoke",
            input: { toolName: "vault_search", params: { query: "alice" } },
          },
          nextAction: {
            name: "step_notify",
            type: "PIECE",
            displayName: "Notify",
            settings: {
              pieceName: PIECE_NOTIFY_NAME,
              pieceVersion: PIECE_VERSION,
              actionName: "notify",
              input: { message: "hello", channels: ["dashboard"], priority: "normal" },
            },
            nextAction: {
              name: "step_context",
              type: "PIECE",
              displayName: "Context",
              settings: {
                pieceName: PIECE_CONTEXT_NAME,
                pieceVersion: PIECE_VERSION,
                actionName: "vault_search",
                input: { query: "alice" },
              },
              nextAction: {
                name: "step_agent",
                type: "PIECE",
                displayName: "Agent",
                settings: {
                  pieceName: PIECE_AGENT_NAME,
                  pieceVersion: PIECE_VERSION,
                  actionName: "delegate",
                  input: { goal: "say hi" },
                },
                nextAction: {
                  name: "step_runwf",
                  type: "PIECE",
                  displayName: "RunWF",
                  settings: {
                    pieceName: PIECE_TRIGGER_NAME,
                    pieceVersion: PIECE_VERSION,
                    actionName: "run_workflow",
                    input: { flow: "flow_other", payload: {} },
                  },
                },
              },
            },
          },
        },
      };
      const v = createDraftVersion({
        flowId: flow.id,
        displayName: "G-H-chain",
        trigger,
      });
      updateDraftVersion(v.id, { trigger, valid: true });
      lockVersion(v.id);

      const run = createFlowRun({
        flowId: flow.id,
        flowVersionId: v.id,
        environment: "TESTING",
      });
      const handle = await runtime!.acquire({
        runId: run.id,
        projectId: DEFAULT_IDS.project,
      });
      let stderrBuf = "";
      handle.stderr?.on("data", (d) => { stderrBuf += d.toString(); });
      try {
        const finalRun = await handle.executeFlow({
          flowVersion: getFlowVersion(v.id)!,
        });
        if (finalRun.status !== "SUCCEEDED") {
          console.error(`[engine stderr]\n${stderrBuf.slice(0, 4000)}`);
        }
        expect(finalRun.status).toBe("SUCCEEDED");
      } finally {
        await handle.release();
      }
      expect(calls.tool.length).toBe(1);
      expect(calls.tool[0]?.toolName).toBe("vault_search");
      expect(calls.notify.length).toBe(1);
      expect(calls.notify[0]?.message).toBe("hello");
      expect(calls.context.length).toBe(1);
      expect(calls.context[0]?.method).toBe("vaultSearch");
      expect(calls.agent.length).toBe(1);
      expect(calls.agent[0]?.goal).toBe("say hi");
      expect(calls.workflows.length).toBe(1);
      expect(calls.workflows[0]?.flowId).toBe("flow_other");
    },
    60_000,
  );

  /**
   * The CODE-step gate against the real engine (#467 item 3).
   *
   * Two halves that only mean something together: publish REFUSES the flow
   * while the per-flow opt-in is missing, and the exact same flow runs a real
   * CODE step to SUCCEEDED once the opt-in is there. That is also the proof
   * behind grandfathering -- the upgrade writes this grant onto a flow that was
   * already running a CODE step, and this is what having the grant buys.
   */
  test.skipIf(skipE2eTests)(
    "a CODE step is refused at publish without the per-flow opt-in, and runs once it has it",
    async () => {
      // The CODE step writes to an absolute path outside the flow's world.
      // That is the privilege the gate exists for -- a child process, not an
      // isolate -- and it doubles as the only out-of-band proof available
      // here that the step really executed: `executeFlow` leaves
      // `flow_run.steps` null (the worker handler is what accumulates step
      // outputs), so a SUCCEEDED status alone could not tell a step that ran
      // from a step that was skipped.
      const probeDir = mkdtempSync(join(tmpdir(), "jarvis-code-gate-"));
      const probe = join(probeDir, "doubled.txt");
      const flow = createFlow({ projectId: DEFAULT_IDS.project });
      const trigger: FlowTriggerNode = {
        name: "trigger",
        type: "PIECE_TRIGGER",
        displayName: "Manual",
        settings: {
          pieceName: PIECE_TEST_NAME,
          pieceVersion: PIECE_VERSION,
          triggerName: "manual",
          input: { payload: { n: 21 } },
        },
        nextAction: {
          name: "loop_1",
          type: "LOOP_ON_ITEMS",
          displayName: "Once",
          settings: { items: "{{ [1] }}" },
          // Inside a LOOP body, so this also exercises the nested case against
          // the real executor rather than only against the scanner.
          firstLoopAction: {
            name: "double_it",
            type: "CODE",
            displayName: "Double it",
            settings: {
              input: { n: 21 },
              sourceCode: {
                packageJson: "{}",
                code:
                  "exports.code = async (inputs) => {" +
                  `  require('node:fs').writeFileSync(${JSON.stringify(probe)}, String(Number(inputs.n) * 2));` +
                  "  return { doubled: Number(inputs.n) * 2 };" +
                  "};",
              },
            },
          },
        },
      };
      const v = createDraftVersion({ flowId: flow.id, displayName: "code-gate", trigger });
      updateDraftVersion(v.id, { trigger, valid: true });

      // Refused while the flow has no opt-in, and nothing is committed.
      expect(() => publishFlowVersion(flow.id)).toThrow("Enable code steps for this flow to publish");
      expect(getFlowVersion(v.id)!.state).toBe("DRAFT");

      setFlowCodeStepsEnabled(flow.id, true);
      const published = publishFlowVersion(flow.id);
      expect(published.version.state).toBe("LOCKED");

      const run = createFlowRun({
        flowId: flow.id,
        flowVersionId: published.version.id,
        environment: "TESTING",
      });
      const handle = await runtime!.acquire({ runId: run.id, projectId: DEFAULT_IDS.project });
      let stderrBuf = "";
      handle.stderr?.on("data", (d) => { stderrBuf += d.toString(); });
      try {
        const finalRun = await handle.executeFlow({ flowVersion: getFlowVersion(published.version.id)! });
        if (finalRun.status !== "SUCCEEDED") {
          console.error(`[engine stderr]\n${stderrBuf.slice(0, 4000)}`);
        }
        expect(finalRun.status).toBe("SUCCEEDED");
        // SUCCEEDED on its own would also pass if the engine had skipped the
        // CODE step inside the loop body, so read the probe the step wrote.
        expect(readFileSync(probe, "utf8")).toBe("42");
      } finally {
        await handle.release();
        rmSync(probeDir, { recursive: true, force: true });
      }
      expect(getFlowRun(run.id)?.status).toBe("SUCCEEDED");
    },
    60_000,
  );

  /**
   * #512 against the real engine: the CODE step's process gets the sanitized
   * env, not the engine's. The engine's env carries SANDBOX_ID (the worker
   * RPC's engine identifier), the WS port and the reaper markers; before the
   * fix every CODE step inherited all of them. The unit-level probe in
   * src/spawn-env-sites.test.ts covers the call site; this covers the
   * BUNDLE, i.e. that the patched sandbox is what actually ships.
   */
  test.skipIf(skipE2eTests)(
    "a CODE step does not inherit the engine's environment",
    async () => {
      const { isAllowedEnvName } = await import("../../../util/subprocess-env");
      const probeDir = mkdtempSync(join(tmpdir(), "jarvis-code-env-"));
      try {
        await runCodeEnvProbe(probeDir, isAllowedEnvName);
      } finally {
        rmSync(probeDir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  async function runCodeEnvProbe(probeDir: string, isAllowedEnvName: (n: string) => boolean): Promise<void> {
    const probe = join(probeDir, "env.json");
    const flow = createFlow({ projectId: DEFAULT_IDS.project });
    const trigger: FlowTriggerNode = {
      name: "trigger",
      type: "PIECE_TRIGGER",
      displayName: "Manual",
      settings: {
        pieceName: PIECE_TEST_NAME,
        pieceVersion: PIECE_VERSION,
        triggerName: "manual",
        input: { payload: {} },
      },
      nextAction: {
        name: "dump_env",
        type: "CODE",
        displayName: "Dump env",
        settings: {
          input: {},
          sourceCode: {
            packageJson: "{}",
            code:
              "exports.code = async () => {" +
              `  require('node:fs').writeFileSync(${JSON.stringify(probe)}, JSON.stringify(Object.keys(process.env)));` +
              "  return {};" +
              "};",
          },
        },
      },
    };
    const v = createDraftVersion({ flowId: flow.id, displayName: "code-env", trigger });
    updateDraftVersion(v.id, { trigger, valid: true });
    setFlowCodeStepsEnabled(flow.id, true);
    const published = publishFlowVersion(flow.id);
    const run = createFlowRun({
      flowId: flow.id,
      flowVersionId: published.version.id,
      environment: "TESTING",
    });
    const handle = await runtime!.acquire({ runId: run.id, projectId: DEFAULT_IDS.project });
    let stderrBuf = "";
    handle.stderr?.on("data", (d) => { stderrBuf += d.toString(); });
    try {
      const finalRun = await handle.executeFlow({ flowVersion: getFlowVersion(published.version.id)! });
      if (finalRun.status !== "SUCCEEDED") {
        console.error(`[engine stderr]\n${stderrBuf.slice(0, 4000)}`);
      }
      expect(finalRun.status).toBe("SUCCEEDED");
      const names = JSON.parse(readFileSync(probe, "utf8")) as string[];
      // Names only: nothing the engine holds is worth printing.
      expect(names.filter((n) => !isAllowedEnvName(n))).toEqual([]);
      expect(names).toContain("PATH");
    } finally {
      await handle.release();
    }
  }
});
