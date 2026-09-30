/** API save -> unmodified engine lookup -> installed native piece -> local provider. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createWorkflowRoutes } from "../../api/routes";
import { configureWorkflowReadiness } from '../../db/repos/flow-readiness';
import { metadataToCatalogEntry, PieceCatalog } from '../../runtime/piece-catalog';
import { Worker } from '../../queue/worker';
import { createRunFlowHandler } from '../handler';
import { TriggerManager } from '../triggers/manager';
import { WorkflowEventBus } from '../../runtime/event-bus';
import { getFlow } from '../../db/repos/flow';
import { EngineFlowExecutor } from './engine-flow-executor';
import { CredentialResolver } from "../../credentials/adapter";
import { closeWorkflowDb, DEFAULT_IDS, initWorkflowDb } from "../../db";
import { setEncryptionKey } from "../../db/encryption";
import { createFlow } from "../../db/repos/flow";
import { createFlowRun, getFlowRun } from "../../db/repos/flow-run";
import { createDraftVersion, getFlowVersion, lockVersion, updateDraftVersion, type FlowTriggerNode } from "../../db/repos/flow-version";
import { workflowLogsBase } from "../../sandbox-api/config";
import { SandboxApi } from "../../sandbox-api/server";
import { buildEngineBundle, ENGINE_BUILD_PATHS, findCachedBundle } from "./build";
import { buildPiece } from "./build-pieces";
import { EngineRuntime } from "./engine-runtime";
import { toUpstreamFlowVersion } from "./flow-version-adapter";

const PIECE = "@activepieces/piece-native-lookup-fixture";
const SCHEDULE = '@activepieces/piece-schedule';
const TOKEN = "synthetic-native-engine-token";
const cached = findCachedBundle();
const skip = process.env.JARVIS_TEST_ENGINE_BUILD !== "1" && (!cached
  || !existsSync(join(ENGINE_BUILD_PATHS.STAGING_DIR, "node_modules/esbuild")));

// Bundled with the real framework and loaded by the engine's installed-piece
// loader. Neither credential lookup nor the action executor is mocked.
const fixtureSource = `
import { createAction, createPiece, createTrigger, TriggerStrategy, PieceAuth, Property } from "@activepieces/pieces-framework";
const auth = PieceAuth.OAuth2({
  description: "Local fixture only", required: true, scope: [],
  authUrl: "http://127.0.0.1/unused", tokenUrl: "http://127.0.0.1/unused",
});
const check = createAction({
  name: "check", displayName: "Check local provider", description: "Fixture", auth,
  props: { endpoint: Property.ShortText({ displayName: "Endpoint", required: true }) },
  async run(context) {
    const response = await fetch(context.propsValue.endpoint, {
      headers: { Authorization: "Bearer " + context.auth.access_token },
    });
    if (!response.ok) throw new Error("Local provider rejected credentials");
    return response.json();
  },
});
const endpoint = Property.ShortText({ displayName: 'Endpoint', required: true });
async function send(context) {
  const response = await fetch(context.propsValue.endpoint, {
    method: 'POST', headers: { Authorization: 'Bearer ' + context.auth.access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify(context.propsValue),
  });
  if (!response.ok) throw new Error('Local provider rejected payload');
  return response.json();
}
const collections = createAction({
  name: 'collections', displayName: 'Collections', description: '', auth,
  props: { endpoint, rows: Property.Array({ displayName: 'Rows', required: true }), document: Property.Json({ displayName: 'Document', required: true }) },
  run: send,
});
const rows = createAction({
  name: 'rows', displayName: 'Rows', description: '', auth,
  props: { endpoint, rows: Property.Array({ displayName: 'Rows', required: true, properties: {
    recipient: Property.ShortText({ displayName: 'Recipient', required: true }),
    count: Property.Number({ displayName: 'Count', required: true }),
  } }) },
  run: send,
});
const form = createAction({
  name: 'form', displayName: 'Form', description: '', auth,
  props: { endpoint, form: Property.DynamicProperties({ displayName: 'Form', required: true, auth,
    refreshers: [], props: async () => ({ recipient: Property.ShortText({ displayName: 'Recipient', required: true }), count: Property.Number({ displayName: 'Count', required: true }) }),
  }) },
  run: send,
});
const formTrigger = createTrigger({
  name: 'form_trigger', displayName: 'Form trigger', description: '', auth,
  type: TriggerStrategy.POLLING, sampleData: {}, props: form.props,
  async onEnable() {}, async onDisable() {},
  async run(context) { return [await send(context)]; },
});
export const nativeLookupFixture = createPiece({
  displayName: "Native lookup fixture", description: "Local tests only", auth,
  minimumSupportedRelease: "0.82.0", logoUrl: "", authors: [], actions: [check, collections, rows, form], triggers: [formTrigger],
});
`;

describe("native credential engine integration", () => {
  let dir: string;
  let api: SandboxApi | undefined;
  let runtime: EngineRuntime | undefined;
  let provider: ReturnType<typeof Bun.serve> | undefined;
  const requests: string[] = [];
  const effects: Array<Record<string, unknown>> = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    if (skip) return;
    dir = mkdtempSync(join(tmpdir(), "jarvis-native-engine-"));
    initWorkflowDb(join(dir, "jarvis.db"));
    setEncryptionKey(Buffer.alloc(32, 19));
    const pieceDir = join(dir, "fixture");
    mkdirSync(join(pieceDir, "src"), { recursive: true });
    writeFileSync(join(pieceDir, "package.json"), JSON.stringify({ name: PIECE, version: "0.0.1" }));
    writeFileSync(join(pieceDir, "src/index.ts"), fixtureSource);
    await buildPiece(pieceDir);
    const installed = join(dir, "node_modules", PIECE);
    mkdirSync(dirname(installed), { recursive: true });
    symlinkSync(join(pieceDir, "dist"), installed, "dir");
    const scheduleDir = join(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/core/schedule');
    await buildPiece(scheduleDir);
    const scheduleInstalled = join(dir, 'node_modules', SCHEDULE);
    mkdirSync(dirname(scheduleInstalled), { recursive: true });
    symlinkSync(join(scheduleDir, 'dist'), scheduleInstalled, 'dir');
    const resolver = new CredentialResolver();
    resolver.register({ id: "fixture", canResolve: id => id === "jarvis:fixture",
      resolve: async () => ({ type: "OAUTH2", value: { access_token: TOKEN } }) });
    api = new SandboxApi({ services: { credentialResolver: resolver } });
    await api.start({ port: 0 });
    runtime = new EngineRuntime({ api, bundlePath: (cached ?? await buildEngineBundle()).bundlePath,
      cwd: dir, customPiecesPaths: [dir], devPieces: [], baseCodeDir: join(dir, "code") });
    provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const auth = req.headers.get("authorization") ?? "";
      requests.push(auth);
      if (req.method === "POST") effects.push(await req.json() as Record<string, unknown>);
      return Response.json({ accepted: auth === "Bearer " + TOKEN }, { status: auth === "Bearer " + TOKEN ? 200 : 401 });
    } });
    const handle = await runtime.acquire({ runId: 'fixture-metadata', projectId: DEFAULT_IDS.project });
    try {
      const metadata = await handle.extractPieceMetadata({ pieceName: PIECE, pieceVersion: '0.0.1' });
      const schedule = await handle.extractPieceMetadata({ pieceName: SCHEDULE, pieceVersion: '0.0.1' });
      configureWorkflowReadiness({ pieces: new PieceCatalog([metadataToCatalogEntry(metadata), metadataToCatalogEntry(schedule)]), credentials: resolver });
    } finally { await handle.release(); }
  }, 120_000);

  afterAll(async () => {
    await runtime?.shutdown();
    await api?.stop();
    provider?.stop(true);
    closeWorkflowDb();
    setEncryptionKey(null);
    for (const runId of runIds) rmSync(join(workflowLogsBase(), runId + ".bin"), { force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function save(externalId: string, pieceName = PIECE) {
    const response = await createWorkflowRoutes()["/api/workflows/connections"]!.POST!(new Request("http://localhost/api/workflows/connections", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalId, pieceName, pieceVersion: "0.0.1", displayName: "Fixture",
        type: "OAUTH2", value: { access_token: TOKEN, token_type: "Bearer" } }),
    }));
    expect(response.status).toBe(201);
  }

  async function execute(externalId: string) {
    const flow = createFlow();
    const trigger: FlowTriggerNode = { name: "trigger", type: "EMPTY", settings: {}, nextAction: {
      name: "check", type: "PIECE", settings: { pieceName: PIECE, pieceVersion: "0.0.1", actionName: "check",
        input: { auth: "{{connections['" + externalId + "']}}", endpoint: `http://127.0.0.1:${provider!.port}/check` } },
    } };
    const version = createDraftVersion({ flowId: flow.id, displayName: "Native connection", trigger });
    updateDraftVersion(version.id, { trigger, valid: true });
    lockVersion(version.id);
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, environment: "TESTING" });
    runIds.push(run.id);
    const handle = await runtime!.acquire({ runId: run.id, projectId: DEFAULT_IDS.project });
    try {
      const result = await handle.executeFlow({ flowVersion: getFlowVersion(version.id)!, timeoutInSeconds: 15 });
      expect(getFlowRun(run.id)?.status).toBe(result.status);
      return result;
    } finally { await handle.release(); }
  }

  test.skipIf(skip)("an API-saved native connection reaches the local provider through the real engine", async () => {
    await save("native-provider");
    const count = requests.length;
    expect((await execute("native-provider")).status).toBe("SUCCEEDED");
    expect(requests.slice(count)).toEqual(["Bearer " + TOKEN]);
  }, 45_000);

  test.skipIf(skip)("duplicate native IDs stop the engine before the provider is called", async () => {
    await save("ambiguous", PIECE);
    await save("ambiguous", "other-piece");
    const count = requests.length;
    expect((await execute("ambiguous")).status).toBe("FAILED");
    expect(requests.length).toBe(count);
  }, 45_000);

  test.skipIf(skip)("managed sources still reach the provider through the same engine request", async () => {
    const count = requests.length;
    expect((await execute("jarvis:fixture")).status).toBe("SUCCEEDED");
    expect(requests.slice(count)).toEqual(["Bearer " + TOKEN]);
  }, 45_000);

  async function runThroughWorker(actionName: string, input: Record<string, unknown>, payload: Record<string, unknown> = {}, propertySettings = {}) {
    const flow = createFlow();
    createDraftVersion({ flowId: flow.id, displayName: 'Readiness fixture', trigger: {
      name: 'trigger', type: 'EMPTY', nextAction: { name: 'action', type: 'PIECE', settings: {
        pieceName: PIECE, actionName, propertySettings,
        input: { auth: "{{connections['jarvis:fixture']}}", endpoint: `http://127.0.0.1:${provider!.port}/check`, ...input },
      } },
    } });
    const req = Object.assign(new Request('http://local/run', { method: 'POST', body: JSON.stringify({ environment: 'TESTING', payload }) }), { params: { id: flow.id } });
    const response = await createWorkflowRoutes()['/api/workflows/:id/run']!.POST!(req);
    expect(response.status).toBe(202);
    const run = await response.json() as { id: string };
    runIds.push(run.id);
    const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime!) }) } });
    await worker.drain();
    return getFlowRun(run.id)!;
  }

  for (const dynamic of [false, true]) {
    test.skipIf(skip)(`R5: required empty collections reach the native action (${dynamic ? 'resolved' : 'literal'})`, async () => {
      const before = effects.length;
      const input = dynamic ? { rows: '{{trigger.rows}}', document: '{{trigger.document}}' } : { rows: [], document: [] };
      const run = await runThroughWorker('collections', input, { rows: [], document: [] });
      expect(run.status).toBe('SUCCEEDED');
      expect(effects.slice(before)).toEqual([expect.objectContaining({ rows: [], document: [] })]);
    }, 45_000);
  }

  for (const [label, value, allowed] of [
    ['missing field', {}, false],
    ['wrong type', { recipient: 'owner@example.test', count: 'wrong' }, false],
    ['valid values', { recipient: 'owner@example.test', count: '2' }, true],
  ] as const) {
    test.skipIf(skip)(`R6: supplied dynamic schema is enforced before the native action (${label})`, async () => {
      const before = effects.length;
      const schema = { recipient: { type: 'SHORT_TEXT', required: true }, count: { type: 'NUMBER', required: true } };
      const run = await runThroughWorker('form', { form: '{{trigger.form}}' }, { form: value }, { form: { schema } });
      expect(run.status).toBe(allowed ? 'SUCCEEDED' : 'FAILED');
      expect(effects.length - before).toBe(allowed ? 1 : 0);
      if (allowed) expect(effects[before]!.form).toEqual({ recipient: 'owner@example.test', count: 2 });
      else expect(run.failedStep?.errorMessage).toContain(label === 'missing field' ? 'recipient' : 'count');
    }, 45_000);
  }

  for (const [label, value, propertySettings, allowed] of [
    ['missing schema', {}, {}, false],
    ['invalid shape', 42, { form: { schema: {} } }, false],
    ['missing field', {}, { form: { schema: { count: { type: 'NUMBER', required: true } } } }, false],
    ['valid values', { count: '2' }, { form: { schema: { count: { type: 'NUMBER', required: true } } } }, true],
  ] as const) {
    test.skipIf(skip)(`R6: trigger hooks enforce their saved dynamic schema (${label})`, async () => {
      const before = effects.length;
      const flow = createFlow();
      const version = createDraftVersion({ flowId: flow.id, displayName: 'Dynamic trigger', trigger: {
        name: 'trigger', type: 'PIECE_TRIGGER', settings: {
          pieceName: PIECE, pieceVersion: '0.0.1', triggerName: 'form_trigger', propertySettings,
          input: { auth: "{{connections['jarvis:fixture']}}", endpoint: `http://127.0.0.1:${provider!.port}/check`, form: value },
        },
      } });
      const handle = await runtime!.acquire({ runId: version.id, projectId: DEFAULT_IDS.project });
      try {
        const execution = handle.executeTriggerHook('RUN', { flowVersion: toUpstreamFlowVersion(version), timeoutInSeconds: 15 });
        if (allowed) {
          await execution;
          expect(effects.slice(before)).toEqual([expect.objectContaining({ form: { count: 2 } })]);
        } else {
          await expect(execution).rejects.toThrow(label === 'missing schema' ? 'schema' : label === 'invalid shape' ? 'object' : 'count');
          expect(effects.length).toBe(before);
        }
      } finally { await handle.release(); }
    }, 45_000);
  }

  test.skipIf(skip)('R5: processing cannot turn a missing required row collection into a valid empty list', async () => {
    const before = effects.length;
    const schema = { rows: { type: 'ARRAY', required: true, properties: { count: { type: 'NUMBER', required: true } } } };
    const run = await runThroughWorker('form', { form: '{{trigger.form}}' }, { form: { rows: null } }, { form: { schema } });
    expect(run.status).toBe('FAILED');
    expect(effects.length).toBe(before);
    expect(run.failedStep?.errorMessage).toContain('rows');
  }, 45_000);


  for (const expression of ['0 9 * * 7', '0 9 * * 1-7/2', '@every 10s', '61 * * * *', '@every 0s']) {
    test.skipIf(skip)(`review R1: native schedule publication and real ON_ENABLE agree (${expression})`, async () => {
      const flow = createFlow();
      const version = createDraftVersion({ flowId: flow.id, displayName: 'Native schedule', trigger: {
        name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: SCHEDULE, triggerName: 'cron_expression', input: { cronExpression: expression, timezone: 'UTC' } },
      } });
      const req = Object.assign(new Request('http://local/publish', { method: 'POST', body: '{}' }), { params: { id: flow.id } });
      const response = await createWorkflowRoutes()['/api/workflows/:id/publish']!.POST!(req);
      const valid = !['61 * * * *', '@every 0s'].includes(expression);
      expect(response.status).toBe(valid ? 200 : 422);
      if (!valid) {
        expect(getFlow(flow.id)!.status).toBe('DISABLED');
        expect(getFlowVersion(version.id)!.state).toBe('DRAFT');
        // Also verify the engine boundary for legacy/direct hook callers.
        const handle = await runtime!.acquire({ runId: version.id, projectId: DEFAULT_IDS.project });
        try { await expect(handle.executeTriggerHook('ON_ENABLE', { flowVersion: toUpstreamFlowVersion(version) })).rejects.toThrow(); }
        finally { await handle.release(); }
        return;
      }
      const scheduled: string[] = [];
      const manager = new TriggerManager({ eventBus: new WorkflowEventBus(), engineRuntime: runtime!, log: () => {}, enableRetryDelaysMs: [],
        cronScheduler: { schedule: (_id: string, expression: string) => scheduled.push(expression), cancel: () => {}, cancelAll: () => {} } as any });
      try {
        await manager.refresh(flow.id);
        expect(manager.list()).toEqual([{ flowId: flow.id, kind: 'engine' }]);
        expect(scheduled).toEqual([expression]);
        expect(getFlowVersion(version.id)!.engineSchedule?.cronExpression).toBe(expression);
      } finally { await manager.stop(); }
    }, 45_000);
  }


  test.skipIf(skip)('review R3: extracted ordinary row contracts block invalid publication before provider work', async () => {
    const before = effects.length;
    for (const rows of [[{}], [{ recipient: 'owner', count: 'wrong' }]]) {
      const flow = createFlow();
      const version = createDraftVersion({ flowId: flow.id, displayName: 'Known rows', trigger: {
        name: 'trigger', type: 'EMPTY', nextAction: { name: 'rows', type: 'PIECE', settings: {
          pieceName: PIECE, actionName: 'rows', input: { auth: "{{connections['jarvis:fixture']}}", endpoint: `http://127.0.0.1:${provider!.port}/check`, rows },
        } },
      } });
      const req = Object.assign(new Request('http://local/publish', { method: 'POST', body: '{}' }), { params: { id: flow.id } });
      const response = await createWorkflowRoutes()['/api/workflows/:id/publish']!.POST!(req);
      expect(response.status).toBe(422);
      expect((await response.json()).issues).toContainEqual(expect.objectContaining({ node: 'rows', code: 'INPUT_TYPE', path: expect.stringContaining('settings.input.rows.0.') }));
      expect(getFlowVersion(version.id)!.state).toBe('DRAFT');
    }
    expect(effects.length).toBe(before);
    for (const rows of [[], [{ recipient: 'owner', count: '2' }], { recipient: ['{{trigger.recipient}}'], count: ['{{trigger.count}}'] }]) {
      const run = await runThroughWorker('rows', { rows }, { recipient: 'owner', count: 2 });
      expect(run.status).toBe('SUCCEEDED');
    }
    expect(effects.length - before).toBe(3);
    expect(effects.slice(before).map(effect => effect.rows)).toEqual([[], [{ recipient: 'owner', count: 2 }], [{ recipient: 'owner', count: 2 }]]);
    const invalid = await runThroughWorker('rows', { rows: [{ recipient: '{{trigger.recipient}}', count: '{{trigger.count}}' }] }, { recipient: 'owner', count: 'bad' });
    expect(invalid.status).toBe('FAILED');
    expect(effects.length - before).toBe(3);
  }, 45_000);

});
