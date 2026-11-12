import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, getDb, initDatabase } from './schema.ts';
import {
  isStorageFullError, noteStorageFailure, plainStorageResponse, probeStorage, resetStorageStatus,
  STORAGE_FULL_MESSAGE, storageStatus,
} from './storage-health.ts';

beforeEach(() => { resetStorageStatus(); closeDb(); initDatabase(':memory:', { quiet: true }); });
afterEach(() => { resetStorageStatus(); closeDb(); });

/** SQLite's own full-disk answer, without needing a full disk. */
function fillDatabase(): void {
  const db = getDb();
  const pages = (db.query('PRAGMA page_count').get() as { page_count: number }).page_count;
  db.exec(`PRAGMA max_page_count=${pages}`);
}
function unfillDatabase(): void { getDb().exec('PRAGMA max_page_count=1000000'); }

describe('storage health', () => {
  test('recognises full-disk errors from SQLite and the OS', () => {
    expect(isStorageFullError(new Error('database or disk is full'))).toBe(true);
    expect(isStorageFullError(Object.assign(new Error('write failed'), { code: 'ENOSPC' }))).toBe(true);
    expect(isStorageFullError(new Error('no such table: x'))).toBe(false);
  });

  test('a failed write marks storage not writable and a later write marks it writable', () => {
    expect(storageStatus().writable).toBe(true);
    fillDatabase();
    let failure: unknown;
    try { getDb().run("INSERT INTO settings (key, value, updated_at) VALUES ('big', ?, 1)", ['x'.repeat(2_000_000)]); } catch (err) { failure = err; }
    expect(failure).toBeDefined();
    expect(noteStorageFailure(failure)).toBe(true);
    expect(storageStatus()).toMatchObject({ writable: false, reason: 'disk_full', message: STORAGE_FULL_MESSAGE });
    getDb().exec('PRAGMA query_only=ON');
    expect(probeStorage()).toBe(false);
    expect(storageStatus().writable).toBe(false);
    getDb().exec('PRAGMA query_only=OFF');
    unfillDatabase();
    expect(probeStorage()).toBe(true);
    expect(storageStatus()).toMatchObject({ writable: true, reason: null, message: null });
  });

  test('an unrelated error is not storage trouble', () => {
    expect(noteStorageFailure(new Error('no such table: x'))).toBe(false);
    expect(storageStatus().writable).toBe(true);
  });

  test('raw SQLite text in a 5xx answer becomes the plain message', async () => {
    const raw = Response.json({ error: 'SQLiteError: database or disk is full' }, { status: 500, headers: { 'Access-Control-Allow-Origin': 'http://x' } });
    const plain = await plainStorageResponse(raw);
    expect(plain.status).toBe(500);
    expect(plain.headers.get('Access-Control-Allow-Origin')).toBe('http://x');
    expect(await plain.json()).toEqual({ error: STORAGE_FULL_MESSAGE, code: 'storage_full' });
    expect(storageStatus().writable).toBe(false);
  });

  test('other answers pass through untouched', async () => {
    const ok = Response.json({ error: 'database or disk is full' }, { status: 400 });
    expect(await plainStorageResponse(ok)).toBe(ok);
    const other = Response.json({ error: 'nope' }, { status: 500 });
    expect(await plainStorageResponse(other)).toBe(other);
  });
});
