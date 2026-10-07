import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb } from '../vault/schema';
import { initWorkflowDb } from '../workflows/db';
import { createFlow } from '../workflows/db/repos/flow';
import { createDraftVersion } from '../workflows/db/repos/flow-version';
import { createFlowRun } from '../workflows/db/repos/flow-run';
import { WorkflowEffectBoundary } from '../workflows/runtime/effect-boundary';
import { AuthorityEngine } from '../authority/engine';
import { EmergencyController } from '../authority/emergency';
import { ApprovalManager } from '../authority/approval';
import { DeferredExecutor } from '../authority/deferred-executor';
import { AuditTrail } from '../authority/audit';
import { DecisionQueue } from '../brief/decisions';
import { DecisionDocuments } from '../brief/decision-documents';
import { BriefCapabilities } from '../brief/capabilities';
import { registerDecisions } from '../brief/registrations/decisions';
import { registerDecisionEdits } from '../brief/registrations/decision-edits';
import { createApiRoutes, type ApiContext } from './api-routes';
import { WebSocketServer } from '../comms/websocket';
import { PanelSessionStore } from '../sidecar/panel-sessions';
import type { SidecarManager } from '../sidecar/manager';

type Handler = (req: Request & { params: { id: string } }) => Response | Promise<Response>;
type Routes = Record<string, Partial<Record<'GET' | 'POST', Handler>>>;
let queue: DecisionQueue, manager: ApprovalManager, documents: DecisionDocuments, id: string;
const base = '/api/brief/decisions/:id/document';
beforeEach(async () => {
  initWorkflowDb(':memory:'); manager = new ApprovalManager();
  queue = new DecisionQueue(getDb(), { approvalManager: manager, deferredExecutor: new DeferredExecutor(manager, new AuditTrail()) });
  documents = new DecisionDocuments(getDb(), queue, manager);
  const piece = '@activepieces/piece-gmail', action = 'send_email', flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: 'HTTP fixture', trigger: { name: 'trigger', type: 'EMPTY', nextAction: { name: 'action', type: 'PIECE', settings: { pieceName: piece, actionName: action, pieceVersion: '0.0.1', input: {} } } } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'RUNNING' });
  const args = { receiver: ['person@example.test'], subject: 'Review', body: 'Fixture body', body_type: 'plain_text', draft: false };
  const reply = await new WorkflowEffectBoundary({ approvalManager: manager, auditTrail: new AuditTrail(), emergencyController: new EmergencyController(),
    authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: ['send_email'], overrides: [], context_rules: [], learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }) }).invoke({
    context: { runId: run.id, projectId: run.projectId, stepName: 'action', executionPath: [] }, piece, action, route: 'piece', toolName: 'piece:gmail/send_email', toolCategory: 'piece', category: 'send_email', documentReview: true,
    request: args, prepare: () => ({ arguments: args, target: { receiver: args.receiver } }), execute: async () => { throw Error('Must not execute in document route'); } });
  id = `approval:${reply.approval!.approvalId}`;
});
afterEach(() => closeDb());
function routes(enabled = true, provider: DecisionDocuments | undefined = documents, registered: DecisionDocuments | undefined = provider, queueEnabled = true) {
  return createApiRoutes({ briefDecisionDocuments: provider, briefDecisions: queue,
    briefCapabilities: new BriefCapabilities([...registerDecisions(queue), ...registerDecisionEdits(registered)], [ ...(enabled ? ['decisionEdits' as const] : []), ...(queueEnabled ? ['decisions' as const] : []) ]),
  } as ApiContext) as Routes;
}
async function call(table: Routes, method: 'GET' | 'POST' = 'GET', data?: unknown, query = '') {
  const req = Object.assign(new Request(`http://localhost${base.replace(':id', encodeURIComponent(id))}${query}`, { method,
    ...(data === undefined ? {} : { body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } }) }), { params: { id } });
  const res = await table[base]![method]!(req); expect(res.headers.get('cache-control')).toBe('no-store');
  return { status: res.status, body: await res.json() as any };
}

test('optional provider identity, readiness and both capability flags gate every read and write', async () => {
  const other = new DecisionDocuments(getDb(), queue, manager), command = { requestId: 'test', revision: documents.get(id).decision.revision, action: 'keep_draft' };
  for (const [table, status] of [[routes(false),503], [routes(true, documents, other),501], [routes(true, documents, documents, false),503], [createApiRoutes({} as ApiContext) as Routes,501]] as const) {
    expect((await call(table)).status).toBe(status); expect((await call(table, 'POST', command)).status).toBe(status);
  }
  expect(documents.get(id).state).toBe('pending');
});

test('save, recover lost response, reject stale controls and reload the same decision', async () => {
  const table = routes(), view = (await call(table)).body;
  const command = { requestId: 'lost', revision: view.decision.revision, action: 'save', document: { ...view.document, body: 'Edited via route' } };
  const save = await call(table, 'POST', command); expect(save.status).toBe(200); expect(save.body.outcome).toBe('revision_saved');
  expect((await call(table, 'POST', command)).body).toEqual(save.body);
  expect((await call(table, 'GET', undefined, '?requestId=lost')).body.receipt).toEqual(save.body);
  expect((await call(table, 'POST', { ...command, requestId: 'stale' })).status).toBe(409);
  const current = (await call(table)).body; expect(current.decision.decisionId).toBe(id); expect(current.document.body).toBe('Edited via route');
  expect(current.decision.approval.status).toBe('pending'); expect(save.body.executed).toBe(false);
});

test('malformed, unknown, oversized and generic tool argument payloads cannot write', async () => {
  const table = routes(), view = documents.get(id), cmd = { requestId: 'bad', revision: view.decision.revision, action: 'save' };
  for (const body of [[], {}, { ...cmd, document: view.document, toolArguments: {} }, { ...cmd, document: { ...view.document, auth: 'secret' } }, { ...cmd, action: 'execute' }, { ...cmd, document: { ...view.document, body: 'x'.repeat(16001) } }]) expect((await call(table, 'POST', body)).status).toBe(400);
  expect((await call(table, 'POST', { ...cmd, document: { ...view.document, body: 'x'.repeat(128001) } })).status).toBe(413);
  for (const query of ['?requestId=a&requestId=b','?raw=1','?requestId=']) expect((await call(table, 'GET', undefined, query)).status).toBe(400);
  expect(documents.get(id)).toEqual(view);
});

test('authenticated HTTP protects document reads/writes and returns a truthful keep-draft receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-f14-http-')), socket = join(dir, 'api.sock');
  const server = new WebSocketServer(0, socket), sessions = new PanelSessionStore();
  server.setSidecarManager({ openPanelSession: async (token: string) => token === 'fixture-access' ? sessions.create('fixture-sidecar') : null,
    resolvePanelSession: (value: string) => sessions.get(value) } as SidecarManager);
  server.setApiRoutes(routes() as any);
  const path = base.replace(':id', encodeURIComponent(id));
  const get = (url: string, init: RequestInit = {}) => fetch(`http://localhost${url}`, { ...init, unix: socket });
  const command = { requestId: 'http-keep', revision: documents.get(id).decision.revision, action: 'keep_draft' };
  try {
    server.start(); expect((await get(path)).status).toBe(401);
    expect((await get(path, { method: 'POST', body: JSON.stringify(command) })).status).toBe(401);
    expect(documents.get(id).state).toBe('pending');
    const bootstrap = await get(`${path}?token=fixture-access`, { redirect: 'manual' });
    const headers = { Cookie: bootstrap.headers.get('set-cookie')!.split(';')[0]!, 'Content-Type': 'application/json' };
    const saved = await get(path, { method: 'POST', headers, body: JSON.stringify(command) }); expect(saved.status).toBe(200);
    const receipt = await saved.json() as any; expect(receipt).toMatchObject({ outcome: 'deferred', executed: false });
    const recovered = await get(`${path}?requestId=http-keep`, { headers }); expect((await recovered.json() as any).receipt).toEqual(receipt);
    expect((await (await get(path, { headers })).json() as any).state).toBe('deferred');
    expect(manager.getRequest(receipt.approvalId)!.status).toBe('expired');
  } finally { server.stop(); rmSync(dir, { recursive: true, force: true }); }
});
