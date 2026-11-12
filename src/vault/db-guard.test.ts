import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertDatabaseUsable, checkDatabaseFile, DatabaseFileWatch, DatabaseProblemError, databaseLostMessage,
  describeOpenFailure, inspectDatabaseFile, NEW_DATABASE_ENV, resetDatabaseLost, stopWatchingDatabaseFile,
  watchDatabaseFile,
} from './db-guard.ts';
import { closeDb, initDatabase } from './schema.ts';

let dir: string;
let dbPath: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jarvis-dbguard-')); dbPath = join(dir, 'jarvis.db'); delete process.env[NEW_DATABASE_ENV]; });
afterEach(() => { stopWatchingDatabaseFile(); resetDatabaseLost(); closeDb(); rmSync(dir, { recursive: true, force: true }); delete process.env[NEW_DATABASE_ENV]; });

function makeDb(): void { const db = new Database(dbPath, { create: true }); db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)'); db.close(); }
const installState = {
  workspaceId: () => writeFileSync(join(dir, 'workspace-id'), 'abcdefghijklmnopqrstu\n'),
  sidecarKeys: () => { mkdirSync(join(dir, 'sidecar-keys')); writeFileSync(join(dir, 'sidecar-keys', 'private.pem'), 'x'); },
  secrets: () => writeFileSync(join(dir, '.secrets.key'), 'k'),
  workflowKey: () => writeFileSync(join(dir, 'workflow-encryption.key'), 'k'),
};

describe('a missing or empty database next to other install state', () => {
  test('a fresh folder starts normally', () => {
    expect(inspectDatabaseFile(dbPath, dir).state).toBe('fresh');
    expect(() => assertDatabaseUsable(dbPath, dir)).not.toThrow();
  });

  for (const [name, seed] of Object.entries(installState)) {
    test(`missing database with ${name} is refused with the restore command`, () => {
      seed();
      expect(inspectDatabaseFile(dbPath, dir).state).toBe('missing');
      let error: unknown;
      try { assertDatabaseUsable(dbPath, dir); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(DatabaseProblemError);
      const message = (error as Error).message;
      expect(message).toContain('missing');
      expect(message).toContain('jarvis restore');
      expect(message).toContain('--new-database');
      expect(message).not.toMatch(/SQLITE|at .*\.ts/);
    });
  }

  test('a zero-byte database with install state is refused as empty, and left alone', () => {
    installState.workspaceId();
    writeFileSync(dbPath, '');
    expect(() => assertDatabaseUsable(dbPath, dir)).toThrow(/empty/);
    expect(readFileSync(dbPath).length).toBe(0);
  });

  test('the owner can ask for a fresh database explicitly', () => {
    installState.sidecarKeys();
    expect(() => assertDatabaseUsable(dbPath, dir, { allowNew: true })).not.toThrow();
    process.env[NEW_DATABASE_ENV] = '1';
    expect(() => assertDatabaseUsable(dbPath, dir)).not.toThrow();
  });

  test('a real database passes whatever else exists', () => {
    installState.workspaceId(); makeDb();
    expect(() => assertDatabaseUsable(dbPath, dir)).not.toThrow();
  });

  test('stray or empty entries are not saved state', () => {
    writeFileSync(join(dir, 'workspace-id'), '');
    mkdirSync(join(dir, '.secrets.key'));
    mkdirSync(join(dir, 'sidecar-keys'));
    writeFileSync(join(dir, 'sidecar-keys', '.DS_Store'), 'junk');
    writeFileSync(join(dir, 'config.yaml'), 'daemon:\n  port: 3142\n');
    expect(inspectDatabaseFile(dbPath, dir)).toEqual({ state: 'fresh', evidence: [] });
    expect(() => assertDatabaseUsable(dbPath, dir)).not.toThrow();
  });

  test('state next to the database counts even when the data dir names another folder', () => {
    const dbDir = join(dir, 'home-jarvis');
    const otherDataDir = join(dir, 'elsewhere');
    mkdirSync(dbDir); mkdirSync(otherDataDir);
    writeFileSync(join(dbDir, 'workspace-id'), 'abcdefghijklmnopqrstu\n');
    const elsewhereDb = join(dbDir, 'jarvis.db');
    expect(inspectDatabaseFile(elsewhereDb, otherDataDir)).toMatchObject({ state: 'missing', evidence: [join(dbDir, 'workspace-id')] });
    expect(() => assertDatabaseUsable(elsewhereDb, otherDataDir)).toThrow(DatabaseProblemError);
  });

  test('the refusal names the database file it looked for', () => {
    installState.workspaceId();
    expect(() => assertDatabaseUsable(dbPath, dir)).toThrow(dbPath);
  });

  test('a leftover write-ahead log counts as install state', () => {
    writeFileSync(`${dbPath}-wal`, 'frames');
    expect(inspectDatabaseFile(dbPath, dir)).toMatchObject({ state: 'missing', evidence: ['jarvis.db-wal'] });
  });
});

describe('a damaged database', () => {
  test('says it is damaged and points at restore, and the file is untouched', () => {
    const garbage = Buffer.from('this is not a database '.repeat(200));
    writeFileSync(dbPath, garbage);
    let error: unknown;
    try { initDatabase(dbPath, { quiet: true }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(DatabaseProblemError);
    expect((error as DatabaseProblemError).kind).toBe('damaged');
    expect((error as Error).message).toContain('damaged');
    expect((error as Error).message).toContain('jarvis restore');
    expect(readFileSync(dbPath).equals(garbage)).toBe(true);
  });

  test('other open failures are not rewritten', () => {
    expect(describeOpenFailure('unable to open database file', dbPath)).toBeNull();
    expect(describeOpenFailure('attempt to write a readonly database', dbPath)?.kind).toBe('unwritable');
    expect(describeOpenFailure('database disk image is malformed', dbPath)?.kind).toBe('damaged');
  });
});

describe('a database file that changes while Jarvis runs', () => {
  test('deleting, replacing and emptying it are each noticed', () => {
    makeDb();
    const watch = new DatabaseFileWatch(dbPath);
    expect(watch.check()).toBeNull();
    truncateSync(dbPath, 0);
    expect(watch.check()).toBe('emptied');

    makeDb(); rmSync(dbPath, { force: true }); makeDb();
    const second = new DatabaseFileWatch(dbPath);
    renameSync(dbPath, `${dbPath}.old`);
    expect(second.check()).toBe('missing');
    const other = new Database(join(dir, 'other.db'), { create: true }); other.exec('CREATE TABLE u (y)'); other.close();
    renameSync(join(dir, 'other.db'), dbPath);
    expect(second.check()).toBe('replaced');
  });

  test('a watched file that vanishes stops writes with the plain message', () => {
    makeDb();
    watchDatabaseFile(dbPath, 60_000);
    checkDatabaseFile();
    expect(databaseLostMessage()).toBeNull();
    rmSync(dbPath);
    checkDatabaseFile();
    expect(databaseLostMessage()).toContain('deleted while it was running');
    expect(databaseLostMessage()).toContain('jarvis restore');
  });
});
