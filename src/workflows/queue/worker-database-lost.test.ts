import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeWorkflowDb, initWorkflowDb } from '../db/index';
import { enqueue, getJob } from '../db/repos/job-queue';
import { markDatabaseLost, resetDatabaseLost } from '../../vault/db-guard';
import { Worker } from './worker';

beforeEach(() => { resetDatabaseLost(); initWorkflowDb(':memory:'); });
afterEach(() => { resetDatabaseLost(); closeWorkflowDb(); });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('the worker runs nothing while the database file it opened is gone', async () => {
  const ran: string[] = [];
  const worker = new Worker({ log: () => undefined, pollIntervalMs: 10, handlers: { TEST: async (job) => { ran.push(job.id); } } });
  const job = enqueue({ jobType: 'TEST', payload: {}, maxAttempts: 1 });
  markDatabaseLost('Jarvis\'s database file was deleted while it was running.');
  worker.start();
  await wait(250);
  expect(ran).toEqual([]);
  expect(getJob(job.id)?.status).toBe('QUEUED');
  await worker.stop();
});
