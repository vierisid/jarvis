import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb, DEFAULT_IDS } from '../workflows/db';
import { createFlow, getFlow, deleteFlow } from '../workflows/db/repos/flow';
import { createDraftVersion, getFlowVersion } from '../workflows/db/repos/flow-version';
import { createFlowRun, getFlowRun, updateRun } from '../workflows/db/repos/flow-run';
import { enqueue, getJob } from '../workflows/db/repos/job-queue';
import { createWaitpoint } from '../workflows/db/repos/waitpoint';
import { getRunCancellation } from '../workflows/db/repos/run-cancellation';
import { turnedOffReason } from '../workflows/db/repos/flow-turn-off';
import { saveWorkflowEffect, type WorkflowEffect } from '../workflows/db/repos/workflow-effect';
import { createWorkflowRoutes } from '../workflows/api/routes';
import { createManageWorkflowTool } from '../actions/tools/manage-workflow';
import { WorkflowRemoval, WORKFLOW_REMOVAL_LIMITS } from './workflow-removal';
import type { WorkflowManageCommand, WorkflowPurgeCommand } from './workflow-removal-contracts';

let dir: string, file: string, service: WorkflowRemoval, clock: number, saved: string | undefined, savedData: string | undefined, closed: string[];
const runtime = { refreshed: [] as string[], refresh: async (flowId: string) => { runtime.refreshed.push(flowId); } };
const purge = (raw: unknown) => service.purge(raw, 'dashboard:test-device');
function start() {
  service = new WorkflowRemoval(getWorkflowDb(), DEFAULT_IDS.project, () => clock);
  service.start(runtime, { onCardClosed: id => closed.push(id) });
}
beforeEach(() => {
  saved = process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL; process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL = '1';
  dir = mkdtempSync(join(tmpdir(), 'jarvis-purge-')); file = join(dir, 'vault.db'); initWorkflowDb(file);
  savedData = process.env.JARVIS_WORKFLOW_DATA_DIR; process.env.JARVIS_WORKFLOW_DATA_DIR = join(dir, 'data');
  clock = Date.now(); closed = []; runtime.refreshed = []; start();
});
afterEach(() => { service.stop(); closeWorkflowDb(); rmSync(dir, { recursive: true, force: true });
  if (savedData === undefined) delete process.env.JARVIS_WORKFLOW_DATA_DIR; else process.env.JARVIS_WORKFLOW_DATA_DIR = savedData;
  if (saved === undefined) delete process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL; else process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL = saved; });

function fixture(name = 'Workflow') {
  const flow = createFlow(), version = createDraftVersion({ flowId: flow.id, displayName: name, trigger: { name: 'trigger', type: 'EMPTY', settings: {} } });
  return { flow, version };
}
function item(flowId: string) {
  const data = service.read().data;
  return data.items.find(i => i.flowId === flowId) ?? data.removals.find(r => r.flowId === flowId)!.item;
}
function command(flowId: string, action: WorkflowManageCommand['action'] = 'remove', extra: Partial<WorkflowManageCommand> = {}): WorkflowManageCommand {
  const current = item(flowId);
  return { scopeId: DEFAULT_IDS.project, flowId, versionId: current.versionId, expectedRevision: current.revision,
    requestId: crypto.randomUUID(), action, ...extra };
}
function purgeCommand(flowId: string, extra: Partial<WorkflowPurgeCommand> = {}): WorkflowPurgeCommand {
  const current = item(flowId);
  return { scopeId: DEFAULT_IDS.project, flowId, versionId: current.versionId, expectedRevision: current.revision,
    requestId: crypto.randomUUID(), ...extra };
}
function remove(flowId: string) {
  const c = command(flowId), result = service.change(c);
  if (result.status !== 'accepted' || !result.receipt) throw Error('remove failed');
  return { c, result, restore: { ...c, action: 'restore' as const, requestId: crypto.randomUUID(), receiptId: result.receipt.receiptId } };
}
/** Removed, then restored with Undo: the state F-20 made undeletable. */
function restored(name?: string) {
  const f = fixture(name), r = remove(f.flow.id);
  if (service.change(r.restore).status !== 'accepted') throw Error('restore failed');
  return { ...f, receiptId: r.result.receipt!.receiptId };
}
/** A live run of each kind, created after the restore so removal did not stop them. */
function liveRuns(flowId: string, versionId: string) {
  const queued = createFlowRun({ flowId, flowVersionId: versionId });
  const job = enqueue({ jobType: 'RUN_FLOW', payload: { runId: queued.id }, flowId, flowVersionId: versionId, flowRunId: queued.id });
  const running = createFlowRun({ flowId, flowVersionId: versionId }); updateRun(running.id, { status: 'RUNNING' });
  const waiting = createFlowRun({ flowId, flowVersionId: versionId }); updateRun(waiting.id, { status: 'PAUSED' });
  return { queued, job, running, waiting };
}
const count = (sql: string, ...args: string[]) => (getWorkflowDb().query(sql).get(...args) as { n: number }).n;
function cardFor(runId: string, flowId: string, versionId: string, status = 'pending') {
  const approvalId = crypto.randomUUID(), now = Date.now();
  getWorkflowDb().run(`INSERT INTO approval_requests (id, agent_id, agent_name, tool_name, tool_arguments, action_category, urgency, reason, context, status, execution_mode, created_at)
    VALUES (?, 'workflow', 'Workflow', 'send_message', '{}', 'send_message', 'normal', 'r', '', ?, 'workflow', ?)`, [approvalId, status, now]);
  const effect: WorkflowEffect = { id: crypto.randomUUID(), runId, projectId: DEFAULT_IDS.project, flowId, versionId, versionDigest: 'd',
    stepName: 'notify', executionPath: [], route: 'notify', toolName: 'send_message', actionCategory: 'send_message', requestDigest: 'r',
    arguments: {}, target: {}, provenance: {}, decision: 'approval_required', reason: 'r', status: 'pending', approvalId, waitpointId: null, createdAt: now };
  saveWorkflowEffect(effect);
  return approvalId;
}
const approvalStatus = (id: string) => (getWorkflowDb().query('SELECT status FROM approval_requests WHERE id = ?').get(id) as { status: string }).status;

test('a restored workflow is purged with its versions, runs and run payloads; its receipts and audit rows stay', () => {
  const { flow, version } = restored(), runs = liveRuns(flow.id, version.id);
  const card = cardFor(runs.waiting.id, flow.id, version.id);
  createWaitpoint({ flowRunId: runs.waiting.id, projectId: DEFAULT_IDS.project, stepName: 'later', type: 'DEFER' });
  const finished = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'SUCCEEDED' });
  const orphanCard = cardFor(finished.id, flow.id, version.id);
  getWorkflowDb().run(`INSERT INTO workflow_file (id, project_id, flow_id, type, data, size, created) VALUES ('file', ?, ?, 'FLOW_RUN_LOG', x'00', 1, 1)`, [DEFAULT_IDS.project, flow.id]);
  getWorkflowDb().run(`INSERT INTO trigger_event (id, flow_id, project_id, payload, created) VALUES ('event', ?, ?, '{"secret":1}', 1)`, [flow.id, DEFAULT_IDS.project]);
  getWorkflowDb().run(`INSERT INTO open_failure (key, source, run_id, flow_id, at) VALUES ('run:x', 'run', ?, ?, 1)`, [finished.id, flow.id]);
  // Payloads beside the database: the engine's state backup and a step file's disk copy.
  const logs = join(dir, 'data', 'workflow-logs'), files = join(dir, 'data', 'workflow-files');
  mkdirSync(logs, { recursive: true }); mkdirSync(join(files, flow.id, 'step'), { recursive: true });
  for (const run of [runs.running, finished]) writeFileSync(join(logs, `${run.id}.bin`), 'state');
  writeFileSync(join(files, flow.id, 'step', 'file__a.txt'), 'data');
  const store = (key: string) => getWorkflowDb().run(`INSERT INTO store_entry (id, project_id, key, value, created, updated) VALUES (?, ?, ?, '1', 1, 1)`,
    [crypto.randomUUID(), DEFAULT_IDS.project, key]);
  store(`flow_${flow.id}/k`); store(`testflow_${flow.id}/k`); store('project-key'); store(`flow_other/k`);
  // Another flow whose id extends this one's is not this flow's.
  store(`flow_${flow.id}x/k`); store(`testflow_${flow.id}x/k`);
  getWorkflowDb().run(`INSERT INTO store_entry (id, project_id, key, value, created, updated) VALUES ('foreign', 'foreign', ?, '1', 1, 1)`, [`flow_${flow.id}/k`]);
  // A queued job left behind for a run that already ended.
  const stale = enqueue({ jobType: 'RUN_FLOW', payload: { runId: finished.id }, flowRunId: finished.id });
  const other = fixture('Other'), otherRun = createFlowRun({ flowId: other.flow.id, flowVersionId: other.version.id });
  mkdirSync(join(files, other.flow.id), { recursive: true }); writeFileSync(join(logs, `${otherRun.id}.bin`), 'state');
  const otherJob = enqueue({ jobType: 'RUN_FLOW', payload: { runId: otherRun.id }, flowId: other.flow.id, flowVersionId: other.version.id, flowRunId: otherRun.id });
  const commandsBefore = count('SELECT COUNT(*) AS n FROM brief_workflow_commands WHERE flow_id = ?', flow.id);

  const c = purgeCommand(flow.id), result = purge(c);
  expect(result).toMatchObject({ status: 'accepted', action: 'purge', flowId: flow.id, requestId: c.requestId, purge: { flowId: flow.id, generation: 1 } });
  expect(getFlow(flow.id)).toBeNull(); expect(getFlowVersion(version.id)).toBeNull();
  for (const run of [runs.queued, runs.running, runs.waiting, finished]) expect(getFlowRun(run.id)).toBeNull();
  expect(getJob(runs.job.id)).toBeNull();
  for (const table of ['workflow_file', 'trigger_event', 'brief_workflow_removals', 'brief_workflow_slots', 'open_failure']) {
    expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE flow_id = ?`, flow.id)).toBe(0);
  }
  expect(count('SELECT COUNT(*) AS n FROM workflow_effect')).toBe(0); expect(count('SELECT COUNT(*) AS n FROM waitpoint')).toBe(0);
  for (const run of [runs.running, finished]) expect(existsSync(join(logs, `${run.id}.bin`))).toBe(false);
  expect(existsSync(join(files, flow.id))).toBe(false);
  expect((getWorkflowDb().query("SELECT project_id || ':' || key AS k FROM store_entry ORDER BY k").all() as Array<{ k: string }>).map(r => r.k))
    .toEqual([`foreign:flow_${flow.id}/k`, `${DEFAULT_IDS.project}:flow_${flow.id}x/k`, `${DEFAULT_IDS.project}:flow_other/k`,
      `${DEFAULT_IDS.project}:project-key`, `${DEFAULT_IDS.project}:testflow_${flow.id}x/k`].sort());
  expect(getJob(stale.id)).toBeNull();
  // Every card of a stopped run, and of a run that ended before it parked, is closed and reported (#1039).
  expect(approvalStatus(card)).toBe('denied'); expect(approvalStatus(orphanCard)).toBe('denied');
  expect(closed.sort()).toEqual([card, orphanCard].sort());
  // The receipt and the audit rows outlive the flow.
  const receipt = getWorkflowDb().query('SELECT * FROM brief_workflow_purges WHERE flow_id = ?').get(flow.id) as Record<string, unknown>;
  expect(receipt).toMatchObject({ actor: 'dashboard:test-device', generation: 1, request_id: c.requestId, granted: 0, accepted_at: clock, completed_at: clock });
  expect(JSON.parse(receipt.counts as string)).toEqual({ versions: 1, runs: 4, removals: 1, triggerEvents: 1, files: 1, jobs: 2, storeEntries: 2 });
  expect(count('SELECT COUNT(*) AS n FROM brief_workflow_commands WHERE flow_id = ?', flow.id)).toBe(commandsBefore + 1);
  expect(count("SELECT COUNT(*) AS n FROM workflow_trigger_fire WHERE flow_id = ? AND outcome = 'stopped'", flow.id)).toBe(3);
  // Another workflow is untouched; the trigger runtime heard the purge.
  expect(getFlowRun(otherRun.id)?.status).toBe('QUEUED'); expect(getFlow(other.flow.id)).not.toBeNull();
  expect(existsSync(join(files, other.flow.id))).toBe(true); expect(getJob(otherJob.id)?.status).toBe('QUEUED'); expect(existsSync(join(logs, `${otherRun.id}.bin`))).toBe(true);
  expect(runtime.refreshed).toContain(flow.id);
});

test('a purge is idempotent: a retry returns the original outcome and request recovery reads it', () => {
  const { flow } = restored(), c = purgeCommand(flow.id), first = purge(c);
  expect(first.status).toBe('accepted');
  expect(purge(c)).toEqual(first); expect(service.request(c.requestId)).toEqual(first);
  expect(count('SELECT COUNT(*) AS n FROM brief_workflow_purges WHERE flow_id = ?', flow.id)).toBe(1);
  expect(() => purge({ ...c, expectedRevision: '0'.repeat(64) })).toThrow('request_conflict');
  // A new request for a workflow that is gone finds nothing to purge.
  expect(() => purge({ ...c, requestId: 'second-purge' })).toThrow('not_found');
});

test('a removed workflow cannot be purged while Undo is available, and the refusal stops nothing', () => {
  const { flow, version } = fixture(), running = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
  updateRun(running.id, { status: 'RUNNING' });
  const r = remove(flow.id), c = purgeCommand(flow.id);
  expect(purge(c)).toMatchObject({ status: 'rejected', code: 'undo_available' });
  expect(service.request(c.requestId)).toMatchObject({ status: 'rejected', code: 'undo_available' });
  expect(getFlowRun(running.id)?.status).toBe('RUNNING'); expect(getRunCancellation(running.id)).toBeNull();
  expect(getFlow(flow.id)).not.toBeNull(); expect(count('SELECT COUNT(*) AS n FROM brief_workflow_purges')).toBe(0);
  // Undo still works afterwards.
  expect(service.change(r.restore)).toMatchObject({ status: 'accepted' });
});

test('a removed workflow whose Undo expired can be purged', () => {
  const { flow, version } = fixture(), r = remove(flow.id);
  clock = r.result.receipt!.expiresAt;
  expect(purge(purgeCommand(flow.id))).toMatchObject({ status: 'accepted' });
  expect(getFlow(flow.id)).toBeNull(); expect(getFlowVersion(version.id)).toBeNull();
});

test('a stale revision or version is refused and stops nothing', () => {
  const { flow, version } = restored(), runs = liveRuns(flow.id, version.id);
  for (const stale of [{ expectedRevision: '0'.repeat(64) }, { versionId: 'other-version' }]) {
    expect(purge(purgeCommand(flow.id, stale))).toMatchObject({ status: 'rejected', code: 'revision_conflict' });
  }
  expect(getFlowRun(runs.queued.id)?.status).toBe('QUEUED'); expect(getJob(runs.job.id)?.status).toBe('QUEUED');
  expect(getFlowRun(runs.running.id)?.status).toBe('RUNNING'); expect(getFlowRun(runs.waiting.id)?.status).toBe('PAUSED');
  for (const run of Object.values(runs)) if ('flowVersionId' in run) expect(getRunCancellation(run.id)).toBeNull();
  expect(getFlow(flow.id)).not.toBeNull();
});

test('a workflow never removed is not purged here; the ordinary delete serves it', () => {
  const { flow } = fixture();
  expect(purge(purgeCommand(flow.id))).toMatchObject({ status: 'rejected', code: 'not_removed' });
  expect(getFlow(flow.id)).not.toBeNull();
});

test('malformed, foreign and missing purge requests are refused before anything is recorded', () => {
  const { flow } = restored(), c = purgeCommand(flow.id), foreign = createFlow({ projectId: 'foreign' });
  for (const bad of [null, [], {}, { ...c, action: 'purge' }, { ...c, receiptId: 'x' }, { ...c, expectedRevision: 'short' }, { ...c, requestId: '../x' }]) {
    expect(() => purge(bad)).toThrow('invalid_command');
  }
  expect(() => purge({ ...c, scopeId: 'foreign' })).toThrow('not_found');
  expect(() => purge({ ...c, flowId: foreign.id })).toThrow('not_found');
  expect(() => purge({ ...c, flowId: 'missing' })).toThrow('not_found');
  expect(getFlow(flow.id)).not.toBeNull(); expect(() => service.request(c.requestId)).toThrow('not_found');
});

test('the purge needs the feature flag and the ready provider', () => {
  const { flow } = restored(); delete process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL;
  expect(() => purge(purgeCommand(flow.id))).toThrow('unavailable');
  process.env.JARVIS_BRIEF_WORKFLOW_REMOVAL = '1'; const c = purgeCommand(flow.id); service.stop();
  expect(() => purge(c)).toThrow('unavailable'); expect(getFlow(flow.id)).not.toBeNull();
});

test('the history fences still abort every delete that does not come from an accepted purge', () => {
  const { flow, version } = restored(), db = new Database(file);
  try {
    // Another connection, with and without foreign keys, and the legacy repo writer.
    for (const sql of ['DELETE FROM brief_workflow_removals WHERE flow_id = ?', 'DELETE FROM flow WHERE id = ?']) {
      expect(() => db.run(sql, [flow.id])).toThrow('workflow_history_retained');
    }
    expect(() => db.run('DELETE FROM flow_version WHERE id = ?', [version.id])).toThrow('workflow_history_retained');
    db.exec('PRAGMA foreign_keys=ON');
    expect(() => db.run('DELETE FROM brief_workflow_removals WHERE flow_id = ?', [flow.id])).toThrow('workflow_history_retained');
    expect(() => deleteFlow(flow.id)).toThrow('workflow_history_retained');
    // A refused purge leaves no grant behind, so the fences stay shut.
    expect(purge(purgeCommand(flow.id, { versionId: 'other-version' }))).toMatchObject({ status: 'rejected' });
    expect(count('SELECT COUNT(*) AS n FROM brief_workflow_purges WHERE granted = 1')).toBe(0);
    expect(() => db.run('DELETE FROM brief_workflow_removals WHERE flow_id = ?', [flow.id])).toThrow('workflow_history_retained');
    expect(getFlow(flow.id)).not.toBeNull();
  } finally { db.close(); }
});

test('the agent paths cannot purge: manage_workflow has no purge action and its delete still refuses', async () => {
  const { flow } = restored(), tool = createManageWorkflowTool();
  const actions = tool.parameters.action!.enum as string[];
  expect(actions).not.toContain('purge');
  await expect(tool.execute({ action: 'delete', flow: flow.id })).rejects.toThrow('workflow_history_retained');
  const request = Object.assign(new Request('http://localhost/api/workflows/' + flow.id, { method: 'DELETE' }), { params: { id: flow.id } });
  expect((await createWorkflowRoutes()['/api/workflows/:id']!.DELETE!(request)).status).toBe(409);
  // The person's purge is what removes it.
  expect(purge(purgeCommand(flow.id))).toMatchObject({ status: 'accepted' }); expect(getFlow(flow.id)).toBeNull();
});

test('an accepted purge interrupted before its delete stays fenced and finishes on recovery', () => {
  const { flow, version } = restored(), runs = liveRuns(flow.id, version.id);
  getWorkflowDb().run(`CREATE TRIGGER fixture_purge_failure BEFORE DELETE ON workflow_file BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
  getWorkflowDb().run(`INSERT INTO workflow_file (id, project_id, flow_id, type, data, size, created) VALUES ('file', ?, ?, 'FLOW_RUN_LOG', x'00', 1, 1)`, [DEFAULT_IDS.project, flow.id]);
  const c = purgeCommand(flow.id), result = purge(c);
  expect(result.status).toBe('accepted');
  // Accepted: its runs are stopped, its delete rolled back whole, and nothing new starts.
  for (const run of [runs.queued, runs.running, runs.waiting]) expect(getFlowRun(run.id)?.status).toBe('STOPPED');
  expect(getFlow(flow.id)?.status).toBe('DISABLED'); expect(count('SELECT COUNT(*) AS n FROM brief_workflow_removals WHERE flow_id = ?', flow.id)).toBe(1);
  expect(count('SELECT COUNT(*) AS n FROM brief_workflow_purges WHERE granted = 1')).toBe(0);
  expect(() => createFlowRun({ flowId: flow.id, flowVersionId: version.id })).toThrow('workflow_purging');
  expect(purge(purgeCommand(flow.id))).toMatchObject({ status: 'rejected', code: 'purge_pending' });
  getWorkflowDb().run('DROP TRIGGER fixture_purge_failure');
  service.stop(); start(); // Boot recovery finishes it.
  expect(getFlow(flow.id)).toBeNull(); expect(purge(c)).toEqual(result);
  expect(getWorkflowDb().query('SELECT completed_at FROM brief_workflow_purges WHERE flow_id = ?').get(flow.id)).toEqual({ completed_at: clock });
});


test('an accepted purge turns the workflow off at once, and owns it until it finishes', () => {
  const { flow, version } = restored(), db = new Database(file);
  getWorkflowDb().run("UPDATE flow SET status = 'ENABLED' WHERE id = ?", [flow.id]);
  const queued = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
  // The crash case: acceptance commits, then nothing after it gets to stop a run.
  getWorkflowDb().run(`CREATE TRIGGER fixture_stop_failure BEFORE INSERT ON workflow_run_cancellation BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
  clock = Math.max(clock, Date.now()) + 1000;
  try {
    expect(purge(purgeCommand(flow.id))).toMatchObject({ status: 'accepted' });
    expect(getFlowRun(queued.id)?.status).toBe('QUEUED');
    // Q-06: the run cannot start or continue even though nothing stopped it yet.
    expect(getFlow(flow.id)?.status).toBe('DISABLED'); expect(turnedOffReason(queued.id)).not.toBeNull();
    // Nothing turns it back on, hands out a new receipt, or deletes its history meanwhile.
    expect(service.change(command(flow.id, 'activation', { activation: 'ENABLED' }))).toMatchObject({ status: 'rejected', code: 'purge_pending' });
    expect(service.change(command(flow.id))).toMatchObject({ status: 'rejected', code: 'purge_pending' });
    expect(() => db.run("UPDATE flow SET status = 'ENABLED' WHERE id = ?", [flow.id])).toThrow('workflow_purging');
    expect(() => db.run('DELETE FROM brief_workflow_removals WHERE flow_id = ?', [flow.id])).toThrow('workflow_history_retained');
  } finally { db.close(); }
  getWorkflowDb().run('DROP TRIGGER fixture_stop_failure');
  service.stop(); start();
  expect(getFlow(flow.id)).toBeNull(); expect(getFlowRun(queued.id)).toBeNull();
});

test('a run set live again after its stop holds the delete until the next pass stops it', () => {
  const { flow, version } = restored(), run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
  getWorkflowDb().run(`CREATE TEMP TRIGGER fixture_revive AFTER UPDATE OF status ON flow_run WHEN NEW.status = 'STOPPED'
    BEGIN UPDATE flow_run SET status = 'RUNNING' WHERE id = NEW.id; END`);
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(purge(purgeCommand(flow.id))).toMatchObject({ status: 'accepted' });
    expect(getFlow(flow.id)).not.toBeNull(); expect(getFlowRun(run.id)?.status).toBe('RUNNING');
    // Held passes say so once and do not re-register triggers each time.
    // Acceptance turned the flow off, so its triggers were unregistered once.
    const refreshes = runtime.refreshed.filter(f => f === flow.id).length; expect(refreshes).toBe(1);
    // Two recovery passes of the same running service (the 5s timer's work).
    const pass = () => (service as unknown as { recover(): void }).recover();
    pass(); pass();
    expect(getFlow(flow.id)).not.toBeNull();
    expect(warn.mock.calls.filter(c => String(c[0]).includes(flow.id))).toHaveLength(1);
    expect(runtime.refreshed.filter(f => f === flow.id)).toHaveLength(refreshes);
  } finally { warn.mockRestore(); }
  getWorkflowDb().run('DROP TRIGGER temp.fixture_revive');
  service.stop(); start();
  expect(getFlow(flow.id)).toBeNull();
});

test('a purge at command capacity is refused whole and stops nothing', () => {
  const { flow, version } = restored(), run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
  // Ordinary outcomes only: the accepted Undo used its receipt's reserved place.
  const used = count(`SELECT COUNT(*) AS n FROM brief_workflow_commands WHERE json_extract(result, '$.action') IS NOT 'restore' OR json_extract(result, '$.status') IS NOT 'accepted'`);
  getWorkflowDb().transaction(() => { for (let i = used; i < WORKFLOW_REMOVAL_LIMITS.commands; i++) getWorkflowDb().run(
    'INSERT INTO brief_workflow_commands VALUES (?, ?, ?, ?, ?, ?)', [DEFAULT_IDS.project, `filler-${i}`, flow.id, 'digest', '{}', clock]); })();
  expect(() => purge(purgeCommand(flow.id))).toThrow('capacity_exceeded');
  expect(getFlow(flow.id)?.status).toBe('DISABLED'); expect(getFlowRun(run.id)?.status).toBe('QUEUED');
  expect(count('SELECT COUNT(*) AS n FROM brief_workflow_purges')).toBe(0);
});

test('recovery finishes only purges the service accepted, and receipts stay put', () => {
  const { flow } = fixture(); remove(flow.id);
  // A pending row nobody accepted (written by another connection) inside the Undo window.
  getWorkflowDb().run(`INSERT INTO brief_workflow_purges (purge_id, flow_id, project_id, request_id, generation, actor, accepted_at)
    VALUES ('planted', ?, ?, 'no-such-request', 1, 'x', 1)`, [flow.id, DEFAULT_IDS.project]);
  // And one that reuses a real accepted purge's request id but is not the receipt it names.
  const done = restored('Done'), accepted = purgeCommand(done.flow.id);
  expect(purge(accepted)).toMatchObject({ status: 'accepted' });
  const second = fixture('Second'); remove(second.flow.id);
  getWorkflowDb().run(`INSERT INTO brief_workflow_purges (purge_id, flow_id, project_id, request_id, generation, actor, accepted_at)
    VALUES ('planted-2', ?, ?, ?, 1, 'x', 1)`, [second.flow.id, DEFAULT_IDS.project, accepted.requestId]);
  getWorkflowDb().run('UPDATE brief_workflow_commands SET flow_id = ? WHERE request_id = ?', [second.flow.id, accepted.requestId]);
  service.stop(); start();
  expect(getFlow(flow.id)).not.toBeNull(); expect(count('SELECT COUNT(*) AS n FROM brief_workflow_removals WHERE flow_id = ?', flow.id)).toBe(1);
  expect(getFlow(second.flow.id)).not.toBeNull();
  const other = fixture('Other');
  expect(() => getWorkflowDb().run('UPDATE brief_workflow_removals SET flow_id = ? WHERE flow_id = ?', [other.flow.id, flow.id])).toThrow('workflow_history_retained');
  expect(() => getWorkflowDb().run("DELETE FROM brief_workflow_purges WHERE purge_id = 'planted'")).toThrow('workflow_history_retained');
});

test('payload files a purge could not remove stay listed on its receipt and recovery removes them', () => {
  const { flow, version } = restored(), run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: 'SUCCEEDED' });
  const logs = join(dir, 'data', 'workflow-logs'); mkdirSync(logs, { recursive: true });
  // A non-empty directory where the backup file goes: removing it without recursion fails, as root too.
  const blocker = join(logs, `${run.id}.bin`); mkdirSync(join(blocker, 'inner'), { recursive: true });
  expect(purge(purgeCommand(flow.id))).toMatchObject({ status: 'accepted' });
  expect(getFlow(flow.id)).toBeNull(); expect(existsSync(blocker)).toBe(true);
  expect(getWorkflowDb().query('SELECT files_pending FROM brief_workflow_purges WHERE flow_id = ?').get(flow.id)).toEqual({ files_pending: JSON.stringify([run.id]) });
  rmSync(blocker, { recursive: true }); writeFileSync(blocker, 'state');
  service.stop(); start();
  expect(existsSync(join(logs, `${run.id}.bin`))).toBe(false);
  expect(getWorkflowDb().query('SELECT files_pending FROM brief_workflow_purges WHERE flow_id = ?').get(flow.id)).toEqual({ files_pending: null });
  // A completed receipt is fixed.
  for (const sql of ["UPDATE brief_workflow_purges SET actor = 'someone' WHERE flow_id = ?", 'UPDATE brief_workflow_purges SET completed_at = NULL WHERE flow_id = ?']) {
    expect(() => getWorkflowDb().run(sql, [flow.id])).toThrow('workflow_history_retained');
  }
});
