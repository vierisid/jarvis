import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from '../index';
import { createFlow } from './flow';
import { createDraftVersion } from './flow-version';
import { createFlowRun, getFlowRun } from './flow-run';
import { createWaitpoint } from './waitpoint';
import { enqueue, getJob } from './job-queue';
import { saveWorkflowEffect, listWorkflowEffects } from './workflow-effect';
import { ApprovalManager } from '../../../authority/approval';
import { setSetting } from '../../../vault/settings';
import { createCommitment } from '../../../vault/commitments';
import { workflowLogsBase } from '../../sandbox-api/config';
import {
  countRunsToPrune, getRunHistoryKeep, JOB_PAYLOAD_KEEP_DAYS, pruneJobPayloads, pruneRunHistory, resetRunHistorySizeCache,
  RUN_HISTORY_SETTING_KEY, runHistorySummary, setRunHistoryKeep, startRunHistoryRetention,
} from './run-retention';

const DAY = 24 * 60 * 60 * 1000;
let dataDir: string; let previous: string | undefined;
beforeEach(() => {
  previous = process.env.JARVIS_WORKFLOW_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'jarvis-retention-'));
  process.env.JARVIS_WORKFLOW_DATA_DIR = dataDir;
  initWorkflowDb(':memory:');
  resetRunHistorySizeCache();
});
afterEach(() => {
  closeWorkflowDb();
  if (previous === undefined) delete process.env.JARVIS_WORKFLOW_DATA_DIR; else process.env.JARVIS_WORKFLOW_DATA_DIR = previous;
  rmSync(dataDir, { recursive: true, force: true });
});

function fixture() {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: 'History' });
  /** A run that ended `daysAgo` days ago (or is in another status), with a log file and a job. */
  const run = (opts: { daysAgo: number; status?: string; parent?: string } = { daysAgo: 0 }) => {
    const r = createFlowRun({ flowId: flow.id, flowVersionId: version.id, ...(opts.parent ? { parentRunId: opts.parent } : {}) });
    const at = Date.now() - opts.daysAgo * DAY;
    getWorkflowDb().run('UPDATE flow_run SET status = ?, finish_time = ?, updated = ?, created = ? WHERE id = ?',
      [opts.status ?? 'SUCCEEDED', at, at, at, r.id]);
    mkdirSync(workflowLogsBase(), { recursive: true });
    writeFileSync(join(workflowLogsBase(), `${r.id}.bin`), 'x'.repeat(100));
    const job = enqueue({ jobType: 'RUN_FLOW', flowRunId: r.id, payload: { runId: r.id, payload: { big: 'y'.repeat(500) } } });
    getWorkflowDb().run("UPDATE workflow_job SET status = 'SUCCEEDED', updated = ? WHERE id = ?", [at, job.id]);
    return { id: r.id, jobId: job.id, log: join(workflowLogsBase(), `${r.id}.bin`) };
  };
  return { flow, version, run };
}
const exists = (id: string) => getFlowRun(id) !== null;

describe('the setting', () => {
  test('is "forever" until the owner chooses, and a bad stored value never deletes', () => {
    expect(getRunHistoryKeep()).toBe('forever');
    setSetting(RUN_HISTORY_SETTING_KEY, '1 day');
    expect(getRunHistoryKeep()).toBe('forever');
    setRunHistoryKeep('90d');
    expect(getRunHistoryKeep()).toBe('90d');
  });
});

describe('pruning finished runs', () => {
  test('deletes finished runs older than the choice with their jobs, effects and log files, and keeps the rest', async () => {
    const f = fixture();
    const old = f.run({ daysAgo: 120 }), recent = f.run({ daysAgo: 10 }), failedOld = f.run({ daysAgo: 200, status: 'FAILED' });
    saveWorkflowEffect({ id: 'wfe_old', runId: old.id, projectId: 'p', flowId: f.flow.id, versionId: f.version.id, versionDigest: 'd',
      stepName: 's', executionPath: [], route: 'notify', toolName: 'workflow_notify', actionCategory: 'read_data', requestDigest: 'r',
      arguments: {}, target: {}, provenance: {}, decision: 'allowed', reason: '', status: 'succeeded', approvalId: null, waitpointId: null,
      createdAt: Date.now() } as never);
    expect(countRunsToPrune('90d')).toBe(2);
    const result = await pruneRunHistory('90d');
    expect(result).toMatchObject({ runs: 2, jobs: 2, files: 2 });
    expect(exists(old.id)).toBe(false); expect(exists(failedOld.id)).toBe(false); expect(exists(recent.id)).toBe(true);
    expect(getJob(old.jobId)).toBeNull(); expect(getJob(recent.jobId)).not.toBeNull();
    expect(existsSync(old.log)).toBe(false); expect(existsSync(recent.log)).toBe(true);
    expect(listWorkflowEffects(old.id)).toHaveLength(0);
  });

  test('"forever" deletes nothing, however old', async () => {
    const f = fixture();
    const ancient = f.run({ daysAgo: 4000 });
    expect(await pruneRunHistory('forever')).toEqual({ runs: 0, jobs: 0, files: 0 });
    expect(exists(ancient.id)).toBe(true);
  });

  test('1 year, 90 days and 30 days cut at their own age', async () => {
    const f = fixture();
    const a = f.run({ daysAgo: 400 }), b = f.run({ daysAgo: 100 }), c = f.run({ daysAgo: 40 }), d = f.run({ daysAgo: 5 });
    expect(countRunsToPrune('1y')).toBe(1);
    expect(countRunsToPrune('90d')).toBe(2);
    expect(countRunsToPrune('30d')).toBe(3);
    await pruneRunHistory('30d');
    expect([a, b, c, d].map((r) => exists(r.id))).toEqual([false, false, false, true]);
  });

  test('never touches a run that is waiting, paused, or has an unresolved wait or effect', async () => {
    const f = fixture();
    const paused = f.run({ daysAgo: 300, status: 'PAUSED' });
    const running = f.run({ daysAgo: 300, status: 'RUNNING' });
    const waiting = f.run({ daysAgo: 300 });
    createWaitpoint({ flowRunId: waiting.id, projectId: getFlowRun(waiting.id)!.projectId, stepName: 's', type: 'MANUAL' });
    const pending = f.run({ daysAgo: 300 });
    saveWorkflowEffect({ id: 'wfe_pending', runId: pending.id, projectId: 'p', flowId: f.flow.id, versionId: f.version.id, versionDigest: 'd',
      stepName: 's', executionPath: [], route: 'notify', toolName: 'workflow_notify', actionCategory: 'send_message', requestDigest: 'r',
      arguments: {}, target: {}, provenance: {}, decision: 'unresolved', reason: '', status: 'pending', approvalId: null, waitpointId: null,
      createdAt: Date.now() } as never);
    const queued = f.run({ daysAgo: 300 });
    getWorkflowDb().run("UPDATE workflow_job SET status = 'QUEUED' WHERE id = ?", [queued.jobId]);
    const result = await pruneRunHistory('30d');
    expect(result.runs).toBe(0);
    for (const r of [paused, running, waiting, pending, queued]) expect(exists(r.id)).toBe(true);
  });

  test('keeps a run an open or approved card names, and a run still on the failures list', async () => {
    const f = fixture();
    const approvals = new ApprovalManager();
    const card = (runId: string) => approvals.createRequest({ agentId: `workflow:${runId}`, agentName: 'Workflow', toolName: 'workflow_notify',
      toolArguments: {}, actionCategory: 'send_message', urgency: 'normal', reason: 'r', context: '{}', executionMode: 'workflow' });
    const open = f.run({ daysAgo: 300 }), approved = f.run({ daysAgo: 300 }), done = f.run({ daysAgo: 300 }), failing = f.run({ daysAgo: 300, status: 'FAILED' });
    card(open.id);
    approvals.approve(card(approved.id).id, 'owner');
    const closed = card(done.id); approvals.deny(closed.id, 'owner');
    getWorkflowDb().run("INSERT INTO open_failure (key, source, run_id, flow_id, effect_id, at) VALUES ('k', 'run', ?, ?, NULL, ?)", [failing.id, f.flow.id, Date.now()]);
    await pruneRunHistory('30d');
    expect([open, approved, failing].map((r) => exists(r.id))).toEqual([true, true, true]);
    // A denied card is closed business: that run goes, and the card's own record stays in the Authority history.
    expect(exists(done.id)).toBe(false);
    expect(approvals.getRequest(closed.id)).not.toBeNull();
  });

  test('keeps a run whose parent is live and a run with a live child', async () => {
    const f = fixture();
    const parent = f.run({ daysAgo: 300, status: 'RUNNING' });
    const child = f.run({ daysAgo: 300, parent: parent.id });
    const endedParent = f.run({ daysAgo: 300 });
    const liveChild = f.run({ daysAgo: 300, status: 'RUNNING', parent: endedParent.id });
    await pruneRunHistory('30d');
    expect([parent, child, endedParent, liveChild].map((r) => exists(r.id))).toEqual([true, true, true, true]);
  });

  test('deletes in batches and finishes them all', async () => {
    const f = fixture();
    for (let i = 0; i < 1200; i++) {
      const r = createFlowRun({ flowId: f.flow.id, flowVersionId: f.version.id });
      getWorkflowDb().run("UPDATE flow_run SET status = 'SUCCEEDED', finish_time = ?, updated = ? WHERE id = ?", [Date.now() - 400 * DAY, Date.now() - 400 * DAY, r.id]);
    }
    const result = await pruneRunHistory('1y');
    expect(result.runs).toBe(1200);
    expect((getWorkflowDb().query('SELECT COUNT(*) AS n FROM flow_run').get() as { n: number }).n).toBe(0);
  });
});

describe('dropping the input stored on finished jobs', () => {
  test('after a week, for jobs of ended runs, whatever the setting', async () => {
    const f = fixture();
    const old = f.run({ daysAgo: JOB_PAYLOAD_KEEP_DAYS + 3 }), fresh = f.run({ daysAgo: 1 });
    expect(await pruneJobPayloads()).toBe(1);
    expect(getJob(old.jobId)!.payload).toEqual({ runId: old.id });
    expect((getJob(fresh.jobId)!.payload as { payload?: unknown }).payload).toBeDefined();
    expect(await pruneJobPayloads()).toBe(0);
    expect(getRunHistoryKeep()).toBe('forever');
  });

  test('keeps the input of a job whose run is still waiting, and the keys the queue reads', async () => {
    const f = fixture();
    const parked = f.run({ daysAgo: 40, status: 'PAUSED' });
    const resume = enqueue({ jobType: 'RUN_FLOW', flowRunId: parked.id, payload: { runId: parked.id, executionType: 'RESUME', waitpointId: 'w1', resumePayload: { a: 1 } } });
    getWorkflowDb().run("UPDATE workflow_job SET status = 'SUCCEEDED', updated = ? WHERE id = ?", [Date.now() - 40 * DAY, resume.id]);
    const ended = f.run({ daysAgo: 40 });
    const endedResume = enqueue({ jobType: 'RUN_FLOW', flowRunId: ended.id, payload: { runId: ended.id, executionType: 'RESUME', waitpointId: 'w2', resumePayload: { a: 1 } } });
    getWorkflowDb().run("UPDATE workflow_job SET status = 'SUCCEEDED', updated = ? WHERE id = ?", [Date.now() - 40 * DAY, endedResume.id]);
    await pruneJobPayloads();
    expect(getJob(parked.jobId)!.payload).toMatchObject({ payload: { big: expect.any(String) } });
    expect(getJob(resume.id)!.payload).toMatchObject({ resumePayload: { a: 1 } });
    expect(getJob(endedResume.id)!.payload).toEqual({ runId: ended.id, executionType: 'RESUME', waitpointId: 'w2' });
  });
  test('slims a large backlog in batches, one pass over the table, and leaves malformed rows alone', async () => {
    const f = fixture();
    const r = f.run({ daysAgo: 30 });
    const at = Date.now() - 30 * DAY;
    const ids: string[] = [];
    for (let i = 0; i < 1200; i++) {
      const job = enqueue({ jobType: 'RUN_FLOW', flowRunId: r.id, payload: { runId: r.id, payload: { n: i } } });
      ids.push(job.id);
    }
    getWorkflowDb().run("INSERT INTO workflow_job (id, job_type, status, payload, created, updated, scheduled_at) VALUES ('bad', 'RUN_FLOW', 'FAILED', '{not json', ?, ?, ?)", [at, at, at]);
    getWorkflowDb().run("UPDATE workflow_job SET status = 'SUCCEEDED', updated = ? WHERE id != 'bad'", [at]);
    expect(await pruneJobPayloads()).toBe(1201);
    for (const id of [ids[0]!, ids[599]!, ids[1199]!]) expect(getJob(id)!.payload).toEqual({ runId: r.id });
    expect((getWorkflowDb().query("SELECT payload FROM workflow_job WHERE id = 'bad'").get() as { payload: string }).payload).toBe('{not json');
  });
});

describe('the size shown', () => {
  test('counts runs and bytes, database and log files', async () => {
    const f = fixture();
    f.run({ daysAgo: 1 }); f.run({ daysAgo: 2 });
    const summary = await runHistorySummary();
    expect(summary.runs).toBe(2);
    expect(summary.logBytes).toBe(200);
    expect(summary.dataBytes).toBeGreaterThan(1000);
    expect(summary.bytes).toBe(summary.dataBytes + summary.logBytes);
    expect(summary.oldestAt).toBeLessThan(Date.now() - DAY);
  });
});

describe('the daily clean-up', () => {
  test('applies the setting when it runs, and drops job input even when the setting is forever', async () => {
    const f = fixture();
    const old = f.run({ daysAgo: 100 });
    const stop = startRunHistoryRetention({ firstDelayMs: 5, intervalMs: 60_000, log: () => {} });
    await Bun.sleep(80);
    expect(exists(old.id)).toBe(true);
    expect(getJob(old.jobId)!.payload).toEqual({ runId: old.id });
    setRunHistoryKeep('90d');
    stop();
    const second = startRunHistoryRetention({ firstDelayMs: 5, intervalMs: 60_000, log: () => {} });
    await Bun.sleep(150);
    second();
    expect(exists(old.id)).toBe(false);
  });
});

describe('history other features still rely on', () => {
  const effect = (id: string, runId: string, flowId: string, versionId: string) => saveWorkflowEffect({ id, runId, projectId: 'p', flowId, versionId,
    versionDigest: 'd', stepName: 's', executionPath: [], route: 'notify', toolName: 'workflow_notify', actionCategory: 'send_message',
    requestDigest: 'r', arguments: {}, target: {}, provenance: {}, decision: 'allowed', reason: '', status: 'unknown', approvalId: null,
    waitpointId: null, createdAt: Date.now() } as never);

  test('keeps the runs of a removed workflow (only a purge deletes them) and still clears the others', async () => {
    const f = fixture(), other = fixture();
    const removed = f.run({ daysAgo: 300 }), plain = other.run({ daysAgo: 300 });
    getWorkflowDb().run(`INSERT INTO brief_workflow_removals (receipt_id, flow_id, project_id, version_id, before_revision, removed_at, expires_at)
      VALUES ('rcpt', ?, 'p', NULL, '{}', ?, ?)`, [f.flow.id, Date.now(), Date.now() + DAY]);
    expect(countRunsToPrune('30d')).toBe(1);
    expect((await pruneRunHistory('30d')).runs).toBe(1);
    expect(exists(removed.id)).toBe(true);
    expect(exists(plain.id)).toBe(false);
  });

  test('keeps a run whose effect still holds an unresolved cross-run identity, which only its recovery can resolve', async () => {
    const f = fixture();
    const uncertain = f.run({ daysAgo: 300, status: 'FAILED' }), settled = f.run({ daysAgo: 300, status: 'FAILED' });
    effect('wfe_uncertain', uncertain.id, f.flow.id, f.version.id);
    effect('wfe_settled', settled.id, f.flow.id, f.version.id);
    getWorkflowDb().run("INSERT INTO workflow_effect_identity (identity, owner, completed) VALUES ('id-1', 'wfe_uncertain', 0), ('id-2', 'wfe_settled', 1)");
    await pruneRunHistory('30d');
    expect(exists(uncertain.id)).toBe(true);
    expect(exists(settled.id)).toBe(false);
    expect(getWorkflowDb().query('SELECT COUNT(*) AS n FROM workflow_effect_identity').get()).toEqual({ n: 2 });
  });

  test('keeps a run a planned task points at, and a sub-workflow call still waiting on its child', async () => {
    const f = fixture();
    const planned = f.run({ daysAgo: 300 }), child = f.run({ daysAgo: 300 }), loose = f.run({ daysAgo: 300 });
    const work = createCommitment('Planned work');
    getWorkflowDb().run("INSERT INTO commitment_work (work_id, mode, run_id, updated_at) VALUES (?, 'workflow', ?, ?)", [work.id, planned.id, Date.now()]);
    getWorkflowDb().run(`INSERT INTO workflow_subflow_call (id, parent_flow_id, fingerprint, child_run_id, effect_id, version_id, version_digest, deadline, schema_json, result_json)
      VALUES ('call', ?, 'fp', ?, 'e', ?, 'd', 0, '{}', NULL)`, [f.flow.id, child.id, f.version.id]);
    await pruneRunHistory('30d');
    expect([planned, child, loose].map((r) => exists(r.id))).toEqual([true, true, false]);
  });
});
