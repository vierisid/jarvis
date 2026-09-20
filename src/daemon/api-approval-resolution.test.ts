import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeDb, generateId, initDatabase } from '../vault/schema.ts';
import { ApprovalManager, type ApprovalRequest } from '../authority/approval.ts';
import { AuditTrail } from '../authority/audit.ts';
import { DeferredExecutor } from '../authority/deferred-executor.ts';
import type { ToolRegistry } from '../actions/tools/registry.ts';
import { createApiRoutes, type ApiContext } from './api-routes.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => closeDb());

type Handler = (req: Request & { params: { id: string } }) => Response | Promise<Response>;

/** An approval decided before a restart, then the daemon coming back and reconciling. */
function harness(interrupted = false) {
  const before = new ApprovalManager(generateId());
  const req = before.createRequest({ agentId: 'a1', agentName: 'PA', toolName: 'send_email',
    toolArguments: { to: 'x@example.com' }, actionCategory: 'send_email', urgency: 'normal', reason: 'Send the invoice', context: '' });
  before.approve(req.id, 'dashboard');
  if (interrupted) expect(before.claimExecution(req.id, 'dashboard')).toBe(true);
  const mgr = new ApprovalManager();
  mgr.reconcileAfterRestart();
  let runs = 0;
  const executor = new DeferredExecutor(mgr, new AuditTrail());
  executor.setToolRegistry({ get: () => undefined, execute: async () => { runs++; return 'sent'; } } as unknown as ToolRegistry);
  const broadcasts: ApprovalRequest[] = [];
  const routes = createApiRoutes({ config: {}, agentService: {}, approvalManager: mgr, deferredExecutor: executor,
    authorityEngine: { getConfig: () => ({ governed_categories: [] }) },
    emergencyController: { getState: () => 'normal' },
    wsService: { broadcastApprovalUpdate: (r: ApprovalRequest) => broadcasts.push(r) },
  } as unknown as ApiContext) as Record<string, Partial<Record<'GET' | 'POST', Handler>>>;
  const call = (path: string, method: 'GET' | 'POST', query = '', body?: unknown) => {
    const url = `http://localhost${path.replace(':id', req.id)}${query}`;
    const request = new Request(url, { method, ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });
    return routes[path]![method]!(Object.assign(request, { params: { id: req.id } }));
  };
  return { mgr, req, call, runs: () => runs, broadcasts };
}

test('status and listings surface an approval that never started, with its state', async () => {
  const h = harness();
  const status = await (await h.call('/api/authority/status', 'GET')).json() as Record<string, unknown>;
  expect(status).toMatchObject({ pending_approvals: 0, unresolved_approvals: 1 });
  const unresolved = await (await h.call('/api/authority/approvals', 'GET', '?status=unresolved')).json() as Record<string, unknown>[];
  expect(unresolved).toHaveLength(1);
  expect(unresolved[0]).toMatchObject({ id: h.req.id, status: 'approved', execution_state: 'not_started', intent: 'Send the invoice' });
  expect(await (await h.call('/api/authority/approvals', 'GET', '?status=pending')).json()).toEqual([]);
  const history = await (await h.call('/api/authority/approvals', 'GET', '?limit=5')).json() as Record<string, unknown>[];
  expect(history[0]).toMatchObject({ id: h.req.id, execution_state: 'not_started' });
});

test('execute runs a not-started approval exactly once, then it is no longer a decision', async () => {
  const h = harness();
  const first = await h.call('/api/authority/approvals/:id/execute', 'POST');
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true, result: 'sent' });
  expect(h.runs()).toBe(1);
  expect(h.broadcasts).toHaveLength(1);
  expect(h.mgr.getRequest(h.req.id)).toMatchObject({ status: 'executed', execution_outcome: 'committed', execution_claimed_by: 'dashboard' });
  expect((await h.call('/api/authority/approvals/:id/execute', 'POST')).status).toBe(404);
  expect((await h.call('/api/authority/approvals/:id/close', 'POST')).status).toBe(404);
  expect(h.runs()).toBe(1);
  const status = await (await h.call('/api/authority/status', 'GET')).json() as Record<string, unknown>;
  expect(status).toMatchObject({ unresolved_approvals: 0 });
});

test('an interrupted approval refuses execute and accepts close with a note', async () => {
  const h = harness(true);
  const listed = await (await h.call('/api/authority/approvals', 'GET', '?status=unresolved')).json() as Record<string, unknown>[];
  expect(listed[0]).toMatchObject({ execution_state: 'unknown' });
  const refused = await h.call('/api/authority/approvals/:id/execute', 'POST');
  expect(refused.status).toBe(409);
  expect(await refused.text()).toContain('may have run');
  expect(h.runs()).toBe(0);
  const closed = await h.call('/api/authority/approvals/:id/close', 'POST', '', { note: 'Checked the outbox: it was sent' });
  expect(closed.status).toBe(200);
  expect(h.mgr.getRequest(h.req.id)).toMatchObject({ status: 'approved', execution_outcome: 'closed', resolved_by: 'dashboard',
    resolution_note: 'Checked the outbox: it was sent' });
  expect(await (await h.call('/api/authority/approvals', 'GET', '?status=unresolved')).json()).toEqual([]);
  expect(h.broadcasts).toHaveLength(1);
});

test('close tolerates a missing or non-object body and refuses a non-string note', async () => {
  const h = harness();
  expect((await h.call('/api/authority/approvals/:id/close', 'POST', '', { note: 123 })).status).toBe(400);
  expect(h.mgr.getRequest(h.req.id)).toMatchObject({ execution_outcome: 'not_started' });
  const closed = await h.call('/api/authority/approvals/:id/close', 'POST', '', null);
  expect(closed.status).toBe(200);
  expect(h.mgr.getRequest(h.req.id)).toMatchObject({ execution_outcome: 'closed', resolution_note: null });
});

test('approve and deny have nothing to flip on an unresolved row', async () => {
  const h = harness();
  expect((await h.call('/api/authority/approvals/:id/approve', 'POST')).status).toBe(404);
  expect((await h.call('/api/authority/approvals/:id/deny', 'POST')).status).toBe(404);
  expect(h.runs()).toBe(0);
  expect(h.mgr.getRequest(h.req.id)).toMatchObject({ status: 'approved', execution_outcome: 'not_started' });
});
