import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseFileCheck } from './doctor.ts';

let dir: string; let dbPath: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jarvis-doctor-db-')); dbPath = join(dir, 'jarvis.db'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('a healthy database file passes', async () => {
  const db = new Database(dbPath, { create: true }); db.exec('CREATE TABLE t (x)'); db.close();
  expect(await databaseFileCheck(dbPath, dir)).toMatchObject({ name: 'Database', status: 'ok' });
});

test('a damaged file fails, says so and points at restore, and is not changed', async () => {
  const garbage = Buffer.from('not a database '.repeat(300));
  writeFileSync(dbPath, garbage);
  const result = await databaseFileCheck(dbPath, dir);
  expect(result.status).toBe('fail');
  expect(result.message).toContain('damaged');
  expect(result.message).toContain('jarvis restore');
  expect(readFileSync(dbPath).equals(garbage)).toBe(true);
});

test('bytes flipped inside a table are caught by the integrity check', async () => {
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE t (x TEXT, y INTEGER); CREATE INDEX t_x ON t(x)');
  for (let i = 0; i < 300; i++) db.run('INSERT INTO t VALUES (?, ?)', [`row-${i}-${'z'.repeat(40)}`, i]);
  db.close();
  const bytes = readFileSync(dbPath);
  // Wipe the index page: the table still reads, the index no longer matches it.
  for (let page = 2; page * 4096 < bytes.length; page++) if (bytes[page * 4096] === 0x0a) bytes.fill(0, page * 4096 + 8, (page + 1) * 4096);
  writeFileSync(dbPath, bytes);
  const result = await databaseFileCheck(dbPath, dir);
  expect(result.status).toBe('fail');
  expect(result.message).toContain('damaged');
});

test('a missing database next to saved settings fails with the restore command; a fresh folder only warns', async () => {
  expect((await databaseFileCheck(dbPath, dir)).status).toBe('warn');
  writeFileSync(join(dir, 'workspace-id'), 'abcdefghijklmnopqrstu\n');
  const result = await databaseFileCheck(dbPath, dir);
  expect(result.status).toBe('fail');
  expect(result.message).toContain('missing');
  expect(result.message).toContain('jarvis restore');
});
