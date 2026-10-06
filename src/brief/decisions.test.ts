import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb } from '../vault/schema';
import { initWorkflowDb } from '../workflows/db';
import { ApprovalManager } from '../authority/approval';
import { AuditTrail } from '../authority/audit';
import { DeferredExecutor } from '../authority/deferred-executor';
import type { ToolRegistry } from '../actions/tools/registry';
import { createWorkItem, decideWorkItem, checkWorkResult, getWorkItem } from '../goals/work-items';
import { createFlow } from '../workflows/db/repos/flow';
import { createDraftVersion, lockVersion } from '../workflows/db/repos/flow-version';
import { createFlowRun, updateRun } from '../workflows/db/repos/flow-run';
import { saveWorkflowEffect, type WorkflowEffect } from '../workflows/db/repos/workflow-effect';
import { DecisionQueue } from './decisions';

let directory: string, file: string, queue: DecisionQueue, manager: ApprovalManager, executor: DeferredExecutor;
let calls: number;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-f12-'));
  file = join(directory, 'fixture.db'); initWorkflowDb(file); calls = 0; wire();
});
afterEach(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });
function wire() {
  manager = new ApprovalManager('fixture-boot'); executor = new DeferredExecutor(manager, new AuditTrail());
  executor.setToolRegistry({ get: () => undefined, execute: async () => { calls++; return 'fixture result'; } } as unknown as ToolRegistry);
  queue = new DecisionQueue(getDb(), { approvalManager: manager, deferredExecutor: executor });
}
function approval(mode: 'inline' | 'deferred' | 'workflow' = 'deferred') {
  return manager.createRequest({ agentId: 'fixture', agentName: 'Fixture', toolName: 'fixture_tool', toolArguments: { secret: 'never serialize me' },
    actionCategory: 'write_data', urgency: 'normal', reason: 'Test approval', context: '', executionMode: mode });
}
function effect(status: WorkflowEffect['status'], approvalId: string | null = null) {
  const flow = createFlow();
  const version = lockVersion(createDraftVersion({ flowId: flow.id, displayName: 'Fixture', trigger: { name: 'trigger', type: 'EMPTY' } }).id);
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
  const record: WorkflowEffect = { id: crypto.randomUUID(), runId: run.id, projectId: run.projectId, flowId: flow.id, versionId: version.id,
    versionDigest: 'fixture', stepName: 'fixture', executionPath: [], route: 'fixture', toolName: 'fixture_tool', actionCategory: 'write_data',
    requestDigest: 'fixture', arguments: { secret: 'never serialize me' }, target: {}, provenance: {}, decision: 'approval_required', reason: 'fixture',
    status, approvalId, waitpointId: null, createdAt: Date.now() };
  saveWorkflowEffect(record);
  return { record, flow, version, run };
}
const read = async (limit = 100) => (await queue.read({ limit })).data;

test('prior-day work survives reload; intent acceptance is not permission or verified success', async () => {
  const work = createWorkItem({ title: 'Yesterday still needs a decision' });
  getDb().run('UPDATE commitments SET created_at = ? WHERE id = ?', [Date.now() - 3 * 86_400_000, work.id]);
  const item = (await read()).items[0]!;
  expect(item).toMatchObject({ decisionId: `work:${work.id}`, state: 'proposed', approval: null, workStatus: 'proposed' });
  expect(item.supportedActions).toEqual(['accept_intent', 'reject_intent', 'inspect']);
  const accepted = await queue.resolve(item.decisionId, { revision: item.revision, action: 'accept_intent', reason: 'I want this done' });
  expect(accepted).toMatchObject({ state: 'ready', approval: null, workStatus: 'ready' });
  expect(accepted.actions).toEqual(['inspect']); expect(calls).toBe(0);
  const id = getWorkItem(work.id).decision!.id;
  await expect(queue.resolve(item.decisionId, { revision: item.revision, action: 'accept_intent', reason: 'I want this done' })).rejects.toMatchObject({ status: 409 });
  closeDb(); initWorkflowDb(file); wire();
  expect(queue.get(item.decisionId)).toEqual(accepted);
  expect(getWorkItem(work.id).decision!.id).toBe(id);
  expect((await read()).items).toHaveLength(1);
});

test('approval, effect detail and run detail share one identity; no duplicate blocked work card', async () => {
  const a = approval('workflow'); const e = effect('pending', a.id);
  const work = createWorkItem({ title: 'Run with approval', mode: 'workflow', workflowId: e.flow.id, workflowVersionId: e.version.id });
  decideWorkItem(work.id, { outcome: 'accepted', reason: 'Do this' });
  getDb().run('UPDATE commitment_work SET run_id = ? WHERE work_id = ?', [e.run.id, work.id]);
  updateRun(e.run.id, { status: 'PAUSED' });
  const items = (await read()).items; expect(items).toHaveLength(1);
  expect(items[0]!.decisionId).toBe(`approval:${a.id}`);
  expect(items[0]!.refs).toContainEqual({ kind: 'work_item', id: work.id });
  expect(queue.get(`effect:${e.record.id}`)).toEqual(items[0]!);
  expect((await queue.read({ runId: e.run.id })).data.items).toEqual(items);
  expect((await queue.read({ runId: 'other' })).data.items).toEqual([]);
  const accepted = await queue.resolve(items[0]!.decisionId, { revision: items[0]!.revision, action: 'approve_permission' });
  expect(accepted.approval?.status).toBe('approved'); expect(accepted.state).toBe('awaiting_execution');
  expect(calls).toBe(0); expect(accepted.supportedActions).toEqual(['inspect']);
  saveWorkflowEffect({ ...e.record, status: 'unknown' });
  updateRun(e.run.id, { status: 'SUCCEEDED' });
  expect(queue.get(accepted.decisionId).state).toBe('unknown');
  expect(queue.get(`work:${work.id}`).state).toBe('unknown');
  expect((await read()).items).toHaveLength(1);
});

test.each(['unknown', 'blocked', 'failed'] as const)('%s receipt cannot be hidden by a verified work result', async status => {
  const e = effect(status);
  const work = createWorkItem({ title: 'Checked elsewhere', mode: 'workflow', workflowId: e.flow.id, workflowVersionId: e.version.id });
  decideWorkItem(work.id, { outcome: 'accepted', reason: 'Do it' });
  getDb().run('UPDATE commitment_work SET run_id = ? WHERE work_id = ?', [e.run.id, work.id]);
  updateRun(e.run.id, { status: 'SUCCEEDED' });
  checkWorkResult(work.id, { verdict: 'passed', summary: 'Legacy user check', evidence: [{ ref: 'fixture', description: 'fixture' }] });
  const projected = queue.get(`work:${work.id}`);
  expect(projected.state).toBe(status); expect(projected.workStatus).toBe('verified');
  expect(projected.supportedActions).toEqual(['inspect']);
  const items = (await read()).items;
  expect(items).toHaveLength(1); expect(items[0]!.state).toBe(status);
});

test('concurrent permission submissions call the existing executor only once; lost response reconciles by ID', async () => {
  const a = approval(); const before = queue.get(`approval:${a.id}`);
  const payload = { revision: before.revision, action: 'approve_permission' as const };
  const outcomes = await Promise.allSettled([queue.resolve(before.decisionId, payload), queue.resolve(before.decisionId, payload)]);
  expect(outcomes.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect(calls).toBe(1);
  const current = queue.get(before.decisionId);
  expect(current).toMatchObject({ state: 'committed', approval: { status: 'executed', executionOutcome: 'committed' } });
  expect(current.workStatus).toBeNull(); expect(current.supportedActions).toEqual(['inspect']);
  expect((await read()).items).toHaveLength(0);
  expect(JSON.stringify(current)).not.toContain('never serialize me');
  closeDb(); initWorkflowDb(file); wire();
  expect(queue.get(before.decisionId)).toEqual(current);
});

test('restart uncertainty can only close; not-started can run once through the existing claim', async () => {
  const interrupted = approval(), untouched = approval();
  manager.approve(interrupted.id, 'fixture'); manager.claimExecution(interrupted.id, 'fixture');
  manager.approve(untouched.id, 'fixture');
  new ApprovalManager('next-boot').reconcileAfterRestart();
  const unknown = queue.get(`approval:${interrupted.id}`), notStarted = queue.get(`approval:${untouched.id}`);
  expect(unknown.supportedActions).toEqual(['close_without_running', 'inspect']);
  await expect(queue.resolve(unknown.decisionId, { revision: unknown.revision, action: 'execute_once' })).rejects.toMatchObject({ status: 409 });
  expect((await queue.resolve(unknown.decisionId, { revision: unknown.revision, action: 'close_without_running', note: 'Checked externally' })).state).toBe('closed');
  const result = await queue.resolve(notStarted.decisionId, { revision: notStarted.revision, action: 'execute_once' });
  expect(result.state).toBe('committed'); expect(calls).toBe(1);
  expect((await read()).items).toHaveLength(0);
});

test('failed/blocked receipts and legacy executed-without-receipt remain attention items', async () => {
  for (const outcome of ['failed', 'blocked', null] as const) {
    const a = approval(); manager.approve(a.id, 'fixture'); manager.markExecuted(a.id, 'Fixture refusal', 'failed');
    getDb().run('UPDATE approval_requests SET execution_outcome = ? WHERE id = ?', [outcome, a.id]);
    const item = queue.get(`approval:${a.id}`);
    expect(item.state).toBe(outcome ?? 'unknown'); expect(item.supportedActions).toEqual(['inspect']);
  }
  expect((await read()).items).toHaveLength(3);
});

test('bounded references still detect unknown beyond the first fifty effects', () => {
  const a = approval('workflow'), e = effect('succeeded', a.id);
  for (let n = 0; n < 51; n++) saveWorkflowEffect({ ...e.record, id: `effect-${String(n).padStart(3, '0')}`, status: n === 50 ? 'unknown' : 'succeeded' });
  const item = queue.get(`approval:${a.id}`);
  expect(item.state).toBe('unknown'); expect(item.relatedTruncated).toBe(true);
  expect(item.refs.filter(ref => ref.kind === 'effect')).toHaveLength(50);
  expect(item.supportedActions).toEqual(['inspect']);
});

test('placement persists, equal-time pagination is bounded and stable across restart', async () => {
  for (let n = 0; n < 205; n++) createWorkItem({ title: `Work ${n}` });
  getDb().run('UPDATE commitments SET created_at = 1000');
  const first = (await read()).items[0]!;
  const placed = queue.place(first.decisionId, first.revision, 10);
  await expect(queue.resolve(first.decisionId, { revision: first.revision, action: 'reject_intent', reason: 'stale' })).rejects.toMatchObject({ status: 409 });
  const page1 = await queue.read({ limit: 100 }); expect(page1.data.items).toHaveLength(100);
  expect(page1.data.items.map(item => item.decisionId)).not.toContain(placed.decisionId);
  closeDb(); initWorkflowDb(file); wire();
  expect(queue.get(placed.decisionId).placement).toBe(10);
  const page2 = await queue.read({ limit: 100, cursor: page1.data.nextCursor! });
  const page3 = await queue.read({ limit: 100, cursor: page2.data.nextCursor! });
  expect(page3.data.items).toHaveLength(5); expect(page3.data.nextCursor).toBeNull();
  const all = [...page1.data.items, ...page2.data.items, ...page3.data.items];
  expect(new Set(all.map(item => item.decisionId)).size).toBe(205);
  expect(all.at(-1)!.decisionId).toBe(placed.decisionId);
});

test.each(['insert', 'reorder', 'legacy-write', 'delete'] as const)('cursor explicitly conflicts after %s instead of skipping or repeating a decision', async mutation => {
  const a = approval('inline'); createWorkItem({ title: 'Second' });
  const page = await queue.read({ limit: 1 }); expect(page.data.nextCursor).not.toBeNull();
  if (mutation === 'insert') createWorkItem({ title: 'New' });
  if (mutation === 'reorder') { const item = queue.get(`approval:${a.id}`); queue.place(item.decisionId, item.revision, -10); }
  if (mutation === 'legacy-write') manager.deny(a.id, 'legacy');
  if (mutation === 'delete') getDb().run('DELETE FROM approval_requests WHERE id = ?', [a.id]);
  await expect(queue.read({ cursor: page.data.nextCursor! })).rejects.toMatchObject({ status: 409, code: 'queue_changed' });
});

test('query validation, cursor scope, source revisions and replaced database fail closed', async () => {
  const a = approval('inline'); createWorkItem({ title: 'Second' });
  const page = await queue.read({ limit: 1 });
  for (const limit of [0, -1, 101, 1.5, NaN]) await expect(queue.read({ limit })).rejects.toMatchObject({ status: 400 });
  for (const cursor of ['', '%%%','e30']) await expect(queue.read({ cursor })).rejects.toMatchObject({ status: 400 });
  await expect(queue.read({ cursor: page.data.nextCursor!, runId: 'different' })).rejects.toMatchObject({ status: 400 });
  const original = queue.get(`approval:${a.id}`);
  manager.demoteToDeferred(a.id);
  await expect(queue.resolve(original.decisionId, { revision: original.revision, action: 'approve_permission' })).rejects.toMatchObject({ status: 409 });
  expect(calls).toBe(0);
  closeDb(); initWorkflowDb(':memory:');
  expect(queue.readiness()).toBe('unavailable');
  await expect(queue.read()).rejects.toMatchObject({ status: 503 });
});

test('approval and execution claim are durable before the tool is dispatched', async () => {
  const a = approval();
  const observer = new Database(file, { readonly: true });
  let observed: unknown;
  executor.setToolRegistry({ get: () => undefined, execute: async () => {
    observed = observer.query('SELECT status, execution_claimed_at FROM approval_requests WHERE id = ?').get(a.id);
    return 'fixture result';
  } } as unknown as ToolRegistry);
  try {
    const item = queue.get(`approval:${a.id}`);
    await queue.resolve(item.decisionId, { revision: item.revision, action: 'approve_permission' });
    expect(observed).toMatchObject({ status: 'approved', execution_claimed_at: expect.any(Number) });
  } finally { observer.close(); }
});

test('permission revision is checked again at the actual writer, before any dispatch', async () => {
  const a = approval(); const item = queue.get(`approval:${a.id}`);
  // A concurrent legacy edit is represented between surface read and the writer.
  const raced = new DecisionQueue(getDb(), { approvalManager: manager, deferredExecutor: executor });
  const originalGet = manager.getRequest.bind(manager); let reads = 0;
  manager.getRequest = id => {
    const value = originalGet(id);
    if (id === a.id && ++reads === 2) getDb().run('UPDATE approval_requests SET reason = ? WHERE id = ?', ['Changed scope', id]);
    return value;
  };
  await expect(raced.resolve(item.decisionId, { revision: item.revision, action: 'approve_permission' })).rejects.toMatchObject({ status: 409 });
  expect(originalGet(a.id)?.status).toBe('pending'); expect(calls).toBe(0);
});
