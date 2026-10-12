/** Real engine -> authenticated sandbox routes -> local fake Gmail provider. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../db';
import { setEncryptionKey } from '../db/encryption';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, updateRun } from '../db/repos/flow-run';
import { upsertConnection } from '../db/repos/app-connection';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { CredentialResolver } from '../credentials/adapter';
import { SandboxApi } from '../sandbox-api/server';
import { workflowLogsBase } from '../sandbox-api/config';
import { EngineRuntime } from '../runner/engine-runtime/engine-runtime';
import { buildEngineBundle } from '../runner/engine-runtime/build';
import { buildPiece } from '../runner/engine-runtime/build-pieces';
import { buildSandboxServiceBackends } from './service-backends';
import { WorkflowEventBuffer } from './event-buffer';
import { getRunRecovery, listRunRecoveries } from './recovery';

const PIECE = '@activepieces/piece-gmail';
const COMMUNITY = '@q07/community';
let dir: string;
let api: SandboxApi | undefined;
let runtime: EngineRuntime | undefined;
let provider: ReturnType<typeof Bun.serve> | undefined;
let sends = 0;
let lose: 'before' | 'after' | null = null;
const runIds: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-q07-real-engine-'));
  initWorkflowDb(join(dir, 'fixture.db')); setEncryptionKey(Buffer.alloc(32, 31));
  const bundle = await buildEngineBundle();
  const pieceDir = join(dir, 'fake-gmail'); mkdirSync(join(pieceDir, 'src'), { recursive: true });
  writeFileSync(join(pieceDir, 'package.json'), JSON.stringify({ name: PIECE, version: '0.17.0' }));
  writeFileSync(join(pieceDir, 'src/index.ts'), `
    import { createAction, createPiece, PieceAuth, Property } from '@activepieces/pieces-framework';
    const auth = PieceAuth.OAuth2({ description: 'Fixture', required: true, scope: [], authUrl: 'http://localhost/unused', tokenUrl: 'http://localhost/unused' });
    const send = createAction({ name: 'send_email', displayName: 'Send fixture', description: '', auth,
      props: { endpoint: Property.ShortText({ displayName: 'Local provider', required: true }) },
      async run(context) {
        const response = await fetch(context.propsValue.endpoint, { method: 'POST' });
        if (!response.ok) throw new Error('Provider accepted work; response lost');
        return { data: await response.json() };
      }
    });
    export const gmail = createPiece({ displayName: 'Fake Gmail', description: 'Tests only', auth,
      minimumSupportedRelease: '0.82.0', logoUrl: '', authors: [], actions: [send], triggers: [] });
  `);
  await buildPiece(pieceDir);
  const installed = join(dir, 'node_modules', PIECE); mkdirSync(dirname(installed), { recursive: true });
  symlinkSync(join(pieceDir, 'dist'), installed, 'dir');
  const community = join(dir, 'node_modules', COMMUNITY); mkdirSync(dirname(community), { recursive: true });
  symlinkSync(join(pieceDir, 'dist'), community, 'dir');
  upsertConnection({ externalId: 'fake-mail', displayName: 'Fixture', type: 'OAUTH2', pieceName: PIECE,
    pieceVersion: '0.17.0', value: { access_token: 'synthetic-only' } });
  upsertConnection({ externalId: 'fake-community', displayName: 'Fixture', type: 'OAUTH2', pieceName: COMMUNITY,
    pieceVersion: '0.17.0', value: { access_token: 'synthetic-only' } });
  const services = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(),
    authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
      learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
    emergencyController: new EmergencyController(), auditTrail: new AuditTrail(), eventBuffer: new WorkflowEventBuffer(),
    llmManager: {} as any, channelService: {} as any, wsService: {} as any });
  const save = services.pieceReceipt!;
  services.pieceReceipt = (ctx, id, result) => {
    const failure = lose; lose = null;
    if (failure === 'before') throw new Error('fixture lost completion request');
    save(ctx, id, result);
    if (failure === 'after') throw new Error('fixture lost completion reply');
  };
  api = new SandboxApi({ services }); await api.start({ port: 0 });
  runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath, cwd: dir, customPiecesPaths: [dir], devPieces: [], baseCodeDir: join(dir, 'code') });
  provider = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    sends++;
    return req.url.endsWith('/uncertain') ? new Response('', { status: 500 }) : Response.json({ id: 'a123' });
  } });
}, 120_000);

afterAll(async () => {
  await runtime?.shutdown(); await api?.stop(); provider?.stop(true);
  closeWorkflowDb(); setEncryptionKey(null);
  for (const id of runIds) rmSync(join(workflowLogsBase(), id + '.bin'), { force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});

for (const failure of ['before', 'after'] as const) test(`real engine cannot resend after losing the completion ${failure === 'before' ? 'request' : 'reply'}`, async () => {
  const version = createDraftVersion({ flowId: createFlow().id, displayName: 'Crash boundary', trigger: { name: 'trigger', type: 'EMPTY',
    nextAction: { name: 'send', type: 'PIECE', settings: { pieceName: PIECE, pieceVersion: '0.17.0', actionName: 'send_email',
      input: { auth: '{{connections.fake-mail}}', endpoint: `http://127.0.0.1:${provider!.port}/send` } } } } });
  const run = createFlowRun({ flowId: version.flowId, flowVersionId: version.id, status: 'RUNNING', environment: 'TESTING' });
  runIds.push(run.id); const before = sends; lose = failure;
  const execute = async () => {
    const handle = await runtime!.acquire({ runId: run.id, projectId: DEFAULT_IDS.project });
    try { return await handle.executeFlow({ flowVersion: version, timeoutInSeconds: 15 }); }
    finally { await handle.release(); }
  };
  expect((await execute()).status).toBe('FAILED');
  // Fault injection only: simulate a duplicate BEGIN at the engine boundary.
  // Production recovery never sets a terminal run back to RUNNING.
  updateRun(run.id, { status: 'RUNNING' });
  expect((await execute()).status).toBe(failure === 'after' ? 'SUCCEEDED' : 'FAILED');
  expect(sends - before).toBe(1);
  expect(listWorkflowEffects(run.id)[0]!.status).toBe(failure === 'after' ? 'succeeded' : 'dispatching');
}, 45_000);

test('real engine retains an untracked uncertain send alongside a completed Gmail send', async () => {
  const version = createDraftVersion({ flowId: createFlow().id, displayName: 'Mixed recovery', trigger: { name: 'trigger', type: 'EMPTY',
    nextAction: { name: 'send', type: 'PIECE', settings: { pieceName: PIECE, pieceVersion: '0.17.0', actionName: 'send_email',
      input: { auth: '{{connections.fake-mail}}', endpoint: `http://127.0.0.1:${provider!.port}/send` } },
    nextAction: { name: 'uncertain', type: 'PIECE', settings: { pieceName: COMMUNITY, pieceVersion: '0.17.0', actionName: 'send_email',
      input: { auth: '{{connections.fake-community}}', endpoint: `http://127.0.0.1:${provider!.port}/uncertain` } } } } } });
  const run = createFlowRun({ flowId: version.flowId, flowVersionId: version.id, status: 'RUNNING', environment: 'TESTING' });
  runIds.push(run.id); const before = sends; lose = null;
  const handle = await runtime!.acquire({ runId: run.id, projectId: DEFAULT_IDS.project });
  try {
    const result = await handle.executeFlow({ flowVersion: version, timeoutInSeconds: 15 });
    expect(result.status).toBe('FAILED'); expect(result.failedStep?.name).toBe('uncertain');
  } finally { await handle.release(); }
  expect(sends - before).toBe(2);
  expect(getRunRecovery(run.id)).toMatchObject({ state: 'unknown', needsAttention: true, canReplay: false,
    effects: [{ stepName: 'send', status: 'completed' }], untrackedSteps: [{ stepName: 'uncertain', status: 'unknown' }] });
  expect(listRunRecoveries().recoveries.find(item => item.runId === run.id)?.state).toBe('unknown');
}, 45_000);
