import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealthMonitor } from './health.ts';
import { ServiceRegistry } from './services.ts';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { resetDatabaseLost, stopWatchingDatabaseFile, watchDatabaseFile } from '../vault/db-guard.ts';

let dir: string; let dbPath: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jarvis-health-db-')); dbPath = join(dir, 'jarvis.db'); initDatabase(dbPath, { quiet: true }); watchDatabaseFile(dbPath, 60_000); });
afterEach(() => { stopWatchingDatabaseFile(); resetDatabaseLost(); closeDb(); rmSync(dir, { recursive: true, force: true }); });

test('health says the database is not connected once its file is deleted, though the handle still answers', () => {
  const monitor = new HealthMonitor(new ServiceRegistry(), dbPath);
  expect(monitor.getHealth().database).toMatchObject({ connected: true });
  expect(monitor.getHealth().database.problem).toBeUndefined();
  rmSync(dbPath);
  rmSync(`${dbPath}-wal`, { force: true });
  const database = monitor.getHealth().database;
  expect(database.connected).toBe(false);
  expect(database.problem).toContain('deleted while it was running');
});

test('health notices a database truncated to zero bytes', () => {
  const monitor = new HealthMonitor(new ServiceRegistry(), dbPath);
  truncateSync(dbPath, 0);
  expect(monitor.getHealth().database).toMatchObject({ connected: false });
  expect(monitor.getHealth().database.problem).toContain('emptied');
});
