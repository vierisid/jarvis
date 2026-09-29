import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  canUseSystemdUserService,
  checkInstalledLaunchdPlist,
  checkInstalledSystemdUnit,
  describeAutostartProblem,
  generateLaunchdPlist,
  generateSystemdUnit,
  decodeLaunchctlOutput,
  isLaunchdAlreadyLoaded,
  isLaunchdNotLoaded,
  enableAutostart,
  meaningfulAutostartLines,
  probeSystemdUserService,
  readAutostartEnabled,
  readPlistKeepAlive,
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

// plutil is macOS-only; xmllint covers well-formedness everywhere else. Module
// scope, because both the generator tests and the KeepAlive tests lint a plist.
const PLIST_LINT = Bun.which('plutil') ?? Bun.which('xmllint');

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
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
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
    writeFileSync(join(`${path}.d`, 'override.conf'), '[Service]\nRestart=no\n', 'utf-8');
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

  test("a unit JARVIS did not write is not judged at all", () => {
    // Someone else's jarvis.service: a wrapper script, a container, a shell that
    // passes --no-open itself. Nagging about it on every `jarvis status` would
    // be unsilenceable, so the detector only reads units shaped like the ones
    // generateSystemdUnit writes (`... jarvis.ts start --foreground`).
    for (const exec of [
      '/home/u/bin/run-jarvis.sh',
      '/usr/bin/docker run --rm ghcr.io/vierisid/jarvis',
      '/bin/sh -c "exec jarvis serve"',
    ]) {
      const path = unitFile(`[Service]\nExecStart=${exec}\nRestart=on-failure\nRestartSec=5\n`);
      expect(checkInstalledSystemdUnit(path)).toBeNull();
    }
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

  test('StartLimitAction alone does not count as a limit', () => {
    // It says what to do AT the limit, not what the limit is, so a unit with
    // only that key is still restarted forever.
    const path = unitFile('[Unit]\nStartLimitAction=none\n\n[Service]\nExecStart=/bin/bun /x/jarvis.ts start --no-open\nRestart=always\nRestartSec=9\n');
    expect(checkInstalledSystemdUnit(path)?.problems).toEqual(['unbounded-restarts']);
  });

  test('a RestartSec written as a time span counts like a bare number', () => {
    // All valid systemd, and all far enough apart that its default 5-in-10s
    // limit never fires: the loop really is unbounded.
    for (const value of ['5s', '5sec', '2min', '10000ms']) {
      const path = unitFile(`[Service]\nExecStart=/bin/bun /x/jarvis.ts start --no-open\nRestart=always\nRestartSec=${value}\n`);
      expect(checkInstalledSystemdUnit(path)?.problems).toEqual(['unbounded-restarts']);
    }
    // Under 2s, systemd's own default limit ends the loop: nothing to report.
    for (const value of ['1s', '500ms', '1']) {
      const path = unitFile(`[Service]\nExecStart=/bin/bun /x/jarvis.ts start --no-open\nRestart=always\nRestartSec=${value}\n`);
      expect(checkInstalledSystemdUnit(path)).toBeNull();
    }
    // Unreadable: stay silent rather than guess.
    const odd = unitFile('[Service]\nExecStart=/bin/bun /x/jarvis.ts start --no-open\nRestart=always\nRestartSec=infinity\n');
    expect(checkInstalledSystemdUnit(odd)).toBeNull();
  });

  test('an empty drop-in directory does not silence it', () => {
    // A `systemctl edit` somebody aborted leaves the directory with no .conf in
    // it, and overrides nothing.
    const path = unitFile('[Service]\nExecStart=/bin/bun /x/jarvis.ts start --foreground\nRestart=on-failure\nRestartSec=5\n');
    mkdirSync(`${path}.d`, { recursive: true });
    expect(checkInstalledSystemdUnit(path)?.problems.sort()).toEqual(['opens-a-browser', 'unbounded-restarts']);
    writeFileSync(join(`${path}.d`, 'override.conf'), '[Service]\nExecStart=\nExecStart=/bin/bun /x/jarvis.ts start --no-open\n', 'utf-8');
    expect(checkInstalledSystemdUnit(path)).toBeNull();
  });

  test('every problem has a one-line plain-ASCII description', () => {
    // The only user-visible strings in the feature (printed by `jarvis status`).
    for (const problem of ['opens-a-browser', 'unbounded-restarts', 'relaunches-after-a-clean-stop'] as const) {
      const text = describeAutostartProblem(problem);
      expect(text).toMatch(/^[\x20-\x7e]+$/);
      expect(text.length).toBeGreaterThan(20);
    }
    expect(describeAutostartProblem('opens-a-browser')).toContain('browser');
    expect(describeAutostartProblem('unbounded-restarts')).toContain('restart');
    expect(describeAutostartProblem('relaunches-after-a-clean-stop')).toContain('jarvis stop');
  });

  test('comments cannot fake a directive', () => {
    const path = unitFile('[Service]\n# ExecStart=/bin/bun /x/jarvis.ts start --no-open\n; StartLimitBurst=5\nExecStart=/bin/bun /x/jarvis.ts start\nRestart=on-failure\nRestartSec=5\n');
    expect(checkInstalledSystemdUnit(path)?.problems.sort()).toEqual(['opens-a-browser', 'unbounded-restarts']);
  });
});

describe('checkInstalledLaunchdPlist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-drift-plist-'));
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  function plistFile(name: string, body: string): string {
    const path = join(dir, `${name}.plist`);
    writeFileSync(path, body, 'utf-8');
    return path;
  }

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

  // #549: the half of the old plist that `jarvis status` could not see before.
  // A KeepAlive=true plist is exactly what every version up to now installed,
  // and `jarvis autostart` can now replace it, so saying so is actionable.
  test('KeepAlive=true is reported even when the rest is current', () => {
    const path = join(dir, 'keepalive-true.plist');
    writeFileSync(path, generateLaunchdPlist().replace(
      /<key>KeepAlive<\/key>\s*<dict>[\s\S]*?<\/dict>/,
      '<key>KeepAlive</key>\n  <true/>',
    ), 'utf-8');
    expect(checkInstalledLaunchdPlist(path)?.problems).toEqual(['relaunches-after-a-clean-stop']);
  });

  test('an older plist reports both problems, in the order they bite', () => {
    const path = join(dir, 'old.plist');
    writeFileSync(path, `<plist><dict>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bun</string>
    <string>/x/jarvis.ts</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>KeepAlive</key>
  <true/>
</dict></plist>
`, 'utf-8');
    expect(checkInstalledLaunchdPlist(path)?.problems).toEqual(['opens-a-browser', 'relaunches-after-a-clean-stop']);
  });

  // Reading the FIRST of two KeepAlive keys would nag this user, who appended a
  // corrected block to a plist an older JARVIS wrote, although they have fixed it.
  test('a duplicated KeepAlive key is not reported either way', () => {
    const argv = '<array><string>/bin/bun</string><string>/x/jarvis.ts</string><string>start</string><string>--foreground</string><string>--no-open</string></array>';
    const fixed = plistFile('dup-fixed', `<plist><dict>
  <key>ProgramArguments</key>
  ${argv}
  <key>KeepAlive</key>
  <true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
</dict></plist>
`);
    expect(checkInstalledLaunchdPlist(fixed)).toBeNull();
    const broken = plistFile('dup-broken', `<plist><dict>
  <key>ProgramArguments</key>
  ${argv}
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>KeepAlive</key>
  <true/>
</dict></plist>
`);
    expect(checkInstalledLaunchdPlist(broken)).toBeNull();
  });

  test('a KeepAlive this cannot read is not reported, and does not hide the rest', () => {
    // 'unknown' means quiet: only the --no-open problem may come out of this.
    const path = plistFile('odd-keepalive', `<plist><dict>
  <key>ProgramArguments</key>
  <array><string>/bin/bun</string><string>/x/jarvis.ts</string><string>start</string><string>--foreground</string></array>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/><key>NetworkState</key><true/></dict>
</dict></plist>
`);
    expect(checkInstalledLaunchdPlist(path)?.problems).toEqual(['opens-a-browser']);
  });

  // Same bar as checkInstalledSystemdUnit: somebody else's launch agent, which
  // runs a wrapper rather than `jarvis start`, is not judged at all.
  test('an agent that does not run `jarvis start` is left alone', () => {
    const path = join(dir, 'foreign.plist');
    writeFileSync(path, `<plist><dict>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/my-jarvis-wrapper.sh</string>
  </array>
  <key>KeepAlive</key>
  <true/>
</dict></plist>
`, 'utf-8');
    expect(checkInstalledLaunchdPlist(path)).toBeNull();
  });
});

// ── #549: what KeepAlive means, read back from plist text ────────────
describe('readPlistKeepAlive', () => {
  test('the plist we generate today relaunches only after a failure', () => {
    expect(readPlistKeepAlive(generateLaunchdPlist())).toBe('on-failure');
  });

  test('a bare true is "after any exit", a bare false is "never"', () => {
    expect(readPlistKeepAlive('<key>KeepAlive</key>\n<true/>')).toBe('always');
    expect(readPlistKeepAlive('<key>KeepAlive</key> <true />')).toBe('always');
    expect(readPlistKeepAlive('<key>KeepAlive</key><true></true>')).toBe('always');
    expect(readPlistKeepAlive('<key>KeepAlive</key>\n<false/>')).toBe('never');
  });

  test('no KeepAlive key at all is absent, not a guess', () => {
    expect(readPlistKeepAlive(generateSystemdUnit())).toBe('absent');
    expect(readPlistKeepAlive('<plist><dict><key>RunAtLoad</key><true/></dict></plist>')).toBe('absent');
  });

  test('a commented-out value is not the value', () => {
    expect(readPlistKeepAlive('<!-- <key>KeepAlive</key><true/> -->')).toBe('absent');
    expect(readPlistKeepAlive('<key>KeepAlive</key><!-- <true/> --><false/>')).toBe('never');
  });

  // launchd ORs a dict's conditions, so anything beyond SuccessfulExit=false
  // changes the answer in a way this must not pretend to know.
  test('only SuccessfulExit=false alone reads as on-failure', () => {
    const dict = (body: string) => `<key>KeepAlive</key><dict>${body}</dict>`;
    expect(readPlistKeepAlive(dict('<key>SuccessfulExit</key><false/>'))).toBe('on-failure');
    expect(readPlistKeepAlive(dict('<key>SuccessfulExit</key><true/>'))).toBe('unknown');
    expect(readPlistKeepAlive(dict('<key>SuccessfulExit</key><false/><key>Crashed</key><false/>'))).toBe('unknown');
    expect(readPlistKeepAlive(dict('<key>NetworkState</key><true/>'))).toBe('unknown');
    // A nested condition (PathState, OtherJobEnabled) is `unknown` through the
    // key count, whether or not the depth walk that bounds the dict is right;
    // the walk itself only decides the unterminated case below.
    expect(readPlistKeepAlive(
      dict('<key>PathState</key><dict><key>/tmp/x</key><true/></dict><key>SuccessfulExit</key><false/>'),
    )).toBe('unknown');
    expect(readPlistKeepAlive(dict(''))).toBe('unknown');
  });

  test('an unterminated or unrecognised value is unknown, never a guess', () => {
    expect(readPlistKeepAlive('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/>')).toBe('unknown');
    expect(readPlistKeepAlive('<key>KeepAlive</key><string>yes</string>')).toBe('unknown');
    // A KeepAlive that is not a boolean or a dict at all: launchd's own
    // coercion is not something to reproduce from a regex.
    expect(readPlistKeepAlive('<key>KeepAlive</key><integer>1</integer>')).toBe('unknown');
    // A condition with no value.
    expect(readPlistKeepAlive('<key>KeepAlive</key><dict><key>SuccessfulExit</key></dict>')).toBe('unknown');
  });

  // A plist parser takes the LAST of a duplicated key, so reading the first
  // would be wrong in both directions: it would nag somebody who appended a
  // corrected block, and stay silent for somebody who appended `<true/>` after
  // the dict. Neither order is guessed.
  test('a duplicated KeepAlive key is unknown, in either order', () => {
    const dict = '<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>';
    expect(readPlistKeepAlive(`${dict}<key>KeepAlive</key><true/>`)).toBe('unknown');
    expect(readPlistKeepAlive(`<key>KeepAlive</key><true/>${dict}`)).toBe('unknown');
  });
});

describe('generated launchd plist: the open step and the restart policy', () => {
  test('ProgramArguments passes --no-open', () => {
    const plist = generateLaunchdPlist();
    // Sliced to the array, so a match under some unrelated key cannot pass it.
    const start = plist.indexOf('<key>ProgramArguments</key>');
    expect(start).toBeGreaterThan(-1);
    const argv = plist.slice(start, plist.indexOf('</array>', start));
    expect(argv).toContain('<string>--foreground</string>');
    expect(argv).toContain('<string>--no-open</string>');
  });

  // #549: KeepAlive=true relaunched the daemon after the clean drain a `jarvis
  // stop` triggers, so the stop was undone ~10s later while the CLI printed
  // success. The dict is launchd's Restart=on-failure.
  test('KeepAlive is a dict with SuccessfulExit=false, not a bare true', () => {
    const plist = generateLaunchdPlist();
    expect(plist).toContain('<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>');
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\s*\/>/);
    expect(readPlistKeepAlive(plist)).toBe('on-failure');
  });

  test('RunAtLoad stays true, so the agent still starts the daemon at login', () => {
    // Without it, SuccessfulExit=false alone would only ever RE-launch.
    expect(generateLaunchdPlist()).toContain('<key>RunAtLoad</key>\n  <true/>');
  });

  test('the linted plist is the one the detector reads back', () => {
    const plist = generateLaunchdPlist();
    const path = join(mkdtempSync(join(tmpdir(), 'jarvis-plist-keepalive-')), 'jarvis.plist');
    writeFileSync(path, plist, 'utf-8');
    if (PLIST_LINT) {
      const cmd = PLIST_LINT.endsWith('plutil') ? [PLIST_LINT, '-lint', path] : [PLIST_LINT, '--noout', path];
      const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
      expect({ code: r.exitCode, err: r.stderr.toString().trim() }).toEqual({ code: 0, err: '' });
    }
    expect(checkInstalledLaunchdPlist(path)).toBeNull();
  });

  // A real property-list parser, because the lint above proves less than it
  // looks: `xmllint --noout` is well-formedness only (the Apple DOCTYPE is not
  // fetched without --valid), so a <key> with no value, or a KeepAlive nested
  // one level too deep, would pass it and then be read by launchd as something
  // else entirely. plutil does validate, but only exists on macOS; plistlib is
  // the same parser Apple's tooling uses, and it types the values too.
  const PYTHON = Bun.which('python3') ?? Bun.which('python');
  test.skipIf(!PYTHON)('a property-list parser reads back exactly the keys we meant', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'jarvis-plist-parse-')), 'jarvis.plist');
    writeFileSync(path, generateLaunchdPlist(), 'utf-8');
    const script = [
      'import json,plistlib,sys',
      'p=plistlib.load(open(sys.argv[1],"rb"))',
      'print(json.dumps({"keepalive":p.get("KeepAlive"),"runatload":p.get("RunAtLoad"),"argv":p.get("ProgramArguments")}))',
    ].join('\n');
    const r = Bun.spawnSync([PYTHON!, '-c', script, path], { stdout: 'pipe', stderr: 'pipe' });
    expect({ code: r.exitCode, err: r.stderr.toString().trim() }).toEqual({ code: 0, err: '' });
    const parsed = JSON.parse(r.stdout.toString()) as {
      keepalive: unknown; runatload: unknown; argv: string[];
    };
    // The whole of #549 in one assertion: a dict with that one condition, and
    // nothing else that could OR a clean-exit relaunch back in.
    expect(parsed.keepalive).toEqual({ SuccessfulExit: false });
    expect(parsed.runatload).toBe(true);
    expect(parsed.argv.slice(-3)).toEqual(['start', '--foreground', '--no-open']);
  });
});

// ── Is the installed definition armed? (#548) ────────────────────────
//
// `jarvis autostart --status` reports this, and `jarvis autostart` repairs a
// definition that is current but not enabled -- installSystemd writes the file
// before it reloads and enables, so a failure at either leaves exactly that. A
// wrong `false` makes the status lie; a wrong `true` leaves the unit unrepaired.
describe('readAutostartEnabled', () => {
  const IS_ENABLED = 'systemctl --user is-enabled jarvis.service';
  const withStdout = (exitCode: number, text: string): SpawnResultLike =>
    ({ exitCode, stdout: new TextEncoder().encode(text) });
  const withStderr = (exitCode: number, text: string): SpawnResultLike =>
    ({ exitCode, stderr: new TextEncoder().encode(text) });

  test.skipIf(process.platform !== 'linux')('exit 0 is enabled, whatever the word', () => {
    // enabled, enabled-runtime, static, indirect, generated, transient and alias
    // all exit 0, and all mean systemd starts it without being asked.
    for (const word of ['enabled', 'enabled-runtime', 'static', 'generated']) {
      expect(readAutostartEnabled(makeSpawn({ [IS_ENABLED]: withStdout(0, `${word}\n`) }))).toBe(true);
    }
  });

  test.skipIf(process.platform !== 'linux')('a state word on stdout is a definite no', () => {
    for (const word of ['disabled', 'masked', 'masked-runtime', 'linked', 'linked-runtime', 'bad']) {
      expect(readAutostartEnabled(makeSpawn({ [IS_ENABLED]: withStdout(1, `${word}\n`) }))).toBe(false);
    }
  });

  // An unreachable user manager says nothing at all about the unit, and must not
  // be reported as "not enabled": that would send `jarvis autostart` off to
  // enable a unit on a machine where nothing can.
  test.skipIf(process.platform !== 'linux')('an error instead of a state word stays unknown', () => {
    for (const err of [
      'Failed to connect to bus: No such file or directory',
      'Failed to get unit file state for jarvis.service: No such file or directory',
      '',
    ]) {
      expect(readAutostartEnabled(makeSpawn({ [IS_ENABLED]: withStderr(1, err) }))).toBeNull();
    }
    // A state word inside an error message is not the state: only the first line
    // of STDOUT counts, which is where systemctl prints it.
    expect(readAutostartEnabled(makeSpawn({
      [IS_ENABLED]: withStderr(1, 'Unit jarvis.service could not be masked or disabled'),
    }))).toBeNull();
  });

  test.skipIf(process.platform !== 'linux')('a spawn that throws is unknown, not a no', () => {
    expect(readAutostartEnabled(() => { throw new Error('ENOENT'); })).toBeNull();
  });

  test.skipIf(process.platform === 'linux')('off Linux there is nothing to ask', () => {
    // launchd has no is-enabled: a plist in ~/Library/LaunchAgents is loaded at
    // login by being there. Answering `false` would make the command try to
    // "enable" it forever.
    expect(readAutostartEnabled(() => { throw new Error('must not spawn'); })).toBeNull();
  });
});

describe('enableAutostart', () => {
  const RELOAD = 'systemctl --user daemon-reload';
  const ENABLE = 'systemctl --user enable jarvis.service';

  test.skipIf(process.platform !== 'linux')('reloads and enables, without touching the file', () => {
    expect(enableAutostart(makeSpawn({ [RELOAD]: ok, [ENABLE]: ok }))).toBe(true);
  });

  test.skipIf(process.platform !== 'linux')('a failure at either step is a failure', () => {
    expect(enableAutostart(makeSpawn({ [RELOAD]: fail }))).toBe(false);
    expect(enableAutostart(makeSpawn({ [RELOAD]: ok, [ENABLE]: fail }))).toBe(false);
    expect(enableAutostart(() => { throw new Error('ENOENT'); })).toBe(false);
  });

  test.skipIf(process.platform === 'linux')('off Linux it is a no-op success', () => {
    // There is nothing to enable: the plist being in ~/Library/LaunchAgents IS
    // the registration. Returning false would fail the command for nothing.
    expect(enableAutostart(() => { throw new Error('must not spawn'); })).toBe(true);
  });
});

// ── What "the same definition" means (#548) ──────────────────────────
//
// `jarvis autostart` decides whether to touch the file by comparing these lines,
// so anything they flatten away is something it would call "current".
describe('meaningfulAutostartLines', () => {
  test('systemd: a directive carries its section, and comments are dropped', () => {
    const lines = meaningfulAutostartLines(
      '# note\n[Service]\n  Restart=on-failure\n\n[Install]\nWantedBy=default.target\n',
      'systemd',
    );
    expect(lines).toEqual(['[Service] Restart=on-failure', '[Install] WantedBy=default.target']);
  });

  test('launchd: a plist becomes key/value pairs, nested and indexed', () => {
    const lines = meaningfulAutostartLines(`<plist version="1.0"><dict>
  <key>Label</key><string>x</string>
  <key>ProgramArguments</key><array><string>bun</string><string>start</string></array>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>Jobs</key><array><dict><key>A</key><true/></dict></array>
  <key>Empty</key><dict/>
</dict></plist>`, 'launchd');
    expect(lines).toEqual([
      'Label=x',
      'ProgramArguments[0]=bun',
      'ProgramArguments[1]=start',
      'KeepAlive.SuccessfulExit=<false/>',
      'Jobs[0].A=<true/>',
      'Empty=<dict/>',
    ]);
  });

  // A key whose value was deleted is not a plist launchd would load, and it must
  // not compare equal to a file that never had the key at all.
  test('launchd: a key with no value is named, not dropped', () => {
    expect(meaningfulAutostartLines('<plist><dict><key>A</key><key>B</key><true/></dict></plist>', 'launchd'))
      .toEqual(['A=<missing/>', 'B=<true/>']);
    // ...including as the last entry of a dict, where there is no following key
    // to notice it, and in a dict the text never closes.
    expect(meaningfulAutostartLines('<plist><dict><key>A</key><true/><key>KeepAlive</key></dict></plist>', 'launchd'))
      .toEqual(['A=<true/>', 'KeepAlive=<missing/>']);
    expect(meaningfulAutostartLines('<plist><dict><key>K</key><dict><key>SuccessfulExit</key></dict></dict></plist>', 'launchd'))
      .toEqual(['K.SuccessfulExit=<missing/>']);
    // Which is what keeps a half-deleted entry from comparing equal to a file
    // that never had it.
    expect(meaningfulAutostartLines('<plist><dict><key>A</key><true/></dict></plist>', 'launchd'))
      .not.toEqual(meaningfulAutostartLines('<plist><dict><key>A</key><true/><key>KeepAlive</key></dict></plist>', 'launchd'));
  });

  // Nothing it can parse means nothing it can compare, so it falls back to the
  // raw lines: that can only ever say "differs", which writes nothing.
  test('launchd: text it cannot parse falls back to lines', () => {
    expect(meaningfulAutostartLines('not a plist\n\n  at all\n', 'launchd')).toEqual(['not a plist', 'at all']);
    expect(meaningfulAutostartLines('<plist><dict><key>A</key><string>unclosed', 'launchd'))
      .toEqual(['<plist><dict><key>A</key><string>unclosed']);
  });

  test('launchd: a comment is not a difference', () => {
    const plain = generateLaunchdPlist();
    const noted = plain.replace('<dict>', '<dict>\n  <!-- mine -->');
    expect(meaningfulAutostartLines(noted, 'launchd')).toEqual(meaningfulAutostartLines(plain, 'launchd'));
  });
});

// ── Removing a launch agent (#548/#549) ──────────────────────────────
//
// `jarvis uninstall` unloads the agent BEFORE it stops the daemon, because an
// agent that is still loaded relaunches it. So "already gone" has to count as
// success -- otherwise a clean machine looks like a failure -- while a real
// failure must NOT, or the plist gets deleted with the job still loaded and
// nothing left to retry from.
describe('isLaunchdNotLoaded', () => {
  const err = (text: string): SpawnResultLike => ({ exitCode: 3, stderr: new TextEncoder().encode(text) });

  test('launchctl saying the job was not there is a success for a removal', () => {
    for (const text of [
      'Boot-out failed: 3: No such process',
      'Could not find specified service',
      'launchctl bootout error: Operation not permitted: not loaded',
      '/Users/u/Library/LaunchAgents/ai.jarvis.daemon.plist: No such file or directory',
    ]) {
      expect(isLaunchdNotLoaded(err(text))).toBe(true);
    }
  });

  test('anything else is a real failure', () => {
    for (const text of [
      'Boot-out failed: 36: Operation now in progress',
      'Bootstrap failed: 5: Input/output error',
      '',
    ]) {
      expect(isLaunchdNotLoaded(err(text))).toBe(false);
    }
  });
});
