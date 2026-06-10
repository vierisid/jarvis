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
  // ls-remote stdout fixtures: one tag ref per line, `<sha>\trefs/tags/<name>`.
  const lsRemote = (...tags: string[]): string =>
    tags.map((t, i) => `${'0'.repeat(40 - String(i).length)}${i}\trefs/tags/${t}`).join('\n') + '\n';

  test('skips when already on the latest tag', async () => {
    const { spawn, calls } = recordingSpawner([
      { exitCode: 0, stdout: lsRemote('v0.9.0', 'v1.0.0') }, // git ls-remote (latest = v1.0.0)
      { exitCode: 0, stdout: 'v1.0.0\n' }, // git describe --exact-match
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
    // No fetch / checkout / bun install should have run.
    expect(calls.map((c) => c.cmd.slice(0, 2).join(' '))).toEqual([
      'git ls-remote',
      'git describe',
    ]);
  });

  test('fetches + checks out the latest tag when a newer one exists', async () => {
    const { spawn, calls } = recordingSpawner([
      { exitCode: 0, stdout: lsRemote('v1.0.0', 'v2.0.0') }, // ls-remote (latest = v2.0.0)
      { exitCode: 0, stdout: 'v1.0.0\n' }, // describe (current = v1.0.0)
      { exitCode: 0 }, // git checkout -- .
      { exitCode: 0 }, // git fetch tag
      { exitCode: 0 }, // git checkout tag
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
    expect(calls[3]!.cmd).toEqual([
      'git', 'fetch', '--depth', '1', 'origin', 'refs/tags/v2.0.0:refs/tags/v2.0.0',
    ]);
    expect(calls[3]!.cwd).toBe(workDir);
    expect(calls[4]!.cmd).toEqual(['git', 'checkout', '-q', 'v2.0.0']);
    expect(calls[5]!.cmd).toEqual(['bun', 'install']);
    expect(calls[5]!.cwd).toBe(workDir);
  });

  test('updates when HEAD is not on a tag (describe fails)', async () => {
    const { spawn, calls } = recordingSpawner([
      { exitCode: 0, stdout: lsRemote('v2.0.0') }, // ls-remote
      { exitCode: 128, stderr: 'no tag at HEAD' }, // describe fails -> treat as needs update
      { exitCode: 0 }, // checkout -- .
      { exitCode: 0 }, // fetch
      { exitCode: 0 }, // checkout tag
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
      'git ls-remote',
      'git describe',
      'git checkout',
      'git fetch',
      'git checkout',
      'bun install',
    ]);
  });

  test('fails when the remote is unreachable (ls-remote fails)', async () => {
    const { spawn, calls } = recordingSpawner([
      { exitCode: 1, stderr: 'could not resolve host' }, // ls-remote fails
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
    // Must not proceed past the remote probe.
    expect(calls).toHaveLength(1);
  });

  test('fails when the remote has no version tags', async () => {
    const { spawn } = recordingSpawner([
      { exitCode: 0, stdout: '' }, // ls-remote returns nothing usable
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

  test('reports failure when git checkout fails', async () => {
    const { spawn } = recordingSpawner([
      { exitCode: 0, stdout: lsRemote('v2.0.0') }, // ls-remote
      { exitCode: 0, stdout: 'v1.0.0\n' }, // describe
      { exitCode: 0 }, // checkout -- .
      { exitCode: 0 }, // fetch
      { exitCode: 1, stderr: 'checkout conflict' }, // checkout tag fails
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
      { exitCode: 0, stdout: lsRemote('v2.0.0') }, // ls-remote
      { exitCode: 0, stdout: 'v1.0.0\n' }, // describe
      { exitCode: 0 }, // checkout -- .
      { exitCode: 0 }, // fetch
      { exitCode: 0 }, // checkout tag
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
      { exitCode: 0, stdout: lsRemote('v2.0.0') }, // ls-remote
      { exitCode: 0, stdout: 'v1.0.0\n' }, // describe
      { exitCode: 0 }, // checkout -- .
      { exitCode: 0 }, // fetch
      { exitCode: 0 }, // checkout tag
      { exitCode: 2, stderr: 'disk full' }, // bun install fails
    ]);
    const result = await runUpdate({
      packageRoot: workDir,
      spawn,
      detect: () => fakeInfo('script'),
      checkRunning: () => null,
      restartDaemon: false,
    });
    // The checkout was the meaningful operation; bun install is recoverable.
    expect(result.outcome).toBe('updated');
    expect(result.exitCode).toBe(0);
  });
});

describe('pickLatestTag', () => {
  const line = (tag: string) => `1111111111111111111111111111111111111111\trefs/tags/${tag}`;

  test('picks the highest version, not lexicographic order', async () => {
    const { pickLatestTag } = await import('./update.ts');
    const stdout = [line('v0.6.0'), line('v0.6.1'), line('v0.10.0'), line('v0.9.0')].join('\n');
    expect(pickLatestTag(stdout)).toBe('v0.10.0');
  });

  test('handles four-part versions like v0.4.3.1', async () => {
    const { pickLatestTag } = await import('./update.ts');
    const stdout = [line('v0.4.3'), line('v0.4.3.1'), line('v0.4.2')].join('\n');
    expect(pickLatestTag(stdout)).toBe('v0.4.3.1');
  });

  test('ignores non-version refs and returns null when none match', async () => {
    const { pickLatestTag } = await import('./update.ts');
    const stdout = [line('latest'), line('nightly'), line('release-candidate')].join('\n');
    expect(pickLatestTag(stdout)).toBeNull();
  });
});
