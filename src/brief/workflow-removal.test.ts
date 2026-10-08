import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb, DEFAULT_IDS } from '../workflows/db';
import { createSchema } from '../workflows/db/schema';
import { createFlow, getFlow, listFlows, updateFlowStatus, setPublishedVersion, deleteFlow } from '../workflows/db/repos/flow';
import { createDraftVersion, getFlowVersion, getLatestDraft, mergeRunOutputsIntoSampleData, updateDraftVersion, lockVersion } from '../workflows/db/repos/flow-version';
import { createFlowRun, getFlowRun, updateRun } from '../workflows/db/repos/flow-run';
import { enqueue, queueStats } from '../workflows/db/repos/job-queue';
import { createRunFlowHandler, RUN_FLOW } from '../workflows/runner/handler';
import { Worker } from '../workflows/queue/worker';
import { createWorkflowRoutes } from '../workflows/api/routes';
import { WorkflowRemoval, WORKFLOW_REMOVAL_LIMITS } from './workflow-removal';
import type { WorkflowManageCommand } from './workflow-removal-contracts';

let dir: string, file: string, service: WorkflowRemoval, clock: number, saved: string | undefined;
const runtime = { refresh: async (_flowId: string) => {} };
beforeEach(() => {
  saved = process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL; process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL = '1';
  dir = mkdtempSync(join(tmpdir(), 'jarvis-f20-')); file = join(dir, 'vault.db'); initWorkflowDb(file);
  clock = Date.now(); service = new WorkflowRemoval(getWorkflowDb(), DEFAULT_IDS.project, () => clock); service.start(runtime);
});
afterEach(() => { service.stop(); closeWorkflowDb(); rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL; else process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL = saved; });
function fixture(name = 'Workflow') {
  const flow = createFlow(), version = createDraftVersion({ flowId: flow.id, displayName: name, trigger: { name: 'trigger', type: 'EMPTY', settings: {} } });
  return { flow, version };
}
function command(flowId: string, action: WorkflowManageCommand['action'] = 'remove', extra: Partial<WorkflowManageCommand> = {}): WorkflowManageCommand {
  const item = service.read().data.items.find(i => i.flowId === flowId)!;
  return { scopeId: DEFAULT_IDS.project, flowId, versionId: item.versionId, expectedRevision: item.revision,
    requestId: crypto.randomUUID(), action, ...extra };
}
function remove(flowId: string) {
  const c = command(flowId), result = service.change(c);
  if (result.status !== 'accepted' || !result.receipt) throw Error('remove failed');
  return { c, result, restore: { ...c, action: 'restore' as const, requestId: crypto.randomUUID(), receiptId: result.receipt.receiptId } };
}
function restart() { service.stop(); closeWorkflowDb(); initWorkflowDb(file);
  service = new WorkflowRemoval(getWorkflowDb(), DEFAULT_IDS.project, () => clock); service.start(runtime); }

test('remove, reload and reverse-order Undo retain exact identities, history and original slots paused', () => {
  const a = fixture('A'), b = fixture('B'), c = fixture('C');
  lockVersion(b.version.id); setPublishedVersion(b.flow.id, b.version.id); updateFlowStatus(b.flow.id, 'ENABLED');
  const run = createFlowRun({ flowId: b.flow.id, flowVersionId: b.version.id, status: 'SUCCEEDED' });
  const order = service.read().data.items.map(i => i.flowId);
  const rb = remove(b.flow.id), ra = remove(a.flow.id);
  expect(listFlows().map(f => f.id)).toEqual([c.flow.id]);
  expect(getFlow(b.flow.id)?.status).toBe('DISABLED'); expect(getFlowVersion(b.version.id)?.state).toBe('LOCKED');
  restart(); expect(service.request(rb.c.requestId)).toEqual(rb.result);
  expect(service.read().data.removals).toHaveLength(2);
  expect(service.change(ra.restore)).toMatchObject({ status: 'accepted', item: { flowId: a.flow.id, versionId: a.version.id, activation: 'DISABLED' } });
  expect(service.change(rb.restore)).toMatchObject({ status: 'accepted', item: { flowId: b.flow.id, versionId: b.version.id, activation: 'DISABLED' } });
  expect(service.read().data.items.map(i => i.flowId)).toEqual(order);
  expect(getFlow(b.flow.id)?.published_version_id).toBe(b.version.id); expect(getFlowRun(run.id)?.status).toBe('SUCCEEDED');
  expect(queueStats().queued).toBe(0);
});
test('only later explicit enable changes restored activation, using canonical readiness', () => {
  const { flow } = fixture(); const r = remove(flow.id); service.change(r.restore);
  expect(service.change(command(flow.id, 'activation', { activation: 'ENABLED' }))).toMatchObject({ status: 'accepted', item: { activation: 'ENABLED' } });
  const empty = createFlow(); const c = command(empty.id, 'activation', { activation: 'ENABLED' });
  expect(service.change(c)).toMatchObject({ status: 'rejected', code: 'not_ready' }); expect(getFlow(empty.id)?.status).toBe('DISABLED');
  expect(service.request(c.requestId)).toEqual(service.change(c));
});
test('complete stable collection includes more than the legacy first page and refuses overflow', () => {
  for (let i = 0; i < 101; i++) createFlow();
  expect(service.read().data.items).toHaveLength(101);
  getWorkflowDb().transaction(() => { for (let i = 101; i <= WORKFLOW_REMOVAL_LIMITS.flows; i++) createFlow(); })();
  expect(() => service.read()).toThrow('capacity_exceeded');
});
test('new workflows keep their new slot while Undo returns removed workflows to the same neighbors', () => {
  const a = fixture('A'), b = fixture('B'), c = fixture('C'), r = remove(b.flow.id), d = fixture('D');
  service.change(r.restore);
  expect(service.read().data.items.map(i => i.flowId)).toEqual([d.flow.id, c.flow.id, b.flow.id, a.flow.id]);
});
test('expired receipt cannot restore, including after restart; no hard purge is performed', () => {
  const { flow, version } = fixture(), r = remove(flow.id); clock = r.result.receipt!.expiresAt; restart();
  expect(service.read().data.removals[0]?.undoAvailable).toBe(false);
  expect(service.change(r.restore)).toMatchObject({ status: 'rejected', code: 'undo_expired' });
  expect(getFlowVersion(version.id)?.id).toBe(version.id); expect(listFlows()).toEqual([]);
  expect(() => deleteFlow(flow.id)).toThrow('workflow_history_retained');
});
test('request retries are durable and an old receipt cannot undo a later removal', () => {
  const { flow } = fixture(), r = remove(flow.id);
  expect(service.change(r.c)).toEqual(r.result);
  const restored = service.change(r.restore); expect(service.change(r.restore)).toEqual(restored);
  const next = remove(flow.id);
  expect(service.change({ ...r.restore, requestId: 'stale-receipt' })).toMatchObject({ status: 'rejected', code: 'receipt_conflict' });
  expect(service.change(r.restore)).toEqual(restored); expect(service.read().data.items).toEqual([]);
  expect(next.result.receipt!.receiptId).not.toBe(r.result.receipt!.receiptId);
  expect(() => service.change({ ...r.c, expectedRevision: '0'.repeat(64) })).toThrow('request_conflict');
});
test('scope, version and revision checks prevent cross-owner or stale mutations', () => {
  const { flow, version } = fixture(), c = command(flow.id), foreign = createFlow({ projectId: 'foreign' });
  for (const input of [{ ...c, scopeId: 'foreign' }, { ...c, flowId: foreign.id }]) expect(() => service.change(input)).toThrow('not_found');
  expect(() => service.request('unknown-request')).toThrow('not_found');
  expect(service.change({ ...c, versionId: 'wrong' })).toMatchObject({ status: 'rejected', code: 'revision_conflict' });
  updateDraftVersion(version.id, { displayName: 'Edited' });
  expect(service.change({ ...c, requestId: 'stale-revision' })).toMatchObject({ status: 'rejected', code: 'revision_conflict' });
  expect(getFlow(flow.id)).not.toBeNull(); expect(service.read().data.removals).toEqual([]);
});
test('a storage failure rolls back status, receipt, generation and command atomically', () => {
  const { flow } = fixture(); updateFlowStatus(flow.id, 'ENABLED'); const c = command(flow.id);
  getWorkflowDb().run("CREATE TRIGGER fail_command BEFORE INSERT ON brief_workflow_commands BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  expect(() => service.change(c)).toThrow('fixture failure');
  expect(getFlow(flow.id)?.status).toBe('ENABLED'); expect(service.read().data.removals).toEqual([]);
  expect(getWorkflowDb().query('SELECT generation FROM brief_workflow_slots WHERE flow_id = ?').get(flow.id)).toEqual({ generation: 0 });
  expect(getWorkflowDb().query('SELECT COUNT(*) AS n FROM brief_workflow_removals').get()).toEqual({ n: 0 });
});
test('legacy writers and another SQLite connection cannot re-enable, edit, purge or start a removed flow', async () => {
  const { flow, version } = fixture(), r = remove(flow.id), db = new Database(file);
  try {
    for (const sql of ["UPDATE flow SET status = 'ENABLED' WHERE id = ?", 'DELETE FROM flow WHERE id = ?']) expect(() => db.run(sql, [flow.id])).toThrow();
    expect(() => updateDraftVersion(version.id, { displayName: 'Changed while removed' })).toThrow('workflow_removed');
    expect(() => createDraftVersion({ flowId: flow.id, displayName: 'new' })).toThrow('workflow_removed');
    expect(() => createFlowRun({ flowId: flow.id, flowVersionId: version.id })).toThrow('workflow_removed');
    const request = (method: string, body?: unknown) => Object.assign(new Request('http://localhost/api/workflows/' + flow.id, { method,
      ...(body ? { body: JSON.stringify(body) } : {}) }), { params: { id: flow.id } });
    const routes = createWorkflowRoutes();
    expect((await routes['/api/workflows/:id']!.DELETE!(request('DELETE'))).status).toBe(409);
    expect((await routes['/api/workflows/:id']!.PATCH!(request('PATCH', { status: 'ENABLED' }))).status).toBe(409);
    expect((await routes['/api/workflows/:id/run']!.POST!(request('POST', {}))).status).toBe(409);
    service.change(r.restore);
    expect(() => deleteFlow(flow.id)).toThrow('workflow_history_retained');
    expect(() => db.run('DELETE FROM flow_version WHERE id = ?', [version.id])).toThrow('workflow_history_retained');
  } finally { db.close(); }
});
test('in-flight work stays visible and finishes once; Undo neither cancels nor replays it', async () => {
  const { flow, version } = fixture(), run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
  enqueue({ jobType: RUN_FLOW, payload: { runId: run.id }, flowId: flow.id, flowVersionId: version.id, flowRunId: run.id });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let effects = 0;
  const worker = new Worker({ log: () => {}, handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: { async execute() {
    effects++; entered.resolve(); await release.promise; return { steps: { action: { output: 'retained result' } }, stepsCount: 1 };
  } } }) } });
  const drain = worker.drain(); await entered.promise;
  const r = remove(flow.id);
  expect(service.read().data.removals[0]?.runs).toEqual([{ runId: run.id, status: 'RUNNING' }]);
  expect(service.change(r.restore)).toMatchObject({ status: 'accepted', item: { activation: 'DISABLED' } });
  release.resolve(); await drain;
  expect(getFlowRun(run.id)).toMatchObject({ status: 'SUCCEEDED', steps: { action: { output: 'retained result' } } });
  expect(await worker.drain()).toBe(0); expect(effects).toBe(1); expect(queueStats().succeeded).toBe(1);
});
test('already queued work may finish after removal, without admitting new runs', async () => {
  const { flow, version } = fixture(), run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
  enqueue({ jobType: RUN_FLOW, payload: { runId: run.id }, flowId: flow.id, flowVersionId: version.id, flowRunId: run.id });
  remove(flow.id); expect(service.read().data.removals[0]?.runs[0]?.status).toBe('QUEUED');
  const worker = new Worker({ log: () => {}, handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: {
    async execute() { return { steps: {}, stepsCount: 0 }; },
  } }) } });
  await worker.drain(); expect(getFlowRun(run.id)?.status).toBe('SUCCEEDED');
  expect(() => createFlowRun({ flowId: flow.id, flowVersionId: version.id })).toThrow('workflow_removed');
});
test('reconciliation survives restart and flag rollback without changing a recovered command', async () => {
  service.stop(); let attempts = 0;
  service.start({ refresh: async () => { attempts++; throw Error('offline'); } });
  const { flow, version } = fixture(), r = remove(flow.id); await service.reconcileFlow(flow.id);
  expect(service.read().data.removals[0]?.registration).toBe('pending'); const before = service.request(r.c.requestId);
  delete process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL; service.stop(); closeWorkflowDb(); initWorkflowDb(file);
  service = new WorkflowRemoval(getWorkflowDb()); service.start({ refresh: async () => { attempts++; } });
  await service.reconcileFlow(flow.id);
  expect(service.readiness()).toBe('unavailable');
  expect(getWorkflowDb().query('SELECT reconcile_pending FROM brief_workflow_slots WHERE flow_id = ?').get(flow.id)).toEqual({ reconcile_pending: 0 });
  expect(() => createFlowRun({ flowId: flow.id, flowVersionId: version.id })).toThrow('workflow_removed');
  process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL = '1'; expect(service.request(r.c.requestId)).toEqual(before); expect(attempts).toBeGreaterThanOrEqual(2);
});
test('old schema initializes stable slots once and reinitialization preserves a removal', () => {
  const a = fixture('A'), b = fixture('B');
  getWorkflowDb().run('DELETE FROM brief_workflow_slots'); createSchema(getWorkflowDb());
  const order = service.read().data.slots; const r = remove(a.flow.id);
  createSchema(getWorkflowDb()); expect(service.read().data.slots).toEqual(order);
  expect(service.change(r.restore)).toMatchObject({ status: 'accepted' });
  expect(service.read().data.items.map(i => i.flowId)).toEqual(order.map(i => i.flowId)); expect(getFlow(b.flow.id)).not.toBeNull();
});
test('capacity failure preserves the chosen workflow and never evicts previous receipts', () => {
  const { flow } = fixture(), c = command(flow.id);
  getWorkflowDb().transaction(() => { for (let i = 0; i < WORKFLOW_REMOVAL_LIMITS.commands; i++) getWorkflowDb().run(
    'INSERT INTO brief_workflow_commands VALUES (?, ?, ?, ?, ?, ?)', [DEFAULT_IDS.project, `request-${i}`, flow.id, 'digest', '{}', clock]); })();
  expect(() => service.change(c)).toThrow('capacity_exceeded'); expect(service.read().data.items).toHaveLength(1);
});

test('replacing a stalled trigger runtime retries durable reconciliation with the new runtime', async () => {
  service.start({ refresh: () => new Promise(() => {}) });
  const { flow } = fixture(); remove(flow.id); await Promise.resolve();
  let retries = 0; service.start({ refresh: async () => { retries++; } });
  await service.reconcileFlow(flow.id);
  expect(retries).toBe(1); expect(service.read().data.removals[0]?.registration).toBe('reconciled');
});

test('management readiness reports missing CODE permission before explicit Enable', () => {
  const { flow, version } = fixture();
  updateDraftVersion(version.id, { trigger: { name: 'trigger', type: 'EMPTY', settings: {}, nextAction: {
    name: 'compute', type: 'CODE', settings: { sourceCode: { packageJson: '{}', code: 'export const code = async () => ({});' } },
  } } });
  const item = service.read().data.items[0]!;
  expect(item.readiness).toMatchObject({ state: 'blocked' });
  expect(service.change(command(flow.id, 'activation', { activation: 'ENABLED' }))).toMatchObject({ status: 'rejected', code: 'not_ready' });
  expect(getFlow(flow.id)?.status).toBe('DISABLED');
  getWorkflowDb().run('UPDATE flow SET code_steps_enabled = 1 WHERE id = ?', [flow.id]);
  expect(service.read().data.items[0]!.readiness.state).toBe('ready');
  expect(service.change(command(flow.id, 'activation', { activation: 'ENABLED' }))).toMatchObject({ status: 'accepted' });
});

function fillCommands(count: number, flowId: string) {
  getWorkflowDb().transaction(() => { for (let i = 0; i < count; i++) getWorkflowDb().run(
    'INSERT INTO brief_workflow_commands VALUES (?, ?, ?, ?, ?, ?)', [DEFAULT_IDS.project, `filler-${i}`, flowId, 'digest', '{}', clock]); })();
}
test('R2: the last ordinary command can remove and still Undo once at capacity after restart', () => {
  const { flow } = fixture(); fillCommands(WORKFLOW_REMOVAL_LIMITS.commands - 1, flow.id);
  const r = remove(flow.id); restart();
  const restored = service.change(r.restore);
  expect(restored).toMatchObject({ status: 'accepted', item: { activation: 'DISABLED' } });
  expect(service.change(r.restore)).toEqual(restored);
  expect(service.request(r.restore.requestId)).toEqual(restored);
  expect(getWorkflowDb().query('SELECT COUNT(*) AS n FROM brief_workflow_commands').get()).toEqual({ n: WORKFLOW_REMOVAL_LIMITS.commands + 1 });
  expect(() => service.change(command(flow.id))).toThrow('capacity_exceeded');
  expect(service.read().data.items).toHaveLength(1);
  expect(() => service.change({ ...r.restore, requestId: 'second-restore' })).toThrow('capacity_exceeded');
});
test('R2: invalid Undo cannot use receipt-reserved capacity or mutate the removal', () => {
  const { flow } = fixture(); fillCommands(WORKFLOW_REMOVAL_LIMITS.commands - 1, flow.id);
  const r = remove(flow.id);
  expect(() => service.change({ ...r.restore, receiptId: 'wrong-receipt' })).toThrow('capacity_exceeded');
  expect(service.read().data.removals).toHaveLength(1);
  expect(service.change(r.restore)).toMatchObject({ status: 'accepted' });
});
function twoDrafts() {
  const { flow, version: old } = fixture('Older');
  getWorkflowDb().run('UPDATE flow_version SET updated = 1 WHERE id = ?', [old.id]);
  const selected = createDraftVersion({ flowId: flow.id, displayName: 'Selected', trigger: { name: 'trigger', type: 'EMPTY', settings: {} } });
  getWorkflowDb().run('UPDATE flow_version SET updated = 2 WHERE id = ?', [selected.id]);
  return { flow, old, selected };
}
test('R4: a real older draft run finishing while removed cannot change the receipt version', async () => {
  const { flow, old, selected } = twoDrafts();
  const run = createFlowRun({ flowId: flow.id, flowVersionId: old.id });
  enqueue({ jobType: RUN_FLOW, payload: { runId: run.id }, flowId: flow.id, flowVersionId: old.id, flowRunId: run.id });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const worker = new Worker({ log: () => {}, handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: { async execute() {
    entered.resolve(); await release.promise; return { steps: { action: { output: { captured: true } } }, stepsCount: 1 };
  } } }) } });
  const drain = worker.drain(); await entered.promise;
  const r = remove(flow.id); expect(r.result.receipt!.versionId).toBe(selected.id);
  release.resolve(); await drain; expect(getFlowRun(run.id)?.status).toBe('SUCCEEDED');
  expect(getFlowVersion(old.id)?.sampleData).toEqual({ action: { captured: true } });
  restart(); expect(service.read().data.removals[0]?.item.versionId).toBe(selected.id);
  expect(service.change(r.restore)).toMatchObject({ status: 'accepted', item: { versionId: selected.id, activation: 'DISABLED' } });
  expect(getLatestDraft(flow.id)?.id).toBe(selected.id);
});
test('R4: late bookkeeping after Undo keeps the selected draft; explicit authoring selects a new draft', () => {
  const { flow, old, selected } = twoDrafts(), r = remove(flow.id); service.change(r.restore);
  mergeRunOutputsIntoSampleData(old.id, { action: { output: { late: true } } });
  expect(getLatestDraft(flow.id)?.id).toBe(selected.id);
  expect(service.read().data.items[0]?.versionId).toBe(selected.id);
  updateDraftVersion(old.id, { displayName: 'Explicit edit' });
  expect(getLatestDraft(flow.id)?.id).toBe(old.id);
  const next = createDraftVersion({ flowId: flow.id, displayName: 'New draft', trigger: { name: 'trigger', type: 'EMPTY', settings: {} } });
  getWorkflowDb().run('UPDATE flow_version SET updated = updated + 1 WHERE id = ?', [next.id]);
  expect(getLatestDraft(flow.id)?.id).toBe(next.id);
});

test('R1: management projections never expose trigger inputs, sample data or run outputs', () => {
  const secret = 'private-fixture-payload-<<<UNTRUSTED_CONTENT>>>', flow = createFlow({ metadata: { private: secret } });
  const version = createDraftVersion({ flowId: flow.id, displayName: 'Public name', trigger: {
    name: 'trigger', type: 'EMPTY', settings: { input: { credential: secret } },
  } });
  mergeRunOutputsIntoSampleData(version.id, { action: { output: { body: secret } } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'SUCCEEDED' });
  updateRun(run.id, { steps: { action: { output: secret } } });
  expect(service.read().data.items[0]?.latestRun).toEqual({ runId: run.id, label: 'SUCCEEDED' });
  const before = service.read(), r = remove(flow.id), removed = service.read();
  const restored = service.change(r.restore);
  for (const projection of [before, r.result, removed, restored, service.request(r.restore.requestId)]) {
    expect(JSON.stringify(projection)).not.toContain(secret);
    expect(JSON.stringify(projection)).not.toContain('sampleData');
  }
});
test('R4: an existing F20 database upgrades its active receipt to a durable draft pin', () => {
  const { flow, old, selected } = twoDrafts(), r = remove(flow.id), db = getWorkflowDb();
  for (const name of ['brief_draft_pin_insert', 'brief_draft_pin_edit', 'brief_draft_pin_publish']) db.run(`DROP TRIGGER ${name}`);
  db.run('DROP VIEW brief_workflow_draft_selection'); db.run('ALTER TABLE brief_workflow_slots DROP COLUMN pinned_draft_id');
  mergeRunOutputsIntoSampleData(old.id, { action: { output: { old: true } } });
  createSchema(db);
  expect(service.change(r.restore)).toMatchObject({ status: 'accepted', item: { versionId: selected.id } });
  expect(getLatestDraft(flow.id)?.id).toBe(selected.id); expect(getFlowVersion(old.id)?.sampleData).not.toBeNull();
});
test('R4: explicit Enable checks CODE permission against the pinned draft', () => {
  const { flow, old, selected } = twoDrafts();
  updateDraftVersion(old.id, { trigger: { name: 'trigger', type: 'EMPTY', settings: {}, nextAction: {
    name: 'compute', type: 'CODE', settings: { sourceCode: { packageJson: '{}', code: 'export const code = async () => ({});' } },
  } } });
  getWorkflowDb().run('UPDATE flow_version SET updated = 1 WHERE id = ?', [old.id]);
  const r = remove(flow.id); service.change(r.restore);
  mergeRunOutputsIntoSampleData(old.id, { action: { output: { captured: true } } });
  expect(service.change(command(flow.id, 'activation', { activation: 'ENABLED' })))
    .toMatchObject({ status: 'accepted', item: { versionId: selected.id, activation: 'ENABLED' } });
});
test('R4: an invalid pinned draft cannot borrow readiness from an older runnable version', () => {
  const { flow, old, selected } = twoDrafts(); updateDraftVersion(selected.id, { trigger: {} });
  const r = remove(flow.id); service.change(r.restore);
  mergeRunOutputsIntoSampleData(old.id, { action: { output: { captured: true } } });
  expect(service.change(command(flow.id, 'activation', { activation: 'ENABLED' })))
    .toMatchObject({ status: 'rejected', code: 'not_ready' });
  expect(getFlow(flow.id)?.status).toBe('DISABLED');
});
