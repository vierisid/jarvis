/**
 * The oldest supported Bun is 1.3.11: before it, HTTPS through the workflow
 * egress guard's lookup cannot verify certificates (measured on 1.3.8-1.3.10).
 * `jarvis doctor` fails below it, and every place that states the minimum
 * agrees with MIN_BUN_VERSION. Before 1.3.3 a cwd `.env` also loads into
 * engines (#863), which the failure names too.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bunRuntimeCheck, MIN_BUN_FOR_NO_ENV_FILE, MIN_BUN_VERSION, versionAtLeast } from './doctor.ts';

const root = join(import.meta.dir, '..', '..');

describe('jarvis doctor: Bun runtime check', () => {
  test('Bun older than 1.3.11 fails and says to upgrade', () => {
    for (const v of ['1.3.3', '1.3.8', '1.3.10', '1.3.10-canary.4']) {
      const r = bunRuntimeCheck(v);
      expect({ v, status: r.status }).toEqual({ v, status: 'fail' });
      expect(r.message).toContain(`needs Bun ${MIN_BUN_VERSION} or later`);
      expect(r.message).toContain('verify certificates');
      expect(r.message).toContain('bun upgrade');
      expect(r.message).not.toContain('.env');
    }
  });

  test('Bun older than 1.3.3 also names the .env leak', () => {
    for (const v of ['0.8.1', '1.0.0', '1.2.0', '1.3.0', '1.3.2', '1.3.2-canary.1']) {
      const r = bunRuntimeCheck(v);
      expect({ v, status: r.status }).toEqual({ v, status: 'fail' });
      expect(r.message).toContain(`before ${MIN_BUN_FOR_NO_ENV_FILE}`);
      expect(r.message).toContain('.env');
    }
  });

  test('Bun 1.3.11 and later is ok', () => {
    expect(MIN_BUN_VERSION).toBe('1.3.11');
    for (const v of ['1.3.11', '1.3.12', '1.4.2', '1.10.0', '2.0.0']) {
      expect({ v, r: bunRuntimeCheck(v) }).toEqual({ v, r: { name: 'Bun Runtime', status: 'ok', message: `v${v}` } });
    }
  });

  test('versionAtLeast compares numerically', () => {
    expect(versionAtLeast('1.3.11', '1.3.11')).toBe(true);
    expect(versionAtLeast('1.3.10', '1.3.11')).toBe(false);
    expect(versionAtLeast('1.10.0', '1.3.11')).toBe(true);
    expect(versionAtLeast('2.0.0', '1.3.11')).toBe(true);
  });

  test('the running Bun gets a verdict', () => {
    expect(['ok', 'fail']).toContain(bunRuntimeCheck(Bun.version).status);
  });
});

describe('every stated Bun minimum is MIN_BUN_VERSION', () => {
  test('package.json engines.bun', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.engines.bun).toBe(`>=${MIN_BUN_VERSION}`);
  });

  test('install.sh MIN_BUN', () => {
    expect(readFileSync(join(root, 'install.sh'), 'utf8')).toMatch(new RegExp(`^MIN_BUN="${MIN_BUN_VERSION.replace(/\./g, '\\.')}"$`, 'm'));
  });

  test('scripts/ensure-bun.cjs MIN_BUN', () => {
    expect(readFileSync(join(root, 'scripts', 'ensure-bun.cjs'), 'utf8')).toContain(`const MIN_BUN = '${MIN_BUN_VERSION}';`);
  });
});
