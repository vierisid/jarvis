import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import {
  canUseSystemdUserService,
  checkInstalledLaunchdPlist,
  checkInstalledSystemdUnit,
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
    // The unit's StartLimitBurst counts deliberate restarts too, so the
    // rate-limit is cleared BEFORE the restart is queued: otherwise --no-block
    // returns 0 and this reports success while the unit refuses to start.
    expect(calls).toEqual([
      ['systemctl', '--user', 'reset-failed', 'jarvis.service'],
      ['systemctl', '--user', '--no-block', 'restart', 'jarvis.service'],
    ]);
  });

  test('a unit that was never failed still restarts (reset-failed is advisory)', () => {
    // `reset-failed` exits non-zero for a unit with nothing to reset on some
    // systemd versions; that must not stop the restart or the report.
    const spawn: SpawnSyncFn = (cmd) => (cmd.includes('reset-failed') ? fail : ok);
    expect(scheduleSystemdRestart(spawn)).toBe(true);
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

  // #514: an import-environment (or launchctl setenv) from the assistant's
  // marked shell must not mark the service -- see util/model-exec-marker.ts.
  test('the service never carries the model-exec markers', () => {
    const unit = withJarvisHome(undefined, generateSystemdUnit);
    expect(unit).toContain('UnsetEnvironment=JARVIS_MODEL_EXEC JARVIS_MODEL_EXEC_ENV_KEY\n');
    const plist = withJarvisHome(undefined, generateLaunchdPlist);
    expect(plist).toContain('<key>JARVIS_MODEL_EXEC</key>\n    <string></string>');
    expect(plist).toContain('<key>JARVIS_MODEL_EXEC_ENV_KEY</key>\n    <string></string>');
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

// ── The generated unit's restart + open policy (#543, #544) ──────────
//
// An installed unit is only rewritten when autostart is reinstalled, so these
// assert the GENERATOR's text rather than any file on this machine.
describe('generated systemd unit: restart policy and the open step', () => {
  /** Split a unit into `{ '[Section]': ['KEY=VALUE', ...] }`, comments dropped. */
  function sections(unit: string): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    let current = '';
    for (const raw of unit.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      if (line.startsWith('[')) {
        current = line;
        out[current] ??= [];
        continue;
      }
      (out[current] ??= []).push(line);
    }
    return out;
  }

  function directive(unit: string, section: string, key: string): string[] {
    return (sections(unit)[section] ?? [])
      .filter((line) => line.slice(0, line.indexOf('=')) === key)
      .map((line) => line.slice(line.indexOf('=') + 1));
  }

  test('ExecStart passes --no-open, so a service start never opens a browser', () => {
    const execStart = directive(generateSystemdUnit(), '[Service]', 'ExecStart');
    expect(execStart).toHaveLength(1);
    // Token-wise: `--no-open` has to be its own argument, since bin/jarvis.ts
    // matches it with args.includes('--no-open').
    const argv = execStart[0]!.split(/\s+/);
    expect(argv).toContain('start');
    expect(argv).toContain('--foreground');
    expect(argv).toContain('--no-open');
  });

  test('a crash is restarted, and a clean exit is left alone', () => {
    const unit = generateSystemdUnit();
    // on-failure, not always: `jarvis stop` SIGTERMs the daemon directly and
    // the drain exits 0. Under `always` systemd would undo a deliberate stop.
    expect(directive(unit, '[Service]', 'Restart')).toEqual(['on-failure']);
    expect(directive(unit, '[Service]', 'RestartSec')).toEqual(['5']);
  });

  test('a fast-failing daemon cannot spin: the start limit is explicit', () => {
    const unit = generateSystemdUnit();
    const interval = Number(directive(unit, '[Unit]', 'StartLimitIntervalSec')[0]);
    const burst = Number(directive(unit, '[Unit]', 'StartLimitBurst')[0]);
    const restartSec = Number(directive(unit, '[Service]', 'RestartSec')[0]);
    expect(Number.isFinite(interval)).toBe(true);
    expect(Number.isFinite(burst)).toBe(true);
    // The whole burst has to fit inside the window at this RestartSec,
    // otherwise systemd never reaches the limit and the loop is unbounded.
    expect(burst * restartSec).toBeLessThan(interval);

    // systemd IGNORES StartLimitIntervalSec in [Service] (it belongs to [Unit]),
    // which would silently leave the loop unbounded. StartLimitBurst there is
    // accepted for compatibility, but keep both in one place.
    for (const key of ['StartLimitIntervalSec', 'StartLimitBurst', 'StartLimitInterval']) {
      expect(directive(unit, '[Service]', key)).toEqual([]);
    }
  });

  test('every line is a directive in a known section', () => {
    const parsed = sections(generateSystemdUnit());
    expect(Object.keys(parsed).sort()).toEqual(['[Install]', '[Service]', '[Unit]']);
    for (const [section, lines] of Object.entries(parsed)) {
      for (const line of lines) {
        expect({ section, line }).toEqual({ section, line: expect.stringMatching(/^[A-Za-z][A-Za-z0-9]*=/) });
      }
    }
  });
});

// ── Is the installed definition still the one we would write? ────────
//
// Nothing in the product reinstalls autostart, so a unit written before
// #543/#544 stays as it is. These check the detector that says so, and above
// all that it stays QUIET unless it is sure: it can only nag.
describe('checkInstalledSystemdUnit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-drift-'));
  let seq = 0;
  function unitFile(body: string): string {
    const path = join(dir, `unit-${seq++}.service`);
    writeFileSync(path, body, 'utf-8');
    return path;
  }

  const current = generateSystemdUnit();

  test('the unit we generate today has nothing to report', () => {
    expect(checkInstalledSystemdUnit(unitFile(current))).toBeNull();
  });

  test('nothing installed is not drift', () => {
    expect(checkInstalledSystemdUnit(join(dir, 'absent.service'))).toBeNull();
  });

  test('the pre-#544 unit is reported for both problems', () => {
    const old = `[Unit]
Description=J.A.R.V.I.S. Daemon
After=network.target

[Service]
Type=simple
ExecStart=/home/u/.bun/bin/bun /home/u/jarvis/bin/jarvis.ts start --foreground
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
    const drift = checkInstalledSystemdUnit(unitFile(old));
    expect(drift?.problems.sort()).toEqual(['opens-a-browser', 'unbounded-restarts']);
  });

  test('a drop-in directory silences it: the override can fix either problem', () => {
    // docs/SELF_HOSTING.md tells people to `systemctl --user edit`, which writes
    // jarvis.service.d/override.conf. Reading the main file alone would nag
    // someone who already fixed it, forever.
    const path = unitFile('[Service]\nExecStart=/bin/bun /x/jarvis.ts start --foreground\nRestart=always\nRestartSec=5\n');
    expect(checkInstalledSystemdUnit(path)?.problems).toEqual(['opens-a-browser', 'unbounded-restarts']);
    mkdirSync(`${path}.d`, { recursive: true });
    expect(checkInstalledSystemdUnit(path)).toBeNull();
  });

  test('indentation, CRLF and a line continuation are not drift', () => {
    // systemd accepts all three; a regex over raw lines would read the
    // continued ExecStart as ending before --no-open.
    const path = unitFile(
      '[Service]\r\n  Type=simple\r\n  ExecStart=/bin/bun /x/jarvis.ts \\\r\n    start --foreground --no-open\r\n  Restart=on-failure\r\n  RestartSec=5\r\n  StartLimitBurst=5\r\n',
    );
    expect(checkInstalledSystemdUnit(path)).toBeNull();
  });

  test('an ExecStart reset that ends with --no-open is not drift', () => {
    const path = unitFile('[Unit]\nStartLimitBurst=5\n\n[Service]\nExecStart=\nExecStart=-/bin/bun /x/jarvis.ts start --foreground --no-open\nRestart=on-failure\nRestartSec=5\n');
    expect(checkInstalledSystemdUnit(path)).toBeNull();
  });

  test('a quoted --no-open counts, and --no-open=true does not', () => {
    const quoted = unitFile('[Service]\nExecStart=/bin/bun /x/jarvis.ts "start" "--foreground" "--no-open"\n');
    expect(checkInstalledSystemdUnit(quoted)).toBeNull();
    // bin/jarvis.ts matches the exact token, so this really does open a browser.
    const valued = unitFile('[Service]\nExecStart=/bin/bun /x/jarvis.ts start --no-open=true\n');
    expect(checkInstalledSystemdUnit(valued)?.problems).toEqual(['opens-a-browser']);
  });

  test('a unit that does not restart is not reported for restart limits', () => {
    const path = unitFile('[Service]\nExecStart=/bin/bun /x/jarvis.ts start --no-open\nRestart=no\nRestartSec=5\n');
    expect(checkInstalledSystemdUnit(path)).toBeNull();
  });

  test('a short RestartSec is bounded by systemd own default limit', () => {
    // 5 starts per 10s is the default: at RestartSec=1 systemd reaches it by
    // itself, so there is nothing to report.
    const path = unitFile('[Service]\nExecStart=/bin/bun /x/jarvis.ts start --no-open\nRestart=always\nRestartSec=1\n');
    expect(checkInstalledSystemdUnit(path)).toBeNull();
  });

  test('a StartLimit key the user set themselves is left alone', () => {
    for (const key of ['StartLimitBurst=3', 'StartLimitIntervalSec=60', 'StartLimitInterval=60']) {
      const path = unitFile(`[Unit]\n${key}\n\n[Service]\nExecStart=/bin/bun /x/jarvis.ts start --no-open\nRestart=always\nRestartSec=9\n`);
      expect(checkInstalledSystemdUnit(path)).toBeNull();
    }
  });

  test('comments cannot fake a directive', () => {
    const path = unitFile('[Service]\n# ExecStart=/bin/bun /x/jarvis.ts start --no-open\n; StartLimitBurst=5\nExecStart=/bin/bun /x/jarvis.ts start\nRestart=on-failure\nRestartSec=5\n');
    expect(checkInstalledSystemdUnit(path)?.problems.sort()).toEqual(['opens-a-browser', 'unbounded-restarts']);
  });
});

describe('checkInstalledLaunchdPlist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-drift-plist-'));

  test('the plist we generate today has nothing to report', () => {
    const path = join(dir, 'current.plist');
    writeFileSync(path, generateLaunchdPlist(), 'utf-8');
    expect(checkInstalledLaunchdPlist(path)).toBeNull();
  });

  test('a --no-open outside ProgramArguments does not count', () => {
    const path = join(dir, 'decoy.plist');
    writeFileSync(path, `<plist><dict>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bun</string>
    <string>/x/jarvis.ts</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>Comment</key>
  <string>--no-open</string>
</dict></plist>
`, 'utf-8');
    expect(checkInstalledLaunchdPlist(path)?.problems).toEqual(['opens-a-browser']);
  });

  test('nothing installed is not drift', () => {
    expect(checkInstalledLaunchdPlist(join(dir, 'absent.plist'))).toBeNull();
  });
});

describe('generated launchd plist: the open step', () => {
  test('ProgramArguments passes --no-open', () => {
    const plist = generateLaunchdPlist();
    // Sliced to the array, so a match under some unrelated key cannot pass it.
    const start = plist.indexOf('<key>ProgramArguments</key>');
    expect(start).toBeGreaterThan(-1);
    const argv = plist.slice(start, plist.indexOf('</array>', start));
    expect(argv).toContain('<string>--foreground</string>');
    expect(argv).toContain('<string>--no-open</string>');
  });
});
