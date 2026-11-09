/**
 * Phase 1 of usejarvis #66: the brain's --system-config fail-closed
 * contract. The daemon must refuse to start when the flag is set but the
 * file is unreadable, rather than silently falling back to the tenant-owned
 * ~/.jarvis/config.yaml. Full startDaemon() cannot be booted in a unit test
 * (see api-desktop-config.test.ts for the same note), so the readability
 * check lives in validateSystemConfigPath and is exercised directly here;
 * parseArgs is exercised directly too since it takes an argv parameter.
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSystemConfigPath } from './system-config.ts';
import { parseArgs } from './index.ts';

let TEST_DIR: string;

beforeEach(async () => {
  TEST_DIR = await mkdtemp(join(tmpdir(), 'jarvis-system-config-'));
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe('validateSystemConfigPath (fail-closed pre-check)', () => {
  test('a missing file is reported with the exact daemon error line', async () => {
    const path = join(TEST_DIR, 'does-not-exist.yaml');
    const result = await validateSystemConfigPath(path);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // The exact wording the daemon logs before process.exit(1). Any drift
    // here is a user-facing change: Phase 2 (hosting side, usejarvis #66)
    // relies on this line in its operator runbook.
    expect(result.message).toBe(
      `[Daemon] --system-config <path>: cannot read ${path}: file does not exist`,
    );
  });

  test('a readable file is accepted', async () => {
    const path = join(TEST_DIR, 'ok.yaml');
    await writeFile(path, 'daemon:\n  port: 3142\n');
    const result = await validateSystemConfigPath(path);
    expect(result.ok).toBe(true);
  });

  test('an unreadable file is reported', async () => {
    const path = join(TEST_DIR, 'locked.yaml');
    await writeFile(path, 'daemon:\n  port: 3142\n');
    await chmod(path, 0o000);
    try {
      // Skip when running as root (CI containers sometimes do): chmod 000
      // does not lock root out, so this would produce ok:true.
      if (process.getuid && process.getuid() === 0) return;
      const result = await validateSystemConfigPath(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message.startsWith(`[Daemon] --system-config <path>: cannot read ${path}:`)).toBe(true);
    } finally {
      // Restore so the temp-dir cleanup in afterEach can remove it.
      await chmod(path, 0o600).catch(() => undefined);
    }
  });
});

describe('parseArgs --system-config', () => {
  test('a value is parsed into systemConfigPath', () => {
    const parsed = parseArgs(['--system-config', '/etc/jarvis-host/instances/u_42/config.yaml']);
    expect(parsed.systemConfigPath).toBe('/etc/jarvis-host/instances/u_42/config.yaml');
  });

  test('parsed alongside other flags', () => {
    const parsed = parseArgs([
      '--port', '3142',
      '--system-config', '/etc/foo.yaml',
      '--data-dir', '/var/lib/jarvis',
    ]);
    expect(parsed.systemConfigPath).toBe('/etc/foo.yaml');
    expect(parsed.port).toBe(3142);
    expect(parsed.dataDir).toBe('/var/lib/jarvis');
  });

  test('absent means undefined (self-host default kept)', () => {
    const parsed = parseArgs(['--port', '3142']);
    expect(parsed.systemConfigPath).toBeUndefined();
  });
});

describe('parseArgs --system-config: fail-closed misinvocations', () => {
  // Hoisted: these cases exit(1), so run them in a subprocess the way
  // exit-code.test.ts does for other exit paths in this module.
  const DAEMON_MODULE = join(import.meta.dir, 'index.ts');

  async function runParse(argv: string[]): Promise<{ exitCode: number | null; stderr: string }> {
    const fixture = join(TEST_DIR, 'parse-args.ts');
    await writeFile(
      fixture,
      `const { parseArgs } = await import(${JSON.stringify(DAEMON_MODULE)});\n`
      + `parseArgs(${JSON.stringify(argv)});\n`
      + `console.log('no-exit');\n`,
    );
    const proc = Bun.spawn([process.execPath, fixture], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, JARVIS_HOME: TEST_DIR },
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stderr };
  }

  test('--system-config with no value exits 1', async () => {
    const { exitCode, stderr } = await runParse(['--system-config']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--system-config requires a path');
  }, 30_000);

  test('--system-config followed by another flag exits 1', async () => {
    const { exitCode, stderr } = await runParse(['--system-config', '--port']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--system-config requires a path');
  }, 30_000);
});
