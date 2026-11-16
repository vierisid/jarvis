import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeDataDirError, getLogPath, releaseLock, tryAcquireLock } from './pid.ts';

// "Already running" is for a held lock only. A data folder that cannot be
// written (read-only, wrong owner, full) is a different problem with a
// different fix, and the owner must be told which.
let dir: string; let prev: string | undefined;
beforeEach(() => { prev = process.env.JARVIS_HOME; dir = mkdtempSync(join(tmpdir(), 'jarvis-lockresult-')); process.env.JARVIS_HOME = dir; });
afterEach(() => { releaseLock(); chmodSync(dir, 0o755); rmSync(dir, { recursive: true, force: true }); if (prev === undefined) delete process.env.JARVIS_HOME; else process.env.JARVIS_HOME = prev; });

describe('tryAcquireLock', () => {
  test('takes a free lock', () => {
    expect(tryAcquireLock(process.pid)).toEqual({ ok: true });
  });

  test('a lock someone holds is "held"', () => {
    expect(tryAcquireLock(process.pid).ok).toBe(true);
    expect(tryAcquireLock(process.pid)).toEqual({ ok: false, reason: 'held' });
  });

  test.skipIf(process.getuid?.() === 0)('an unwritable data folder is an error with a plain message, not "held"', () => {
    chmodSync(dir, 0o555);
    const result = tryAcquireLock(process.pid);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'error') throw new Error(`expected an error, got ${JSON.stringify(result)}`);
    expect(result.message).toContain('cannot write to its data folder');
    expect(result.message).toContain(dir);
    expect(result.message).toContain('not allowed to write');
    expect(result.message).not.toMatch(/EACCES|jarvis\.pid/);
  });

  test('a file where the data folder should be is an error too', () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    process.env.JARVIS_HOME = join(blocker, 'data');
    const result = tryAcquireLock(process.pid);
    expect(result).toMatchObject({ ok: false, reason: 'error' });
  });

  test.skipIf(process.getuid?.() === 0)('the log path names the data folder instead of a raw mkdir failure', () => {
    chmodSync(dir, 0o555);
    expect(() => getLogPath()).toThrow(/cannot write to its data folder/);
  });
});

describe('describeDataDirError', () => {
  const fsError = (code: string, message = `${code}: x, open '/d/jarvis.pid'`) => Object.assign(new Error(message), { code });
  test('says what is wrong for the common causes', () => {
    expect(describeDataDirError(fsError('ENOSPC'), '/d')).toContain('disk is full');
    expect(describeDataDirError(fsError('EROFS'), '/d')).toContain('read-only');
    expect(describeDataDirError(fsError('EACCES'), '/d')).toContain('not allowed to write');
  });
  test('an error that is not a file error keeps its own message', () => {
    expect(describeDataDirError(new Error('The JARVIS daemon is not compatible with native Windows.'), '/d')).toBe('The JARVIS daemon is not compatible with native Windows.');
  });
});
