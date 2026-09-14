import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDb, getDb } from '../vault/schema.ts';
import { getSetting, setSetting } from '../vault/settings.ts';
import {
  beginDashboardIntro,
  finishDashboardIntro,
  dashboardSpawnOutcome,
  DASHBOARD_INTRO_KEY,
  DASHBOARD_INTRO_ATTEMPTS_KEY,
  MAX_DASHBOARD_INTRO_ATTEMPTS,
} from './first-run.ts';

// Inserts a sidecar row; `seen` controls last_seen_at, which is what the
// schema backfill keys off ("has a sidecar ever actually connected?").
function insertSidecar(id: string, seen: boolean): void {
  getDb().run(
    `INSERT INTO sidecars (id, name, token_id, last_seen_at)
     VALUES (?, ?, ?, ?)`,
    [id, `name-${id}`, `tok-${id}`, seen ? '2026-01-01 00:00:00' : null],
  );
}

describe('dashboard intro attempts', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    // Clear the in-memory in-flight guard between tests.
    finishDashboardIntro(false);
    closeDb();
  });

  test('a successful attempt marks the intro shown for good', () => {
    expect(beginDashboardIntro()).toBe(true);
    finishDashboardIntro(true);
    expect(getSetting(DASHBOARD_INTRO_KEY)).toBe('1');
    expect(beginDashboardIntro()).toBe(false);
  });

  test('a failed attempt leaves the intro for the next connect', () => {
    expect(beginDashboardIntro()).toBe(true);
    finishDashboardIntro(false);
    expect(getSetting(DASHBOARD_INTRO_KEY)).toBeNull();
    expect(beginDashboardIntro()).toBe(true);
  });

  test('gives up after the maximum number of failed attempts', () => {
    for (let i = 0; i < MAX_DASHBOARD_INTRO_ATTEMPTS; i++) {
      expect(beginDashboardIntro()).toBe(true);
      finishDashboardIntro(false);
    }
    expect(beginDashboardIntro()).toBe(false);
    expect(getSetting(DASHBOARD_INTRO_ATTEMPTS_KEY)).toBe(String(MAX_DASHBOARD_INTRO_ATTEMPTS));
  });

  test('an attempt is counted before the spawn, so a crash mid-attempt still counts', () => {
    expect(beginDashboardIntro()).toBe(true);
    expect(getSetting(DASHBOARD_INTRO_ATTEMPTS_KEY)).toBe('1');
  });

  test('a second sidecar cannot start an attempt while one is in flight', () => {
    expect(beginDashboardIntro()).toBe(true);
    expect(beginDashboardIntro()).toBe(false);
    expect(getSetting(DASHBOARD_INTRO_ATTEMPTS_KEY)).toBe('1');
    finishDashboardIntro(false);
    expect(beginDashboardIntro()).toBe(true);
  });

  test('never starts when the flag is already set', () => {
    setSetting(DASHBOARD_INTRO_KEY, '1');
    expect(beginDashboardIntro()).toBe(false);
    expect(getSetting(DASHBOARD_INTRO_ATTEMPTS_KEY)).toBeNull();
  });
});

describe('dashboardSpawnOutcome', () => {
  test('a spawn that returned the panel id opened the dashboard', () => {
    expect(dashboardSpawnOutcome({ ok: true, result: { id: 'tray:chat' } })).toBe('opened');
  });

  test('a spawn still running past the RPC timeout counts as shown', () => {
    expect(dashboardSpawnOutcome({ ok: true, result: 'detached' })).toBe('detached');
  });

  test('losing the id to an open dashboard counts as shown', () => {
    const err = new Error('HANDLER_ERROR: panel.spawn[tray:chat]: panel already exists');
    expect(dashboardSpawnOutcome({ ok: false, error: err })).toBe('already-open');
  });

  test('a window the sidecar could not create is a failure', () => {
    const err = new Error('HANDLER_ERROR: panel.spawn[tray:chat]: could not create the window');
    expect(dashboardSpawnOutcome({ ok: false, error: err })).toBe('failed');
  });

  test('a disconnect mid-spawn is a failure', () => {
    expect(dashboardSpawnOutcome({ ok: false, error: new Error('Sidecar disconnected: disconnected') })).toBe('failed');
  });

  test('a non-Error rejection is classified by its string form', () => {
    expect(dashboardSpawnOutcome({ ok: false, error: 'panel already exists' })).toBe('already-open');
    expect(dashboardSpawnOutcome({ ok: false, error: 42 })).toBe('failed');
  });
});

describe('first-run backfill migration', () => {
  let dataDir: string;
  let dbPath: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'jarvis-firstrun-'));
    dbPath = join(dataDir, 'vault.db');
  });

  afterEach(async () => {
    finishDashboardIntro(false);
    closeDb();
    await rm(dataDir, { recursive: true, force: true });
  });

  // A file-backed DB is required here: the backfill runs inside initDatabase,
  // so to prove it we must close and REOPEN the same database — which :memory:
  // cannot do.
  test('a brain whose sidecar has already connected is not a first run', () => {
    initDatabase(dbPath);
    insertSidecar('sc-1', true);
    closeDb();

    initDatabase(dbPath);
    expect(getSetting(DASHBOARD_INTRO_KEY)).toBe('1');
    expect(beginDashboardIntro()).toBe(false);
  });

  test('an enrolled-but-never-connected sidecar still leaves the intro available', () => {
    initDatabase(dbPath);
    insertSidecar('sc-1', false);
    closeDb();

    initDatabase(dbPath);
    expect(getSetting(DASHBOARD_INTRO_KEY)).toBeNull();
    expect(beginDashboardIntro()).toBe(true);
  });

  test('a fresh brain with no sidecars can still show the intro', () => {
    initDatabase(dbPath);
    closeDb();

    initDatabase(dbPath);
    expect(getSetting(DASHBOARD_INTRO_KEY)).toBeNull();
    expect(beginDashboardIntro()).toBe(true);
  });

  test('the backfill does not overwrite an existing flag on reopen', () => {
    initDatabase(dbPath);
    insertSidecar('sc-1', true);
    // A value the backfill would clobber if it were an upsert rather than
    // INSERT OR IGNORE.
    setSetting(DASHBOARD_INTRO_KEY, 'claimed-by-connect');
    closeDb();

    initDatabase(dbPath);
    expect(getSetting(DASHBOARD_INTRO_KEY)).toBe('claimed-by-connect');
  });
});
