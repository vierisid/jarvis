import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadWorkspaceId, WORKSPACE_ID_FILE } from './workspace-id';

const made: string[] = [];
const dir = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'jarvis-workspace-id-')); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

test('the id is created once per data directory and reused across restarts', () => {
  const home = dir(), first = loadWorkspaceId(home);
  expect(first).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  expect(loadWorkspaceId(home)).toBe(first);
  expect(readFileSync(path.join(home, WORKSPACE_ID_FILE), 'utf-8').trim()).toBe(first);
  if (process.platform !== 'win32') expect(statSync(path.join(home, WORKSPACE_ID_FILE)).mode & 0o777).toBe(0o600);
});

test('another data directory has its own id', () => {
  expect(loadWorkspaceId(dir())).not.toBe(loadWorkspaceId(dir()));
});

test('a missing data directory is created and a corrupt id is replaced', () => {
  const home = path.join(dir(), 'nested', 'data');
  const id = loadWorkspaceId(home);
  expect(loadWorkspaceId(home)).toBe(id);
  writeFileSync(path.join(home, WORKSPACE_ID_FILE), 'x');
  const replaced = loadWorkspaceId(home);
  expect(replaced).not.toBe(id); expect(loadWorkspaceId(home)).toBe(replaced);
});

test('an unusable data directory degrades to a per-boot id instead of failing startup', () => {
  const file = path.join(dir(), 'not-a-dir');
  writeFileSync(file, '');
  const a = loadWorkspaceId(file), b = loadWorkspaceId(file);
  expect(a).toBeTruthy(); expect(a).not.toBe(b);
});
