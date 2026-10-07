/** Real engine + daemon + uploaded run state; synthetic pieces never contact a provider. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../vault/schema';
import { initWorkflowDb } from '../db';
import { createFlow } from '../db/repos/flow';
import { createDraftVersion } from '../db/repos/flow-version';
import { createFlowRun, getFlowRun } from '../db/repos/flow-run';
import { enqueue } from '../db/repos/job-queue';
import { AuthorityEngine } from '../../authority/engine';
import { ApprovalManager } from '../../authority/approval';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { DeferredExecutor } from '../../authority/deferred-executor';
import { DecisionQueue } from '../../brief/decisions';
import { DecisionDocuments } from '../../brief/decision-documents';
import { CredentialResolver } from '../credentials/adapter';
import { WorkflowEventBuffer } from './event-buffer';
import { buildSandboxServiceBackends } from './service-backends';
import { resumeResolvedWorkflowEffects } from './effect-approval-scheduler';
import { SandboxApi } from '../sandbox-api/server';
import { workflowLogsBase } from '../sandbox-api/config';
import { buildEngineBundle } from '../runner/engine-runtime/build';
import { buildPiece } from '../runner/engine-runtime/build-pieces';
import { EngineRuntime } from '../runner/engine-runtime/engine-runtime';
import { EngineFlowExecutor } from '../runner/engine-runtime/engine-flow-executor';
import { loadExecutionStateFromLog } from '../runner/engine-runtime/execution-state-loader';
import { createRunFlowHandler } from '../runner/handler';
import { Worker } from '../queue/worker';

type RecordedStep = { input: Record<string, unknown>; output: { received: Record<string, unknown>; authenticated: boolean } };

let directory: string, runId: string | undefined, runtime: EngineRuntime | undefined, api: SandboxApi | undefined;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'jarvis-f14-engine-')); initWorkflowDb(join(directory, 'db.sqlite')); });
afterEach(async () => {
  await runtime?.shutdown(); await api?.stop(); closeDb();
  if (runId) rmSync(join(workflowLogsBase(), runId + '.bin'), { force: true });
  rmSync(directory, { recursive: true, force: true }); runtime = undefined; api = undefined; runId = undefined;
});

for (const kind of ['email', 'calendar'] as const) test(`F14 review R3: real ${kind} engine records the approved input without credentials`, async () => {
  const piece = kind === 'email' ? '@activepieces/piece-gmail' : '@activepieces/piece-google-calendar';
  const action = kind === 'email' ? 'send_email' : 'create_google_calendar_event';
  const input = kind === 'email'
    ? { receiver: ['first@example.test'], cc: [], bcc: [], subject: 'Original subject', body: 'Original body', body_type: 'plain_text', draft: false }
    : { calendar_id: 'primary', title: 'Original event', description: 'Original agenda', start_date_time: '2026-11-01T09:00:00Z', end_date_time: '2026-11-01T09:30:00Z', attendees: ['first@example.test'], location: '', send_notifications: 'all' };
  const fixture = join(directory, 'fixture'); mkdirSync(join(fixture, 'src'), { recursive: true });
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: piece, version: '0.0.1' }));
  // Only the provider action is synthetic. The loader, props/context conversion,
  // guard, approval scheduler, worker and uploaded input are production paths.
  writeFileSync(join(fixture, 'src/index.ts'), `
    import { createAction, createPiece, PieceAuth, Property } from '@activepieces/pieces-framework';
    const auth = PieceAuth.OAuth2({ description: 'Fixture', required: true, scope: [], authUrl: 'http://127.0.0.1/unused', tokenUrl: 'http://127.0.0.1/unused' });
    const sample = ${JSON.stringify(input)};
    const props = Object.fromEntries(Object.entries(sample).map(([key, value]) => [key,
      Array.isArray(value) ? Property.Array({ displayName: key, required: false })
        : typeof value === 'boolean' ? Property.Checkbox({ displayName: key, required: false })
        : Property.ShortText({ displayName: key, required: false })]));
    const action = createAction({ name: '${action}', displayName: 'Fixture', description: '', auth, props,
      async run(context) { const { auth: _, ...received } = context.propsValue;
        return { received, authenticated: context.auth.access_token === 'ENGINE_ONLY_SECRET' }; } });
    export const fixture = createPiece({ displayName: 'Fixture', description: '', auth,
      minimumSupportedRelease: '0.82.0', logoUrl: '', authors: [], actions: [action], triggers: [] });
  `);
  await buildPiece(fixture);
  const installed = join(directory, 'node_modules', piece); mkdirSync(dirname(installed), { recursive: true });
  symlinkSync(join(fixture, 'dist'), installed, 'dir');
  const credentials = new CredentialResolver();
  credentials.register({ id: 'fixture', canResolve: id => id === 'jarvis:fixture',
    resolve: async () => ({ type: 'OAUTH2', value: { access_token: 'ENGINE_ONLY_SECRET' } }) });
  const manager = new ApprovalManager(), audit = new AuditTrail();
  const queue = new DecisionQueue(getDb(), { approvalManager: manager, deferredExecutor: new DeferredExecutor(manager, audit) });
  const documents = new DecisionDocuments(getDb(), queue, manager);
  api = new SandboxApi({ services: buildSandboxServiceBackends({ decisionDocumentsEnabled: true, credentialResolver: credentials,
    llmManager: {} as any, channelService: {} as any, wsService: {} as any, eventBuffer: new WorkflowEventBuffer(),
    approvalManager: manager, auditTrail: audit, emergencyController: new EmergencyController(),
    authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: ['send_email', 'write_data'], overrides: [], context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
  }) });
  await api.start({ port: 0 });
  runtime = new EngineRuntime({ api, bundlePath: (await buildEngineBundle()).bundlePath,
    cwd: directory, customPiecesPaths: [directory], devPieces: [], baseCodeDir: join(directory, 'code') });
  const flow = createFlow(), version = createDraftVersion({ flowId: flow.id, displayName: 'Document log fixture', trigger: {
    name: 'trigger', type: 'EMPTY', nextAction: { name: 'action', type: 'PIECE', settings: { pieceName: piece, pieceVersion: '0.0.1', actionName: action,
      input: { ...input, auth: "{{connections['jarvis:fixture']}}" } } },
  } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id }); runId = run.id;
  const worker = new Worker({ log: () => {}, handlers: { RUN_FLOW: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime, { terminalTimeoutMs: 3000 }) }) } });
  enqueue({ jobType: 'RUN_FLOW', flowRunId: run.id, maxAttempts: 1, payload: { runId: run.id } });
  await worker.drain();
  expect(getFlowRun(run.id)!.status).toBe('PAUSED');
  const original = (getFlowRun(run.id)!.steps!.action as { output: RecordedStep }).output;
  const id = `approval:${manager.getPending()[0]!.id}`, view = documents.get(id);
  const edited = view.document!.kind === 'email'
    ? { ...view.document!, to: ['second@example.test'], cc: ['copy@example.test'], bcc: ['blind@example.test'], subject: 'Approved subject', body: 'Approved body' }
    : { ...view.document!, title: 'Approved event', description: 'Approved agenda', start: '2026-11-02T10:00:00Z', end: '2026-11-02T11:00:00Z', attendees: ['second@example.test'], location: 'Office' };
  documents.act(id, { requestId: 'edit', revision: view.decision.revision, action: 'save', document: edited });
  documents.act(id, { requestId: 'approve', revision: documents.get(id).decision.revision, action: 'approve' });
  expect(resumeResolvedWorkflowEffects()).toBe(1); await worker.drain();
  const complete = getFlowRun(run.id)!; expect(complete.status).toBe('SUCCEEDED');
  const step = (complete.steps!.action as { output: RecordedStep }).output;
  const expected = edited.kind === 'email'
    ? { ...input, receiver: edited.to, cc: edited.cc, bcc: edited.bcc, subject: edited.subject, body: edited.body }
    : { ...input, title: edited.title, description: edited.description, start_date_time: edited.start, end_date_time: edited.end, attendees: edited.attendees, location: edited.location };
  expect(step.output).toEqual({ received: expected, authenticated: true });
  expect(step.input).toMatchObject(expected);
  expect(step.input.auth).toEqual(original.input.auth);
  expect(JSON.stringify(complete.steps)).not.toContain('ENGINE_ONLY_SECRET');
  const restored = await loadExecutionStateFromLog(run.id);
  expect((restored!.steps.action as { input: unknown }).input).toEqual(step.input);
  expect(JSON.stringify(restored)).not.toContain('ENGINE_ONLY_SECRET');
}, 60_000);
