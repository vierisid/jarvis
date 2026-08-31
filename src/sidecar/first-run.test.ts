import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDb, getDb } from '../vault/schema.ts';
import { getSetting, setSetting } from '../vault/settings.ts';
import { claimDashboardIntro, DASHBOARD_INTRO_KEY } from './first-run.ts';

// Inserts a sidecar row; `seen` controls last_seen_at, which is what the
// schema backfill keys off ("has a sidecar ever actually connected?").
function insertSidecar(id: string, seen: boolean): void {
  getDb().run(
    `INSERT INTO sidecars (id, name, token_id, last_seen_at)
     VALUES (?, ?, ?, ?)`,
    [id, `name-${id}`, `tok-${id}`, seen ? '2026-01-01 00:00:00' : null],
  );
}

describe('claimDashboardIntro', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  test('claims exactly once, then never again', () => {
    expect(claimDashboardIntro()).toBe(true);
    expect(claimDashboardIntro()).toBe(false);
    expect(claimDashboardIntro()).toBe(false);
  });

  test('persists the claim so a daemon restart cannot re-claim', () => {
    claimDashboardIntro();
    expect(getSetting(DASHBOARD_INTRO_KEY)).toBe('1');
  });

  test('never claims when the flag is already set', () => {
    setSetting(DASHBOARD_INTRO_KEY, '1');
    expect(claimDashboardIntro()).toBe(false);
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
    expect(claimDashboardIntro()).toBe(false);
  });

  test('an enrolled-but-never-connected sidecar still leaves the intro available', () => {
    initDatabase(dbPath);
    insertSidecar('sc-1', false);
    closeDb();

    initDatabase(dbPath);
    expect(getSetting(DASHBOARD_INTRO_KEY)).toBeNull();
    expect(claimDashboardIntro()).toBe(true);
  });

  test('a fresh brain with no sidecars can still claim the intro', () => {
    initDatabase(dbPath);
    closeDb();

    initDatabase(dbPath);
    expect(getSetting(DASHBOARD_INTRO_KEY)).toBeNull();
    expect(claimDashboardIntro()).toBe(true);
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
