import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';
import {
  canUseSystemdUserService,
  generateLaunchdPlist,
  generateSystemdUnit,
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

// ── Service definitions carry the data root ──────────────────────────
//
// The daemon resolves its lock AND its logs through JARVIS_HOME. A service
// definition that doesn't export the var launches a daemon under ~/.jarvis
// while every CLI tool in the same shell looks under $JARVIS_HOME.
describe('service definitions propagate JARVIS_HOME', () => {
  function withJarvisHome<T>(value: string | undefined, fn: () => T): T {
    const prev = process.env.JARVIS_HOME;
    if (value === undefined) delete process.env.JARVIS_HOME;
    else process.env.JARVIS_HOME = value;
    try { return fn(); } finally {
      if (prev === undefined) delete process.env.JARVIS_HOME;
      else process.env.JARVIS_HOME = prev;
    }
  }

  test('systemd unit omits JARVIS_HOME when unset', () => {
    const unit = withJarvisHome(undefined, generateSystemdUnit);
    expect(unit).not.toContain('JARVIS_HOME');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('Environment=HOME=');
  });

  test('systemd unit exports JARVIS_HOME when set', () => {
    const unit = withJarvisHome('/srv/tenant7', generateSystemdUnit);
    expect(unit).toContain('Environment="JARVIS_HOME=/srv/tenant7"');
    // The section header must not get swallowed by the injected line.
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=default.target');
  });

  test('launchd plist logs under JARVIS_HOME and exports it', () => {
    const plist = withJarvisHome('/srv/tenant7', generateLaunchdPlist);
    expect(plist).toContain('<string>/srv/tenant7/logs/jarvis.log</string>');
    expect(plist).toContain('<key>JARVIS_HOME</key>');
    expect(plist).toContain('<string>/srv/tenant7</string>');
  });

  test('launchd plist falls back to ~/.jarvis/logs with no JARVIS_HOME', () => {
    const plist = withJarvisHome(undefined, generateLaunchdPlist);
    expect(plist).toContain('/.jarvis/logs/jarvis.log');
    expect(plist).not.toContain('JARVIS_HOME');
  });

  // systemd splits an unquoted Environment= on whitespace and reads % as a
  // specifier introducer. Either would truncate the path and put the daemon on
  // a different root than the CLI — the split this line exists to close.
  test('systemd quotes a data root containing spaces and escapes %', () => {
    const unit = withJarvisHome('/srv/my data/100%', generateSystemdUnit);
    expect(unit).toContain('Environment="JARVIS_HOME=/srv/my data/100%%"');
  });

  // An unescaped & or < yields a plist launchctl refuses to load, so autostart
  // silently does nothing.
  test('launchd plist XML-escapes the data root', () => {
    const plist = withJarvisHome('/srv/a&b/<c>', generateLaunchdPlist);
    expect(plist).toContain('<string>/srv/a&amp;b/&lt;c&gt;</string>');
    expect(plist).not.toContain('/srv/a&b/<c>');
  });

  // ── The generated files must be valid to the tools that consume them ──
  //
  // "contains the right substring" is not enough: systemd and launchctl reject
  // malformed input, and a rejected service definition means autostart quietly
  // does nothing.

  const SYSTEMD_ANALYZE = Bun.which('systemd-analyze');
  test.skipIf(!SYSTEMD_ANALYZE)('systemd-analyze accepts the generated unit', () => {
    const unit = withJarvisHome('/srv/my data/100%', generateSystemdUnit);
    const path = join(mkdtempSync(join(tmpdir(), 'jarvis-unit-')), 'jarvis-verify.service');
    writeFileSync(path, unit, 'utf-8');
    const r = Bun.spawnSync([SYSTEMD_ANALYZE!, 'verify', path], { stdout: 'pipe', stderr: 'pipe' });
    const out = `${r.stdout.toString()}${r.stderr.toString()}`.trim();
    expect({ code: r.exitCode, out }).toEqual({ code: 0, out: '' });
  });

  // plutil is macOS-only; xmllint covers well-formedness everywhere else.
  const PLIST_LINT = Bun.which('plutil') ?? Bun.which('xmllint');
  test.skipIf(!PLIST_LINT)('the generated plist parses with a hostile data root', () => {
    const plist = withJarvisHome('/srv/a&b/<c>/"d"', generateLaunchdPlist);
    const path = join(mkdtempSync(join(tmpdir(), 'jarvis-plist-')), 'jarvis.plist');
    writeFileSync(path, plist, 'utf-8');
    const cmd = PLIST_LINT!.endsWith('plutil')
      ? [PLIST_LINT!, '-lint', path]
      : [PLIST_LINT!, '--noout', path];
    const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
    expect({ code: r.exitCode, err: r.stderr.toString().trim() }).toEqual({ code: 0, err: '' });
  });
});
