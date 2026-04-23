import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUpdate, type Spawner, type SpawnResult } from './update.ts';
import type { InstallMethod, InstallMethodInfo } from './install-method.ts';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'jarvis-update-test-'));
  // Provide a package.json so getInstalledVersion doesn't return '0.0.0'.
  writeFileSync(join(workDir, 'package.json'), JSON.stringify({
    name: '@usejarvis/brain',
    version: '1.0.0',
  }));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function fakeInfo(method: InstallMethod): InstallMethodInfo {
  return { method, reason: `test: ${method}` };
}

/** Records every spawn invocation. Returns a stub SpawnResult per call. */
function recordingSpawner(responses: Partial<SpawnResult>[] = []): {
  spawn: Spawner;
  calls: Array<{ cmd: string[]; cwd?: string }>;
} {
  const calls: Array<{ cmd: string[]; cwd?: string }> = [];
  let index = 0;
  const spawn: Spawner = (cmd, options) => {
    calls.push({ cmd, cwd: options?.cwd });
    const response = responses[index] ?? {};
    index += 1;
    return {
      exitCode: response.exitCode ?? 0,
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
    };
  };
  return { spawn, calls };
}

describe('runUpdate — refusal paths', () => {
  test('docker install refuses with exit code 1', async () => {
    const { spawn, calls } = recordingSpawner();
    const result = await runUpdate({
      packageRoot: workDir,
      spawn,
      detect: () => fakeInfo('docker'),
      restartDaemon: false,
    });
    expect(result.method).toBe('docker');
    expect(result.outcome).toBe('refused');
    expect(result.exitCode).toBe(1);
    // Must not have invoked any external commands.
    expect(calls).toEqual([]);
  });

  test('dev checkout refuses with exit code 1', async () => {
    const { spawn, calls } = recordingSpawner();
    const result = await runUpdate({
      packageRoot: workDir,
      spawn,
      detect: () => fakeInfo('dev'),
      restartDaemon: false,
    });
    expect(result.method).toBe('dev');
    expect(result.outcome).toBe('refused');
    expect(calls).toEqual([]);
  });

  test('unknown install refuses with exit code 1', async () => {
    const { spawn, calls } = recordingSpawner();
    const result = await runUpdate({
      packageRoot: workDir,
      spawn,
      detect: () => fakeInfo('unknown'),
      restartDaemon: false,
    });
    expect(result.method).toBe('unknown');
    expect(result.outcome).toBe('refused');
    expect(calls).toEqual([]);
  });
});

describe('runUpdate — bun-global', () => {
  test('dispatches `bun update -g @usejarvis/brain`', async () => {
    const { spawn, calls } = recordingSpawner([{ exitCode: 0, stdout: 'installed' }]);
    const result = await runUpdate({
      packageRoot: workDir,
      spawn,
      detect: () => fakeInfo('bun-global'),
      checkRunning: () => null,
      restartDaemon: false,
    });
    expect(result.outcome).toBe('updated');
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toEqual(['bun', 'update', '-g', '@usejarvis/brain']);
  });

  test('reports failure when bun exits non-zero', async () => {
    const { spawn } = recordingSpawner([{ exitCode: 2, stderr: 'network error' }]);
    const result = await runUpdate({
      packageRoot: workDir,
      spawn,
      detect: () => fakeInfo('bun-global'),
      checkRunning: () => null,
      restartDaemon: false,
    });
    expect(result.outcome).toBe('failed');
    expect(result.exitCode).toBe(1);
  });
});

describe('runUpdate — script install', () => {
  test('skips when already up-to-date (HEAD == upstream)', async () => {
    const { spawn, calls } = recordingSpawner([
      { exitCode: 0 }, // git fetch
      { exitCode: 0, stdout: 'abc123\n' }, // git rev-parse HEAD
      { exitCode: 0, stdout: 'abc123\n' }, // git rev-parse @{u}
    ]);
    const result = await runUpdate({
      packageRoot: workDir,
      spawn,
      detect: () => fakeInfo('script'),
      checkRunning: () => null,
      restartDaemon: false,
    });
    expect(result.outcome).toBe('up-to-date');
    expect(result.exitCode).toBe(0);
    // No git pull / bun install should have run.
    expect(calls.map((c) => c.cmd[0] + ' ' + c.cmd[1])).toEqual([
      'git fetch',
      'git rev-parse',
      'git rev-parse',
    ]);
  });

  test('runs git pull + bun install when upstream has new commits', async () => {
    const { spawn, calls } = recordingSpawner([
      { exitCode: 0 }, // fetch
      { exitCode: 0, stdout: 'abc\n' }, // HEAD
      { exitCode: 0, stdout: 'def\n' }, // upstream
      { exitCode: 0 }, // git pull
      { exitCode: 0 }, // bun install
    ]);
    const result = await runUpdate({
      packageRoot: workDir,
      spawn,
      detect: () => fakeInfo('script'),
      checkRunning: () => null,
      restartDaemon: false,
    });
    expect(result.outcome).toBe('updated');
    expect(calls[3]!.cmd).toEqual(['git', 'pull', '--ff-only']);
    expect(calls[3]!.cwd).toBe(workDir);
    expect(calls[4]!.cmd).toEqual(['bun', 'install']);
    expect(calls[4]!.cwd).toBe(workDir);
  });

  test('proceeds with pull when git fetch fails (skips preflight)', async () => {
    // If fetch fails (e.g. offline, no upstream), we can't preflight — just
    // try the pull and let it surface the real error.
    const { spawn, calls } = recordingSpawner([
      { exitCode: 1, stderr: 'no upstream' }, // fetch fails
      { exitCode: 0 }, // git pull still runs
      { exitCode: 0 }, // bun install
    ]);
    const result = await runUpdate({
      packageRoot: workDir,
      spawn,
      detect: () => fakeInfo('script'),
      checkRunning: () => null,
      restartDaemon: false,
    });
    expect(result.outcome).toBe('updated');
    expect(calls.map((c) => c.cmd.slice(0, 2).join(' '))).toEqual([
      'git fetch',
      'git pull',
      'bun install',
    ]);
  });

  test('reports failure when git pull fails', async () => {
    const { spawn } = recordingSpawner([
      { exitCode: 1 }, // fetch fails (skip preflight)
      { exitCode: 1, stderr: 'not fast-forward' }, // pull fails
    ]);
    const result = await runUpdate({
      packageRoot: workDir,
      spawn,
      detect: () => fakeInfo('script'),
      checkRunning: () => null,
      restartDaemon: false,
    });
    expect(result.outcome).toBe('failed');
    expect(result.exitCode).toBe(1);
  });

  test('stops running daemon before updating', async () => {
    let stopCalls = 0;
    const { spawn } = recordingSpawner([
      { exitCode: 1 }, // fetch fails, skip preflight
      { exitCode: 0 }, // pull
      { exitCode: 0 }, // bun install
    ]);
    const result = await runUpdate({
      packageRoot: workDir,
      spawn,
      detect: () => fakeInfo('script'),
      checkRunning: () => 12345, // pretend daemon is running
      stopDaemon: async () => {
        stopCalls += 1;
        return { wasRunning: true, pid: 12345, graceful: true };
      },
      restartDaemon: false,
    });
    expect(result.outcome).toBe('updated');
    expect(stopCalls).toBe(1);
  });

  test('bun install failure is a warning, not a hard failure', async () => {
    const { spawn } = recordingSpawner([
      { exitCode: 1 }, // fetch fails
      { exitCode: 0 }, // pull succeeds
      { exitCode: 2, stderr: 'disk full' }, // bun install fails
    ]);
    const result = await runUpdate({
      packageRoot: workDir,
      spawn,
      detect: () => fakeInfo('script'),
      checkRunning: () => null,
      restartDaemon: false,
    });
    // git pull was the meaningful operation; bun install is recoverable.
    expect(result.outcome).toBe('updated');
    expect(result.exitCode).toBe(0);
  });
});
