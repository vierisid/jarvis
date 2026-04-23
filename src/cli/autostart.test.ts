import { describe, expect, test } from 'bun:test';
import {
  canUseSystemdUserService,
  decodeLaunchctlOutput,
  isLaunchdAlreadyLoaded,
  probeSystemdUserService,
  scheduleSystemdRestart,
  type SpawnResultLike,
  type SpawnSyncFn,
} from './autostart.ts';

function makeSpawn(responses: Record<string, SpawnResultLike>): SpawnSyncFn {
  return (cmd) => {
    const key = cmd.join(' ');
    const res = responses[key];
    if (!res) throw new Error(`Unexpected spawn call: ${key}`);
    return res;
  };
}

const ok: SpawnResultLike = { exitCode: 0 };
const fail: SpawnResultLike = { exitCode: 1 };

describe('canUseSystemdUserService', () => {
  test('returns false when systemctl --version fails (not installed)', () => {
    const spawn = makeSpawn({
      'systemctl --user --version': fail,
    });
    expect(canUseSystemdUserService(spawn)).toBe(false);
  });

  test('returns true when is-system-running exits 0 (healthy)', () => {
    const spawn = makeSpawn({
      'systemctl --user --version': ok,
      'systemctl --user is-system-running': ok,
    });
    expect(canUseSystemdUserService(spawn)).toBe(true);
  });

  test('falls back to show-environment when is-system-running fails but bus is reachable', () => {
    const spawn = makeSpawn({
      'systemctl --user --version': ok,
      'systemctl --user is-system-running': fail,
      'systemctl --user show-environment': ok,
    });
    expect(canUseSystemdUserService(spawn)).toBe(true);
  });

  test('returns false when both is-system-running and show-environment fail (WSL2 without systemd)', () => {
    const spawn = makeSpawn({
      'systemctl --user --version': ok,
      'systemctl --user is-system-running': fail,
      'systemctl --user show-environment': fail,
    });
    expect(canUseSystemdUserService(spawn)).toBe(false);
  });

  test('returns false when spawn throws', () => {
    const spawn: SpawnSyncFn = () => {
      throw new Error('ENOENT');
    };
    expect(canUseSystemdUserService(spawn)).toBe(false);
  });
});

describe('probeSystemdUserService', () => {
  test('captures stderr from systemctl --version failure', () => {
    const stderr = new TextEncoder().encode('bash: systemctl: command not found');
    const spawn = makeSpawn({
      'systemctl --user --version': { exitCode: 127, stderr },
    });
    const result = probeSystemdUserService(spawn);
    expect(result.supported).toBe(false);
    expect(result.reason).toContain('systemctl: command not found');
  });

  test('captures stderr when bus is unreachable (WSL2 without systemd)', () => {
    const stderr = new TextEncoder().encode('Failed to connect to bus: No such file or directory');
    const spawn = makeSpawn({
      'systemctl --user --version': ok,
      'systemctl --user is-system-running': { exitCode: 1, stderr },
      'systemctl --user show-environment': { exitCode: 1, stderr },
    });
    const result = probeSystemdUserService(spawn);
    expect(result.supported).toBe(false);
    expect(result.reason).toContain('Failed to connect to bus');
  });

  test('returns supported=true with no reason when bus is reachable', () => {
    const spawn = makeSpawn({
      'systemctl --user --version': ok,
      'systemctl --user is-system-running': ok,
    });
    expect(probeSystemdUserService(spawn)).toEqual({ supported: true });
  });

  test('returns supported=true when show-environment fallback succeeds', () => {
    const spawn = makeSpawn({
      'systemctl --user --version': ok,
      'systemctl --user is-system-running': fail,
      'systemctl --user show-environment': ok,
    });
    expect(probeSystemdUserService(spawn)).toEqual({ supported: true });
  });

  test('reports spawn exception message', () => {
    const spawn: SpawnSyncFn = () => {
      throw new Error('ENOENT: systemctl missing');
    };
    const result = probeSystemdUserService(spawn);
    expect(result.supported).toBe(false);
    expect(result.reason).toContain('ENOENT');
  });

  test('first line only when stderr has multiple lines', () => {
    const stderr = new TextEncoder().encode('line one\nline two\nline three');
    const spawn = makeSpawn({
      'systemctl --user --version': { exitCode: 1, stderr },
    });
    const result = probeSystemdUserService(spawn);
    expect(result.reason).toBe('line one');
  });
});

describe('isLaunchdAlreadyLoaded', () => {
  test('returns false when exit code is 0 (genuine success)', () => {
    expect(isLaunchdAlreadyLoaded({ exitCode: 0 })).toBe(false);
  });

  test('returns false when output is empty on failure', () => {
    expect(isLaunchdAlreadyLoaded({ exitCode: 1 })).toBe(false);
  });

  test('detects "already loaded" phrasing', () => {
    const stderr = new TextEncoder().encode('Load failed: service already loaded');
    expect(isLaunchdAlreadyLoaded({ exitCode: 1, stderr })).toBe(true);
  });

  test('detects "already bootstrapped" phrasing', () => {
    const stderr = new TextEncoder().encode('Bootstrap failed: 5: Input/output error\nservice already bootstrapped');
    expect(isLaunchdAlreadyLoaded({ exitCode: 1, stderr })).toBe(true);
  });

  test('detects "service already exists" phrasing', () => {
    const stdout = new TextEncoder().encode('launchctl: service already exists');
    expect(isLaunchdAlreadyLoaded({ exitCode: 1, stdout })).toBe(true);
  });

  test('detects "Service already loaded" with mixed case', () => {
    const stderr = new TextEncoder().encode('Launchctl Error: Service Already Loaded');
    expect(isLaunchdAlreadyLoaded({ exitCode: 1, stderr })).toBe(true);
  });

  test('returns false for unrelated failure messages', () => {
    const stderr = new TextEncoder().encode('Load failed: 5: Input/output error');
    expect(isLaunchdAlreadyLoaded({ exitCode: 1, stderr })).toBe(false);
  });
});

describe('scheduleSystemdRestart', () => {
  test('uses --no-block so caller returns before systemd cycles the unit', () => {
    const calls: string[][] = [];
    const spawn: SpawnSyncFn = (cmd) => {
      calls.push(cmd);
      return ok;
    };
    expect(scheduleSystemdRestart(spawn)).toBe(true);
    expect(calls[0]).toEqual(['systemctl', '--user', '--no-block', 'restart', 'jarvis.service']);
  });

  test('returns false when systemctl exits non-zero', () => {
    const spawn: SpawnSyncFn = () => ({ exitCode: 5 });
    expect(scheduleSystemdRestart(spawn)).toBe(false);
  });

  test('returns false when spawn throws', () => {
    const spawn: SpawnSyncFn = () => {
      throw new Error('boom');
    };
    expect(scheduleSystemdRestart(spawn)).toBe(false);
  });
});

describe('decodeLaunchctlOutput', () => {
  test('decodes Uint8Array', () => {
    const buf = new TextEncoder().encode('hello');
    expect(decodeLaunchctlOutput(buf)).toBe('hello');
  });

  test('decodes ArrayBuffer', () => {
    const buf = new TextEncoder().encode('world').buffer as ArrayBuffer;
    expect(decodeLaunchctlOutput(buf)).toBe('world');
  });

  test('returns empty string for null', () => {
    expect(decodeLaunchctlOutput(null)).toBe('');
  });

  test('returns empty string for undefined', () => {
    expect(decodeLaunchctlOutput(undefined)).toBe('');
  });
});
