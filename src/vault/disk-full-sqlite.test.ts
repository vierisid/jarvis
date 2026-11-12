import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from '../workflows/db/index';
import { enqueue, getJob } from '../workflows/db/repos/job-queue';
import { Worker } from '../workflows/queue/worker';
import { EmergencyController } from '../authority/emergency.ts';
import { createEmergencyPersister } from '../authority/emergency-persistence.ts';
import { saveUserSection } from '../daemon/user-settings.ts';
import { getSetting } from './settings.ts';
import { isStorageFullError, noteStorageFailure, probeStorage, resetStorageStatus, storageStatus } from './storage-health.ts';

// A real full disk as SQLite reports it: the database may not grow, and every
// page is used, so SQLite itself answers SQLITE_FULL ("database or disk is
// full"). Nothing here throws a hand-written error.

function fill(db: Database): void {
  const pages = (db.query('PRAGMA page_count').get() as { page_count: number }).page_count;
  db.exec(`PRAGMA max_page_count=${pages}`);
  let n = 0;
  for (const size of [100_000, 10_000, 1_000, 100, 10, 1]) {
    for (;;) {
      try { db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 1)', [`fill.${n++}`, 'x'.repeat(size)]); }
      catch (err) { expect((err as { code?: string }).code).toBe('SQLITE_FULL'); break; }
    }
  }
}
const free = (db: Database) => db.exec('PRAGMA max_page_count=1000000');
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => { resetStorageStatus(); initWorkflowDb(':memory:'); });
afterEach(() => { resetStorageStatus(); closeWorkflowDb(); });

describe('emergency state on a full disk (SQLITE_FULL)', () => {
  // `grow` makes the next saved row larger. Every state name is six letters,
  // so without it a change rewrites the row in place and fits even when no
  // page is free; on a real full disk the journal is what fails instead.
  function setup(grow = () => false) {
    const controller = new EmergencyController();
    const timers: Array<() => void> = [];
    const persist = createEmergencyPersister({
      controller,
      save: (state) => saveUserSection('authority', { default_level: 3, emergency_state: state, ...(grow() ? { pad: 'x'.repeat(5_000) } : {}) } as never),
      describe: (err) => isStorageFullError(err) ? 'the disk is full' : 'the database could not be written',
      onFailure: (err) => { noteStorageFailure(err); },
      setTimer: (fn) => { timers.push(fn); return timers.length; },
      clearTimer: () => {},
    });
    controller.setStateChangeCallback(() => { persist(); });
    const stored = () => (JSON.parse(getSetting('cfg.authority') ?? 'null') as { emergency_state?: string } | null)?.emergency_state ?? null;
    return { controller, timers, stored };
  }

  test('Kill stops in memory, says it is unsaved, and is saved once space returns', () => {
    const db = getWorkflowDb();
    const { controller, timers, stored } = setup();
    fill(db);
    controller.kill();
    expect(controller.getState()).toBe('killed');
    expect(controller.canExecute()).toBe(false);
    expect(controller.persistence()).toEqual({ saved: false, reason: 'the disk is full' });
    expect(storageStatus()).toMatchObject({ writable: false, reason: 'disk_full' });
    expect(probeStorage()).toBe(false);
    expect(stored()).toBeNull();

    free(db);
    timers.at(-1)!();
    expect(controller.persistence().saved).toBe(true);
    expect(stored()).toBe('killed');
    expect(probeStorage()).toBe(true);
    expect(storageStatus().writable).toBe(true);
  });

  test('a Resume that cannot be saved leaves the saved state paused, never resumed', () => {
    const db = getWorkflowDb();
    let growing = false;
    const { controller, stored } = setup(() => growing);
    controller.pause();
    expect(stored()).toBe('paused');
    fill(db);
    growing = true;
    controller.resume();
    expect(controller.getState()).toBe('normal');
    expect(controller.persistence().saved).toBe(false);
    // A restart now comes back paused: the failure errs on the side of stopped.
    expect(stored()).toBe('paused');
  });
});

describe('run worker on a full disk (SQLITE_FULL)', () => {
  test('does not claim while saving fails, even when the claim itself would fit', async () => {
    const db = getWorkflowDb();
    const ran: string[] = [];
    const job = enqueue({ jobType: 'TEST', payload: {}, maxAttempts: 1 });
    fill(db);
    expect(probeStorage()).toBe(false);
    const worker = new Worker({ log: () => {}, pollIntervalMs: 10, handlers: { TEST: async (j) => { ran.push(j.id); } } });
    worker.start();
    await wait(300);
    expect(ran).toEqual([]);
    expect(getJob(job.id)?.status).toBe('QUEUED');

    free(db);
    for (let i = 0; i < 60 && ran.length === 0; i++) await wait(100);
    await worker.stop();
    expect(ran).toEqual([job.id]);
    expect(getJob(job.id)?.status).toBe('SUCCEEDED');
  });

  test('a run that cannot record its work stops further claims until space returns', async () => {
    const db = getWorkflowDb();
    const ran: string[] = [];
    const first = enqueue({ jobType: 'WRITE', payload: {}, maxAttempts: 1 });
    const second = enqueue({ jobType: 'TEST', payload: {}, maxAttempts: 1 });
    const worker = new Worker({
      log: () => {},
      pollIntervalMs: 10,
      handlers: {
        // The disk fills while this run is recording its work.
        WRITE: async () => { fill(db); db.run("INSERT INTO settings (key, value, updated_at) VALUES ('run.output', 'x', 1)"); },
        TEST: async (j) => { ran.push(j.id); },
      },
    });
    worker.start();
    await wait(400);
    expect(getJob(first.id)?.status).not.toBe('QUEUED');
    expect(storageStatus()).toMatchObject({ writable: false, reason: 'disk_full' });
    expect(ran).toEqual([]);
    expect(getJob(second.id)?.status).toBe('QUEUED');

    free(db);
    for (let i = 0; i < 60 && ran.length === 0; i++) await wait(100);
    await worker.stop();
    expect(ran).toEqual([second.id]);
  });
});
