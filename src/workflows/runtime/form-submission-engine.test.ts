/** Production worker/engine/authorization pipeline against a local Sheets fixture, never Google. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../db';
import { setEncryptionKey } from '../db/encryption';
import { createFlow, setPublishedVersion, updateFlowStatus } from '../db/repos/flow';
import { createDraftVersion, lockVersion } from '../db/repos/flow-version';
import { getFlowRun, listRuns } from '../db/repos/flow-run';
import { upsertConnection } from '../db/repos/app-connection';
import { configureWorkflowReadiness } from '../db/repos/flow-readiness';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { CredentialResolver } from '../credentials/adapter';
import { SandboxApi } from '../sandbox-api/server';
import { workflowLogsBase } from '../sandbox-api/config';
import { EngineRuntime } from '../runner/engine-runtime/engine-runtime';
import { EngineFlowExecutor } from '../runner/engine-runtime/engine-flow-executor';
import { buildEngineBundle } from '../runner/engine-runtime/build';
import { buildPiece } from '../runner/engine-runtime/build-pieces';
import { Worker } from '../queue/worker';
import { createRunFlowHandler, RUN_FLOW } from '../runner/handler';
import { TriggerManager } from '../runner/triggers/manager';
import { buildSandboxServiceBackends } from './service-backends';
import { WorkflowEventBuffer } from './event-buffer';
import { WorkflowEventBus } from './event-bus';
import { PieceCatalog, metadataToCatalogEntry } from './piece-catalog';

const PIECE = '@activepieces/piece-google-sheets';
let dir: string, api: SandboxApi, runtime: EngineRuntime, manager: TriggerManager, worker: Worker;
let provider: ReturnType<typeof Bun.serve>;
let loseReply = false;
const rows: unknown[] = [], runIds: string[] = [];
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-form-engine-'));
  initWorkflowDb(join(dir, 'fixture.db')); setEncryptionKey(Buffer.alloc(32, 35));
  const bundle = await buildEngineBundle();
  provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json();
    rows.push(...body.values);
    return loseReply ? new Response('Fixture lost reply after append', { status: 500 })
      : Response.json({ updatedRows: body.values.length, updatedRange: 'Submissions!A2:C2' });
  } });
  const pieceDir = join(dir, 'fixture-sheets'); mkdirSync(join(pieceDir, 'src'), { recursive: true });
  writeFileSync(join(pieceDir, 'package.json'), JSON.stringify({ name: PIECE, version: '0.18.2' }));
  writeFileSync(join(pieceDir, 'src/index.ts'), `
    import { createAction, createPiece, PieceAuth, Property } from '@activepieces/pieces-framework';
    const auth = PieceAuth.OAuth2({ description: 'Fixture', required: true, scope: [], authUrl: 'http://localhost/unused', tokenUrl: 'http://localhost/unused' });
    const append = createAction({ name: 'sheets_append_values', displayName: 'Append fixture', description: 'Mirrors inspected Sheets inputs', auth,
      props: { spreadsheet_id: Property.ShortText({ displayName: 'ID', required: true }),
        worksheet_title: Property.ShortText({ displayName: 'Tab', required: true }), range: Property.ShortText({ displayName: 'Range', required: true }),
        values: Property.Json({ displayName: 'Rows', required: true }), value_input_option: Property.ShortText({ displayName: 'Input mode', required: true }) },
      async run(context) {
        const response = await fetch('http://127.0.0.1:${provider.port}/append', { method: 'POST', body: JSON.stringify(context.propsValue) });
        if (!response.ok) throw new Error('Fixture reply lost after append');
        return response.json();
      }
    });
    export const sheets = createPiece({ displayName: 'Fixture Sheets', description: 'Tests only', auth,
      minimumSupportedRelease: '0.82.0', logoUrl: '', authors: [], actions: [append], triggers: [] });
  `);
  await buildPiece(pieceDir);
  const installed = join(dir, 'node_modules', PIECE); mkdirSync(dirname(installed), { recursive: true });
  symlinkSync(join(pieceDir, 'dist'), installed, 'dir');
  upsertConnection({ externalId: 'fixture-sheets', displayName: 'Fixture', type: 'OAUTH2', pieceName: PIECE,
    pieceVersion: '0.18.2', value: { access_token: 'synthetic-only' } });
  const services = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(),
    authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
      learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
    emergencyController: new EmergencyController(), auditTrail: new AuditTrail(), eventBuffer: new WorkflowEventBuffer(),
    llmManager: {} as any, channelService: {} as any, wsService: {} as any });
  api = new SandboxApi({ services }); await api.start({ port: 0 });
  runtime = new EngineRuntime({ api, bundlePath: bundle.bundlePath, expectedDigest: bundle.digest, cwd: dir, customPiecesPaths: [dir], devPieces: [], baseCodeDir: join(dir, 'code') });
  const handle = await runtime.acquire({ runId: 'form-fixture-metadata', projectId: DEFAULT_IDS.project });
  try { configureWorkflowReadiness({ pieces: new PieceCatalog([metadataToCatalogEntry(await handle.extractPieceMetadata({ pieceName: PIECE, pieceVersion: '0.18.2' }))]) }); }
  finally { await handle.release(); }
  manager = new TriggerManager({ eventBus: new WorkflowEventBus(), log: () => {} }); await manager.start();
  worker = new Worker({ log: () => {}, handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime) }) } });
}, 120_000);
afterAll(async () => {
  await manager?.stop(); await runtime?.shutdown(); await api?.stop(); provider?.stop(true);
  closeWorkflowDb(); setEncryptionKey(null);
  for (const id of runIds) rmSync(join(workflowLogsBase(), id + '.bin'), { force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});

for (const uncertain of [false, true]) test(`real engine form append: ${uncertain ? 'lost reply stays failed without replay' : 'one normalized row and a completion receipt'}`, async () => {
  loseReply = uncertain;
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Form engine fixture', trigger: {
    name: 'trigger', type: 'PIECE_TRIGGER', settings: { pieceName: 'webhook', input: { submission_id_field: 'id', submission_email_field: 'email' } },
    nextAction: { name: 'append', type: 'PIECE', settings: { pieceName: PIECE, pieceVersion: '0.18.2', actionName: 'sheets_append_values', input: {
      auth: '{{connections.fixture-sheets}}', spreadsheet_id: 'fixture-only', worksheet_title: 'Submissions', range: 'A:C', value_input_option: 'RAW',
      values: [['{{trigger.id}}', '{{trigger.email}}', '{{trigger.name}}']],
    } } },
  } });
  lockVersion(version.id); setPublishedVersion(flow.id, version.id); updateFlowStatus(flow.id, 'ENABLED');
  await manager.refresh(flow.id);
  const submit = (email: string) => manager.webhookManager().handleRequest(flow.id, new Request('http://localhost/forms', {
    method: 'POST', body: JSON.stringify({ id: ' 123 ', email, name: ' Alice ' }),
  }));
  const before = rows.length;
  expect((await submit('not-an-email')).status).toBe(422);
  expect(listRuns({ flowId: flow.id })).toHaveLength(0);
  const accepted = await (await submit(' ME@EXAMPLE.COM ')).json();
  expect(accepted.outcome).toBe('started'); runIds.push(accepted.runId);
  await worker.drain();
  expect(getFlowRun(accepted.runId)?.status).toBe(uncertain ? 'FAILED' : 'SUCCEEDED');
  expect(rows.slice(before)).toEqual([['123', 'me@example.com', 'Alice']]);
  expect(listWorkflowEffects(accepted.runId)[0]?.status).toBe(uncertain ? 'dispatching' : 'succeeded');
  expect((await (await submit('me@example.com')).json()).outcome).toBe('duplicate');
  await worker.drain(); expect(rows.length - before).toBe(1);
}, 45_000);
