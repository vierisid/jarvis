import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from '../../../../src/workflows/db';
import { getDb } from '../../../../src/vault/schema';
import { createEntity } from '../../../../src/vault/entities';
import { createFact, deleteFact } from '../../../../src/vault/facts';
import { createWorkItem } from '../../../../src/goals/work-items';
import { ApprovalManager } from '../../../../src/authority/approval';
import { DeferredExecutor } from '../../../../src/authority/deferred-executor';
import { AuditTrail } from '../../../../src/authority/audit';
import { DecisionQueue } from '../../../../src/brief/decisions';
import { createDecisionRoutes } from '../../../../src/brief/decision-routes';
import { MemoryStream } from '../../../../src/brief/memory-stream';
import { createMemoryStreamRoutes } from '../../../../src/brief/memory-stream-routes';
import { WorkflowContext } from '../../../../src/brief/workflow-context';
import { createWorkflowContextRoutes } from '../../../../src/brief/workflow-context-routes';
import { BriefCapabilities } from '../../../../src/brief/capabilities';
import { registerReconciliation } from '../../../../src/brief/registrations/reconciliation';
import { createFlow } from '../../../../src/workflows/db/repos/flow';
import { createDraftVersion, lockVersion } from '../../../../src/workflows/db/repos/flow-version';
import { createFlowRun, updateRun } from '../../../../src/workflows/db/repos/flow-run';
import { BriefReconciliationClient } from './client';
import { decisionsSource, inspectionSource, memorySource, type GetJson } from './sources';
import { ReadFailure } from './resource';

let directory: string, queue: DecisionQueue, manager: ApprovalManager, memory: MemoryStream, context: WorkflowContext;
let client: BriefReconciliationClient, get: GetJson, caps: BriefCapabilities, unavailable: boolean;
let requests: string[], memoryAfterFirst: (() => void) | undefined;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-f27-')); const db = initWorkflowDb(join(directory, 'fixture.db'));
  manager = new ApprovalManager('f27-fixture');
  const executor = new DeferredExecutor(manager, new AuditTrail());
  queue = new DecisionQueue(db, { approvalManager: manager, deferredExecutor: executor });
  const usage = { readiness: () => 'ready' as const, readUses: () => ({ state: 'ready' as const, uses: [] }) };
  memory = new MemoryStream(db, usage); context = new WorkflowContext(db, DEFAULT_IDS.project, () => true);
  caps = new BriefCapabilities([...registerReconciliation(() => ({ snapshots: true, sharedSocket: true, identityLifecycle: true })),
    { id: 'decisions', provider: queue }, { id: 'memoryStream', provider: memory }, { id: 'memoryUsage', provider: usage },
    { id: 'workflowContext', provider: context }], ['reconciliation', 'decisions', 'memoryStream', 'memoryUsage', 'workflowContext']);
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  const decisions = createDecisionRoutes(caps, json, queue), memories = createMemoryStreamRoutes(caps, json, memory), runs = createWorkflowContextRoutes(caps, json, context);
  requests = []; unavailable = false; memoryAfterFirst = undefined;
  get = async (url, signal) => {
    signal.throwIfAborted(); requests.push(url); const parsed = new URL(url, 'http://fixture');
    const req = new Request(parsed); let response: Response;
    if (parsed.pathname === '/api/brief/decisions') response = await decisions['/api/brief/decisions']!.GET(req);
    else if (parsed.pathname === '/api/brief/memory') {
      response = unavailable ? json({ state: 'unavailable' }, 503) : await memories['/api/brief/memory'].GET(req);
      if (!parsed.searchParams.has('cursor')) { const action = memoryAfterFirst; memoryAfterFirst = undefined; action?.(); }
    } else if (parsed.pathname.endsWith('/inspection')) response = runs['/api/brief/workflows/:flowId/inspection'].GET(
      Object.assign(req, { params: { flowId: decodeURIComponent(parsed.pathname.split('/')[4]!) } }));
    else throw Error('Read-only fixture allowlist');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    if (!response.ok) throw new ReadFailure(`http_${response.status}`, false, response.status === 501, response.status);
    return response.json();
  };
  client = new BriefReconciliationClient({ capabilities: async () => caps.snapshot() }); client.start();
});
afterEach(() => { client.stop(); closeWorkflowDb(); rmSync(directory, { recursive: true, force: true }); });

test('real canonical approvals and work survive missed events and converge once each after reconnect', async () => {
  const projection = client.projection(decisionsSource({ pages: 5, limit: 1 }, get)); projection.subscribe(() => {});
  await tick(); expect(projection.getSnapshot().state).toBe('empty');
  const approval = manager.createRequest({ agentId: 'fixture', agentName: 'Fixture', toolName: 'fixture_tool', toolArguments: {},
    actionCategory: 'write_data', urgency: 'normal', reason: 'Synthetic approval', context: '', executionMode: 'deferred' });
  const work = createWorkItem({ title: 'Unresolved work' });
  getDb().run('UPDATE commitments SET created_at=? WHERE id=?', [Date.now() - 3 * 86400_000, work.id]);
  // No frame was delivered for either canonical write.
  client.observer.onClose(); client.observer.onOpen(); await tick();
  const authoritative = (await queue.read({ limit: 100 })).data.items;
  expect(projection.getSnapshot().data?.items).toEqual(authoritative);
  expect(authoritative.map(i => i.decisionId).sort()).toEqual([`approval:${approval.id}`, `work:${work.id}`].sort());
  for (const sequence of [4, 4, 2, 3]) client.observer.onMessage({ type: 'goal_event', payload: { sequence, eventId: `e${sequence}` } });
  await tick(); expect(projection.getSnapshot().data?.items).toEqual(authoritative);
  expect(projection.getSnapshot().data?.total).toBeNull();
  expect(manager.getRequest(approval.id)?.status).toBe('pending');
});
test('canonical memory deletion during pagination restarts before publishing and unavailable never becomes empty', async () => {
  const subject = createEntity('person', 'Fixture').id;
  const fact = createFact(subject, 'likes', 'tea'); createFact(subject, 'likes', 'coffee');
  memoryAfterFirst = () => deleteFact(fact.id);
  const projection = client.projection(memorySource({ pages: 3, limit: 1 }, get)); projection.subscribe(() => {});
  await tick(); expect(projection.getSnapshot().state).toBe('ready');
  expect(projection.getSnapshot().data?.items.map(i => i.factId)).not.toContain(fact.id);
  expect(projection.getSnapshot().data?.total).toBe(1);
  expect(requests.filter(url => url.startsWith('/api/brief/memory?') && !url.includes('cursor')).length).toBe(2);
  unavailable = true; projection.refresh(); expect(projection.getSnapshot().data).toBeNull(); await tick();
  expect(projection.getSnapshot()).toMatchObject({ state: 'stale', data: null, reason: 'http_503' });
  unavailable = false; const remaining = (await memory.read());
  if (remaining.state !== 'ready') throw Error('Fixture expected a fact'); deleteFact(remaining.data.items[0]!.factId);
  await client.refresh(); await tick(); expect(projection.getSnapshot()).toMatchObject({ state: 'empty', data: { items: [], total: 0 } });
});
test('selected run status refreshes from canonical inspection while a later run never replaces its identity', async () => {
  const flowId = createFlow().id;
  const versionId = lockVersion(createDraftVersion({ flowId, displayName: 'Fixture', trigger: { name: 'trigger', type: 'EMPTY' } }).id).id;
  const runId = createFlowRun({ flowId, flowVersionId: versionId }).id;
  const projection = client.projection(inspectionSource({ flowId, versionId, runId }, get)); projection.subscribe(() => {});
  await tick(); expect(projection.getSnapshot().data?.run?.status).toBe('queued');
  updateRun(runId, { status: 'PAUSED' }); createFlowRun({ flowId, flowVersionId: versionId });
  client.observer.onOpen(); await tick();
  expect(projection.getSnapshot().data).toEqual(context.selection(flowId, versionId, runId));
  expect(projection.getSnapshot().data?.run).toMatchObject({ runId, status: 'paused' });
});
