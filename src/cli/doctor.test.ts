/**
 * #863: workflow engines and CODE steps start with `--no-env-file`, which Bun
 * before 1.3.3 accepts and ignores (a cwd `.env` still loads; measured on
 * 1.2.0, 1.3.0 and 1.3.2). package.json `engines` allows >=1.0.0, so
 * `jarvis doctor` says so instead of refusing.
 */
import { describe, expect, test } from 'bun:test';
import { bunRuntimeCheck, MIN_BUN_FOR_NO_ENV_FILE } from './doctor.ts';

describe('jarvis doctor: Bun runtime check', () => {
  test('Bun older than 1.3.3 warns that --no-env-file is ignored', () => {
    for (const v of ['1.0.0', '1.2.0', '1.3.0', '1.3.2', '1.3.2-canary.1']) {
      const r = bunRuntimeCheck(v);
      expect({ v, status: r.status }).toEqual({ v, status: 'warn' });
      expect(r.message).toContain(`before ${MIN_BUN_FOR_NO_ENV_FILE}`);
      expect(r.message).toContain('.env');
    }
  });

  test('Bun 1.3.3 and later is ok', () => {
    expect(MIN_BUN_FOR_NO_ENV_FILE).toBe('1.3.3');
    for (const v of ['1.3.3', '1.3.4', '1.3.8', '1.4.2', '1.10.0', '2.0.0']) {
      expect({ v, r: bunRuntimeCheck(v) }).toEqual({ v, r: { name: 'Bun Runtime', status: 'ok', message: `v${v}` } });
    }
  });

  test('pre-1.0 keeps its own warning', () => {
    expect(bunRuntimeCheck('0.8.1')).toEqual({ name: 'Bun Runtime', status: 'warn', message: 'v0.8.1 (>= 1.0.0 recommended)' });
  });

  test('the running Bun gets a verdict', () => {
    expect(['ok', 'warn']).toContain(bunRuntimeCheck(Bun.version).status);
  });
});
