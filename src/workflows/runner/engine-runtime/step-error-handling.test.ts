/** Step "Continue on failure" and "Retry on failure" through the real engine and worker. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { configureWorkflowReadiness } from '../../db/repos/flow-readiness';
import { PieceCatalog, metadataToCatalogEntry } from '../../runtime/piece-catalog';
import { DEFAULT_IDS } from '../../db/schema';
import { closeWorkflowDb, initWorkflowDb } from '../../db';
import { createFlow } from '../../db/repos/flow';
import { createDraftVersion } from '../../db/repos/flow-version';
import type { FlowTriggerNode } from '../../db/repos/flow-version';
import { getFlowRun } from '../../db/repos/flow-run';
import { CredentialResolver } from '../../credentials/adapter';
import { SandboxApi } from '../../sandbox-api/server';
import type { LlmChatFn } from '../../sandbox-api/routes/jarvis-llm';
import { findCachedBundle, buildEngineBundle, ENGINE_BUILD_PATHS } from './build';
import { buildAllJarvisPieces } from './build-pieces';
import { EngineRuntime } from './engine-runtime';
import { EngineFlowExecutor } from './engine-flow-executor';
import { Worker } from '../../queue/worker';
import { createRunFlowHandler } from '../handler';
import { createWorkflowRoutes } from '../../api/routes';
import { continuedFailures } from '../../runtime/continued-failures';

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === '1';
const initialCached = findCachedBundle();
const piecesBuilt = existsSync(resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/jarvis/test/dist/src/index.js'));
const skip = (initialCached === null && !buildOptIn) || (!piecesBuilt && !buildOptIn);
const ASK = '@jarvispieces/piece-jarvis-ask';
const VERSION = '0.0.1';

describe('step error handling options in the engine', () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;
  const prompts: string[] = [];
  const llmChat: LlmChatFn = async (req) => { prompts.push(req.prompt); return { text: 'ok' }; };

  beforeAll(async () => {
    initWorkflowDb(':memory:');
    api = new SandboxApi({ services: { credentialResolver: new CredentialResolver(), llmChat,
      // Refuses one step by name, as Authority does for a denied or stopped dispatch; admits the rest.
      pieceAuthorize: async (_request, context) => {
        if (context.stepName === 'refused') throw new Error('Jarvis refused this step');
        return { governed: false };
      } } });
    await api.start({ port: 0 });
    let cached = initialCached;
    if (!cached && buildOptIn) cached = await buildEngineBundle();
    if (!cached) return;
    if (buildOptIn) await buildAllJarvisPieces();
    runtime = new EngineRuntime({ api, bundlePath: cached.bundlePath, expectedDigest: cached.digest });
    const handle = await runtime.acquire({ runId: 'readiness-metadata', projectId: DEFAULT_IDS.project });
    try {
      configureWorkflowReadiness({ pieces: new PieceCatalog([metadataToCatalogEntry(await handle.extractPieceMetadata({ pieceName: ASK, pieceVersion: VERSION }))]) });
    } finally { await handle.release(); }
  }, 60_000);
  afterAll(async () => { await runtime?.shutdown(); await api.stop(); closeWorkflowDb(); });

  const ask = (name: string, prompt: string, extra: Record<string, unknown> = {}, next?: FlowTriggerNode): FlowTriggerNode =>
    ({ name, type: 'PIECE', settings: { pieceName: ASK, pieceVersion: VERSION, actionName: 'ask', input: { prompt }, ...extra }, ...(next ? { nextAction: next } : {}) });

  async function run(first: FlowTriggerNode) {
    const flow = createFlow();
    createDraftVersion({ flowId: flow.id, displayName: 'Error options', trigger: { name: 'trigger', type: 'EMPTY', nextAction: first } });
    const req = Object.assign(new Request('http://local/run', { method: 'POST', body: JSON.stringify({ environment: 'TESTING', payload: {} }) }), { params: { id: flow.id } });
    const response = await createWorkflowRoutes()['/api/workflows/:id/run']!.POST!(req);
    if (response.status !== 202) throw new Error(await response.text());
    const { id } = await response.json() as { id: string };
    await new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime!) }) } }).drain();
    return getFlowRun(id)!;
  }

  const continueOn = { errorHandlingOptions: { continueOnFailure: { value: true } } };

  test.skipIf(skip)('continue on failure: the next step runs, the failed step stays failed and the run is not a clean success', async () => {
    const before = prompts.length;
    const r = await run(ask('bad', '{{trigger.missing}}', continueOn, ask('after', 'ran')));
    expect(prompts.slice(before)).toEqual(['ran']);
    expect(r.status).toBe('SUCCEEDED');
    expect((r.steps as Record<string, { output: { status: string } }>).bad!.output.status).toBe('FAILED');
    expect((r.steps as Record<string, { output: { status: string } }>).after!.output.status).toBe('SUCCEEDED');
    expect(continuedFailures(r).map(step => step.name)).toEqual(['bad']);
  }, 60_000);

  test.skipIf(skip)('without the option a failed step still ends the run before the next step', async () => {
    const before = prompts.length;
    const r = await run(ask('bad', '{{trigger.missing}}', {}, ask('after', 'ran')));
    expect(prompts.slice(before)).toEqual([]);
    expect(r.status).toBe('FAILED');
    expect(continuedFailures(r)).toEqual([]);
  }, 60_000);

  test.skipIf(skip)('continue on failure never continues past a step Jarvis refused to run', async () => {
    const before = prompts.length;
    const r = await run(ask('refused', 'hello', continueOn, ask('after', 'ran')));
    expect(prompts.slice(before)).toEqual([]);
    expect(r.status).toBe('FAILED');
    expect(r.failedStep?.name).toBe('refused');
  }, 60_000);
});
