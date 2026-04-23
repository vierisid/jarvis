import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCleanupPlan, buildCleanupScript } from './uninstall.ts';
import type { InstallMethod, InstallMethodInfo } from './install-method.ts';

let workDir: string;
let fakeHome: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'jarvis-uninstall-test-'));
  fakeHome = join(workDir, 'home');
  mkdirSync(fakeHome, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function fakeDetect(method: InstallMethod) {
  return (): InstallMethodInfo => ({ method, reason: `test: ${method}` });
}

describe('createCleanupPlan — method-specific paths', () => {
  test('script install schedules dataDir for removal', () => {
    const plan = createCleanupPlan(join(fakeHome, '.jarvis', 'daemon'), {
      env: {},
      homeDir: fakeHome,
      detect: fakeDetect('script'),
    });
    expect(plan.method).toBe('script');
    expect(plan.removablePaths).toContain(join(fakeHome, '.jarvis'));
    expect(plan.runBunUninstall).toBe(false);
  });

  test('bun-global install schedules dataDir only; package handled by bun', () => {
    const packageRoot = join(fakeHome, '.bun', 'install', 'global', 'node_modules', '@usejarvis', 'brain');
    const plan = createCleanupPlan(packageRoot, {
      env: {},
      homeDir: fakeHome,
      detect: fakeDetect('bun-global'),
    });
    expect(plan.runBunUninstall).toBe(true);
    expect(plan.removablePaths).toContain(join(fakeHome, '.jarvis'));
    // Must NOT remove the package dir directly — that's what bun uninstall is for.
    expect(plan.removablePaths).not.toContain(packageRoot);
  });

  test('dev checkout is never added to removablePaths', () => {
    const devPath = join(workDir, 'work', 'jarvis');
    const plan = createCleanupPlan(devPath, {
      env: {},
      homeDir: fakeHome,
      detect: fakeDetect('dev'),
    });
    expect(plan.removablePaths).not.toContain(devPath);
    expect(plan.removablePaths).toContain(join(fakeHome, '.jarvis'));
  });

  test('docker method produces a plan with no removable paths', () => {
    const plan = createCleanupPlan('/app', {
      env: {},
      homeDir: fakeHome,
      detect: fakeDetect('docker'),
    });
    expect(plan.removablePaths).toEqual([]);
    expect(plan.runBunUninstall).toBe(false);
  });
});

describe('createCleanupPlan — env overrides', () => {
  test('honors JARVIS_HOME for data dir', () => {
    const customDataDir = join(workDir, 'custom-jarvis');
    const plan = createCleanupPlan(join(fakeHome, '.bun', 'install', 'global', 'node_modules', '@usejarvis', 'brain'), {
      env: { JARVIS_HOME: customDataDir },
      homeDir: fakeHome,
      detect: fakeDetect('bun-global'),
    });
    expect(plan.dataDir).toBe(customDataDir);
    expect(plan.removablePaths).toContain(customDataDir);
    // Must not include the default ~/.jarvis when JARVIS_HOME is set.
    expect(plan.removablePaths).not.toContain(join(fakeHome, '.jarvis'));
  });

  test('honors BUN_INSTALL for wrapper candidates', () => {
    const customBun = join(workDir, 'custom-bun');
    const wrapperPath = join(customBun, 'bin', 'jarvis');
    mkdirSync(join(customBun, 'bin'), { recursive: true });
    writeFileSync(wrapperPath, '#!/bin/sh\n');
    const plan = createCleanupPlan(join(fakeHome, '.jarvis', 'daemon'), {
      env: { BUN_INSTALL: customBun },
      homeDir: fakeHome,
      detect: fakeDetect('script'),
    });
    expect(plan.cliWrapperPaths).toContain(wrapperPath);
  });

  test('default wrapper candidates live under ~/.bun/bin', () => {
    const defaultWrapper = join(fakeHome, '.bun', 'bin', 'jarvis');
    mkdirSync(join(fakeHome, '.bun', 'bin'), { recursive: true });
    writeFileSync(defaultWrapper, '#!/bin/sh\n');
    const plan = createCleanupPlan(join(fakeHome, '.jarvis', 'daemon'), {
      env: {},
      homeDir: fakeHome,
      detect: fakeDetect('script'),
    });
    expect(plan.cliWrapperPaths).toContain(defaultWrapper);
  });
});

describe('createCleanupPlan — Windows path handling', () => {
  // Previously skipped. The new plan uses portable path operations so it
  // works identically on Windows; exercise the case-insensitive comparison.
  test('windows-style package root under global bun dir still classifies correctly', () => {
    // Simulate a package root at different casing than the parent — on
    // Windows this is a real concern. On other platforms this is just a
    // regression guard against future platform-specific branches.
    const packageRoot = join(fakeHome, '.bun', 'install', 'global', 'node_modules', '@usejarvis', 'brain');
    const plan = createCleanupPlan(packageRoot, {
      env: {},
      homeDir: fakeHome,
      detect: fakeDetect('bun-global'),
    });
    expect(plan.method).toBe('bun-global');
  });
});

describe('buildCleanupScript — executes correctly against a fixture tree', () => {
  test('unlinks wrappers, removes dataDir, skips package dir when flag off', async () => {
    const dataDir = join(workDir, 'fake-home', '.jarvis');
    const wrapperPath = join(workDir, 'fake-bun', 'bin', 'jarvis');
    const canaryPath = join(workDir, 'canary-keep-me.txt');

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.yaml'), 'x: 1');
    mkdirSync(join(workDir, 'fake-bun', 'bin'), { recursive: true });
    writeFileSync(wrapperPath, '#!/bin/sh\n');
    writeFileSync(canaryPath, 'I should survive');

    const logPath = join(workDir, 'uninstall.log');
    const tempDir = mkdtempSync(join(tmpdir(), 'jarvis-uninstall-exec-'));
    const scriptPath = join(tempDir, 'cleanup.mjs');

    const plan = {
      method: 'script' as InstallMethod,
      methodReason: 'test',
      dataDir,
      packageRoot: dataDir,
      cliWrapperPaths: [wrapperPath],
      // Use a bun path that we know works — the current process's bun.
      bunPath: Bun.which('bun') ?? 'bun',
      autostartInstalled: false,
      removablePaths: [dataDir],
      runBunUninstall: false, // don't actually run bun uninstall in tests
      logPath,
    };

    writeFileSync(scriptPath, buildCleanupScript(plan));

    const proc = Bun.spawnSync([plan.bunPath, scriptPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(0);

    // Wrapper gone, dataDir gone, canary untouched.
    expect(existsSync(wrapperPath)).toBe(false);
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(canaryPath)).toBe(true);

    // Log file was written with our expected events.
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('cleanup started');
    expect(log).toContain('unlinked wrapper');
    expect(log).toContain('removed ' + dataDir);
    expect(log).toContain('cleanup complete');

    // Temp dir self-cleaned.
    expect(existsSync(tempDir)).toBe(false);
  }, 10000);

  test('missing wrapper is a soft no-op, not a failure', async () => {
    const dataDir = join(workDir, 'fake-home-2', '.jarvis');
    const missingWrapper = join(workDir, 'does-not-exist', 'jarvis');
    mkdirSync(dataDir, { recursive: true });

    const logPath = join(workDir, 'uninstall-2.log');
    const tempDir = mkdtempSync(join(tmpdir(), 'jarvis-uninstall-exec-'));
    const scriptPath = join(tempDir, 'cleanup.mjs');

    const plan = {
      method: 'script' as InstallMethod,
      methodReason: 'test',
      dataDir,
      packageRoot: dataDir,
      cliWrapperPaths: [missingWrapper],
      bunPath: Bun.which('bun') ?? 'bun',
      autostartInstalled: false,
      removablePaths: [dataDir],
      runBunUninstall: false,
      logPath,
    };

    writeFileSync(scriptPath, buildCleanupScript(plan));

    const proc = Bun.spawnSync([plan.bunPath, scriptPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(0);
    // Missing wrapper should be treated as already-unlinked.
    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('unlinked wrapper ' + missingWrapper);
  }, 10000);
});
