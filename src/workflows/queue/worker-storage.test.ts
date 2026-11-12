import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from '../db/index';
import { enqueue, getJob } from '../db/repos/job-queue';
import { resetStorageStatus, storageStatus } from '../../vault/storage-health';
import { Worker } from './worker';

beforeEach(() => { resetStorageStatus(); initWorkflowDb(':memory:'); });
afterEach(() => { resetStorageStatus(); closeWorkflowDb(); });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('when nothing can be saved the worker says so once, backs off, and carries on when saving works', async () => {
  const lines: string[] = [];
  const ran: string[] = [];
  const worker = new Worker({ log: (line: string) => lines.push(line), pollIntervalMs: 10, handlers: { TEST: async (job) => { ran.push(job.id); } } });
  const job = enqueue({ jobType: 'TEST', payload: {}, maxAttempts: 1 });
  // A refused write, as a full disk gives: every claim fails.
  getWorkflowDb().exec('PRAGMA query_only=ON');
  worker.start();
  await wait(400);
  const claimComplaints = lines.filter((line) => line.includes('claim')).length;
  expect(claimComplaints).toBeLessThanOrEqual(1);
  expect(storageStatus().writable).toBe(false);
  expect(ran).toEqual([]);

  getWorkflowDb().exec('PRAGMA query_only=OFF');
  for (let i = 0; i < 60 && ran.length === 0; i++) await wait(100);
  await worker.stop();
  expect(ran).toEqual([job.id]);
  expect(getJob(job.id)?.status).toBe('SUCCEEDED');
  expect(storageStatus().writable).toBe(true);
});

test('a probe that passes while the claim still fails keeps backing off and logs once', async () => {
  const lines: string[] = [];
  const worker = new Worker({ log: (line: string) => lines.push(line), pollIntervalMs: 10, handlers: { TEST: async () => {} } });
  enqueue({ jobType: 'TEST', payload: {}, maxAttempts: 1 });
  // A nearly full disk: the probe's one-row rewrite fits, the claim does not.
  getWorkflowDb().exec("CREATE TRIGGER rv_full BEFORE UPDATE ON workflow_job BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
  worker.start();
  await wait(2_500);
  await worker.stop();
  // Back-off 1 s then 2 s: one complaint, not one per probe-then-claim cycle.
  expect(lines.filter((line) => line.includes('no job can be claimed'))).toHaveLength(1);
});
