import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdEnroll } from './devices.ts';
import { closeDb } from '../vault/schema.ts';

// `jarvis enroll` against a used data folder whose database is gone: it must
// refuse with the restore command and create nothing, instead of minting a
// token into an empty vault the next daemon start refuses (or accepts as new).
const saved = { home: process.env.JARVIS_HOME, secrets: process.env.JARVIS_SECRETS_DIR };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-enroll-db-'));
  process.env.JARVIS_HOME = dir;
  process.env.JARVIS_SECRETS_DIR = dir;
});
afterEach(() => {
  closeDb();
  if (saved.home === undefined) delete process.env.JARVIS_HOME; else process.env.JARVIS_HOME = saved.home;
  if (saved.secrets === undefined) delete process.env.JARVIS_SECRETS_DIR; else process.env.JARVIS_SECRETS_DIR = saved.secrets;
  rmSync(dir, { recursive: true, force: true });
});

test('enroll refuses a missing database next to saved state and creates nothing', async () => {
  writeFileSync(join(dir, 'workspace-id'), 'abcdefghijklmnopqrstu\n');
  const out: string[] = []; const err: string[] = [];
  const code = await cmdEnroll(['laptop'], { out: (l) => out.push(l), err: (l) => err.push(l) });
  expect(code).toBe(1);
  expect(out).toEqual([]);
  expect(err.join('\n')).toContain('jarvis restore');
  expect(existsSync(join(dir, 'jarvis.db'))).toBe(false);
  expect(existsSync(join(dir, 'sidecar-keys'))).toBe(false);
});
