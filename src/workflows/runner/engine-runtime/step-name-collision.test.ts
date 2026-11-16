/**
 * A step named like an Object.prototype member (`toString`, `valueOf`, ...)
 * keeps its output, and later steps can read it.
 *
 * Needs the engine bundle and built pieces; skips without them, and CI builds
 * them (`JARVIS_TEST_ENGINE_BUILD=1`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { configureWorkflowReadiness } from '../../db/repos/flow-readiness';
import { PieceCatalog, metadataToCatalogEntry } from '../../runtime/piece-catalog';
import { closeWorkflowDb, initWorkflowDb } from '../../db';
import { createFlow } from '../../db/repos/flow';
import { createDraftVersion } from '../../db/repos/flow-version';
import type { FlowTriggerNode } from '../../db/repos/flow-version';
import { getFlowRun } from '../../db/repos/flow-run';
import { DEFAULT_IDS } from '../../db/schema';
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

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === '1';
const initialCached = findCachedBundle();
const piecesBuilt = existsSync(resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, 'pieces/jarvis/test/dist/src/index.js'));
const skip = (initialCached === null && !buildOptIn) || (!piecesBuilt && !buildOptIn);
const PIECE_ASK_NAME = '@jarvispieces/piece-jarvis-ask';
const PIECE_VERSION = '0.0.1';

describe('step names that Object.prototype also uses', () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;
  const prompts: string[] = [];
  const llmChat: LlmChatFn = async (req) => { prompts.push(req.prompt); return { text: `reply to ${req.prompt}` }; };

  beforeAll(async () => {
    initWorkflowDb(':memory:');
    api = new SandboxApi({ services: { credentialResolver: new CredentialResolver(), llmChat } });
    await api.start({ port: 0 });
    let cached = initialCached;
    if (!cached && buildOptIn) cached = await buildEngineBundle();
    if (!cached) return;
    if (buildOptIn) await buildAllJarvisPieces();
    runtime = new EngineRuntime({ api, bundlePath: cached.bundlePath, expectedDigest: cached.digest });
    const handle = await runtime.acquire({ runId: 'readiness-metadata', projectId: DEFAULT_IDS.project });
    try {
      const metadata = await handle.extractPieceMetadata({ pieceName: PIECE_ASK_NAME, pieceVersion: PIECE_VERSION });
      configureWorkflowReadiness({ pieces: new PieceCatalog([metadataToCatalogEntry(metadata)]) });
    } finally { await handle.release(); }
  }, 60_000);

  afterAll(async () => { await runtime?.shutdown(); await api.stop(); closeWorkflowDb(); });

  const ask = (name: string, prompt: string): FlowTriggerNode => ({ name, type: 'PIECE', settings: { pieceName: PIECE_ASK_NAME, pieceVersion: PIECE_VERSION, actionName: 'ask', input: { prompt } } });

  for (const name of ['toString', 'hasOwnProperty', 'valueOf', '__defineGetter__']) {
    test.skipIf(skip)(`a step named ${name} records its output and a later step reads it`, async () => {
      const first = ask(name, 'first question');
      first.nextAction = ask('after', `got {{${name}}}`);
      const flow = createFlow();
      const version = createDraftVersion({ flowId: flow.id, displayName: 'Names', trigger: { name: 'trigger', type: 'EMPTY', nextAction: first } });
      const before = prompts.length;
      const response = await createWorkflowRoutes()['/api/workflows/:id/run']!.POST!(Object.assign(
        new Request('http://local/run', { method: 'POST', body: JSON.stringify({ environment: 'TESTING' }) }), { params: { id: flow.id } }));
      expect(response.status).toBe(202);
      const { id } = await response.json() as { id: string };
      await new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime!) }) } }).drain();
      const saved = getFlowRun(id)!;
      expect(saved.failedStep).toBeNull();
      expect(saved.status).toBe('SUCCEEDED');
      expect(prompts.slice(before)[0]).toBe('first question');
      expect(prompts.slice(before)[1]).toContain('reply to first question');
      expect(JSON.stringify(Object.getOwnPropertyDescriptor(saved.steps, name)?.value)).toContain('reply to first question');
    }, 60_000);
  }

  // The loop lookup (getLoopStepOutput) and the per-iteration state both go through ownStep.
  test.skipIf(skip)('a loop named valueOf runs a body step named toString on every item', async () => {
    const loop: FlowTriggerNode = { name: 'valueOf', type: 'LOOP_ON_ITEMS', settings: { items: "{{ ['a', 'b'] }}" }, firstLoopAction: ask('toString', 'item {{valueOf.item}}') };
    const flow = createFlow();
    createDraftVersion({ flowId: flow.id, displayName: 'Loop names', trigger: { name: 'trigger', type: 'EMPTY', nextAction: loop } });
    const before = prompts.length;
    const response = await createWorkflowRoutes()['/api/workflows/:id/run']!.POST!(Object.assign(
      new Request('http://local/run', { method: 'POST', body: JSON.stringify({ environment: 'TESTING' }) }), { params: { id: flow.id } }));
    expect(response.status).toBe(202);
    const { id } = await response.json() as { id: string };
    await new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime!) }) } }).drain();
    const saved = getFlowRun(id)!;
    expect(saved.failedStep).toBeNull();
    expect(saved.status).toBe('SUCCEEDED');
    expect(prompts.slice(before)).toEqual(['item a', 'item b']);
    const recorded = Object.getOwnPropertyDescriptor(saved.steps, 'valueOf')?.value as { output: { output: { iterations: Record<string, unknown>[] } } };
    expect(recorded.output.output.iterations).toHaveLength(2);
    for (const iteration of recorded.output.output.iterations) expect(Object.hasOwn(iteration, 'toString')).toBe(true);
  }, 60_000);
});
