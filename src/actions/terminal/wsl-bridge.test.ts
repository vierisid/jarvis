/**
 * #519: WSLBridge used to build `$SHELL -c` command lines by interpolation, so
 * `$()` or a backtick in a path ran in the Linux shell, and a `"` in a
 * PowerShell script crossed the Windows command-line layer unprotected.
 *
 * These tests run the real class against fake `wslpath`, `cmd.exe` and
 * `powershell.exe` executables first on PATH, each of which records the argv
 * and environment it actually received. Hostile input must arrive as exactly
 * one argv element, byte for byte, and nothing may be executed along the way:
 * every payload tries to create the same marker file, which must never exist.
 *
 * POSIX-only: the fakes are `#!/bin/sh` scripts and record with GNU `env -0`.
 * isWSL() is stubbed, since this machine is not WSL. The fakes show transport
 * only. When a working `pwsh` is on PATH (GitHub's ubuntu runners have one),
 * the last block also runs runPowerShell's wrapper under real PowerShell, for
 * the round trip and the exit code. Real WSL interop is not exercised.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WSLBridge, buildPowerShellCommand, POWERSHELL_COMMAND_MAX, runArgv } from './wsl-bridge.ts';

const IS_WINDOWS = process.platform === 'win32';

const root = mkdtempSync(join(tmpdir(), 'jarvis-wsl-bridge-'));
const binDir = join(root, 'bin');
const logDir = join(root, 'log');
const PWNED = join(root, 'pwned');

/** Synthetic. Never a real secret. */
const CANARY_NAME = 'JARVIS_WSL_BRIDGE_TEST_API_KEY';
const CANARY_VALUE = 'sentinel-do-not-log';

/**
 * Each fake writes its argv (NUL-separated) and its environment (env -0) to
 * log/<name>.argv and log/<name>.env, found relative to the script itself
 * because the sanitized env would drop any variable naming the log dir.
 */
const RECORD = `#!/bin/sh
log="$(dirname "$0")/../log/$(basename "$0")"
: > "$log.argv"
for a in "$@"; do printf '%s\\0' "$a" >> "$log.argv"; done
env -0 > "$log.env"
`;

const FAKES: Record<string, string> = {
  // Echo the path back, marked, the way wslpath prints one: a single line.
  // A path of exactly "FAIL" exits non-zero with a message on stderr.
  wslpath: `${RECORD}
for last; do :; done
if [ "$last" = "FAIL" ]; then echo "wslpath: FAIL: No such file or directory" >&2; exit 3; fi
printf 'converted:%s\\n' "$last"
`,
  'cmd.exe': `${RECORD}
printf 'C:\\\\Users\\\\tester\\r\\n'
`,
  'powershell.exe': `${RECORD}
printf 'ps-ok\\r\\n'
`,
  // Runs 5s and leaves a grandchild holding stdout as long: the shape a
  // timeout must not wait out. `exec` makes the sleeper the pid runArgv kills;
  // the grandchild's pid is recorded so the test can reap it.
  'hang.exe': `#!/bin/sh
log="$(dirname "$0")/../log"
sleep 5 &
echo $! > "$log/hang.child"
echo $$ > "$log/hang.pid"
exec sleep 5
`,
};

mkdirSync(binDir);
mkdirSync(logDir);
for (const [name, body] of Object.entries(FAKES)) {
  const path = join(binDir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const HOSTILE: string[] = [
  `$(touch ${PWNED})`,
  `\`touch ${PWNED}\``,
  `a; touch ${PWNED}`,
  `a" ; touch ${PWNED} ; echo "`,
  `a' ; touch ${PWNED} ; echo '`,
  `a\ntouch ${PWNED}`,
  `a && touch ${PWNED} || touch ${PWNED} | cat > ${PWNED} < /dev/null`,
  `%PATH% ^& !PATH! %% & | < > ^ ( ) " '`,
  `C:\\Users\\x y\\$HOME\\*\\?\\[a]`,
  '  leading and trailing spaces  ',
  'unicode: äöü ✓ 😀 \u2018quoted\u2019',
];

const INTEROP_ENV: Record<string, string> = {
  WSL_INTEROP: '/run/WSL/42_interop',
  WSL_DISTRO_NAME: 'Test-Distro',
  WSLENV: 'USERPROFILE/p',
};
const saved = new Map<string, string | undefined>();
let isWSLSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  for (const name of ['PATH', CANARY_NAME, ...Object.keys(INTEROP_ENV)]) saved.set(name, process.env[name]);
  process.env.PATH = `${binDir}:${saved.get('PATH') ?? '/usr/bin:/bin'}`;
  Object.assign(process.env, INTEROP_ENV);
  process.env[CANARY_NAME] = CANARY_VALUE;
  rmSync(PWNED, { force: true });
  rmSync(join(logDir, 'hang.pid'), { force: true });
  rmSync(join(logDir, 'hang.child'), { force: true });
  for (const name of Object.keys(FAKES)) {
    rmSync(join(logDir, `${name}.argv`), { force: true });
    rmSync(join(logDir, `${name}.env`), { force: true });
  }
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  isWSLSpy?.mockRestore();
  isWSLSpy = undefined;
});

function stubWSL(value: boolean): void {
  isWSLSpy = spyOn(WSLBridge, 'isWSL').mockReturnValue(value);
}

/** argv[1..] as the fake received them, or null if it never ran. */
function recordedArgv(name: string): string[] | null {
  const path = join(logDir, `${name}.argv`);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  return raw === '' ? [] : raw.slice(0, -1).split('\0');
}

function recordedEnv(name: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of readFileSync(join(logDir, `${name}.env`), 'utf-8').split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/** A bridge with no startup detection, so only the call under test spawns. */
function bridgeWithoutDetection(): WSLBridge {
  stubWSL(false);
  const bridge = new WSLBridge();
  isWSLSpy!.mockReturnValue(true);
  return bridge;
}

describe.skipIf(IS_WINDOWS)('WSLBridge path conversion', () => {
  for (const [method, flag] of [['convertToWindowsPath', '-w'], ['convertToWSLPath', '-u']] as const) {
    test(`${method} hands wslpath each hostile path as one intact argv element`, async () => {
      const bridge = bridgeWithoutDetection();

      for (const input of HOSTILE) {
        const out = await bridge[method](input);
        expect(recordedArgv('wslpath')).toEqual([flag, input]);
        // Only wslpath's own line terminator is removed.
        expect(out).toBe(`converted:${input}`);
      }

      expect(existsSync(PWNED)).toBe(false);
    });
  }

  test('refuses a path wslpath would read as an option, without spawning', async () => {
    const bridge = bridgeWithoutDetection();

    await expect(bridge.convertToWindowsPath('-u')).rejects.toThrow(/starts with "-"/);
    await expect(bridge.convertToWSLPath('-a')).rejects.toThrow(/starts with "-"/);
    expect(recordedArgv('wslpath')).toBeNull();
  });

  test('a failing wslpath throws with its stderr instead of returning an empty path', async () => {
    const bridge = bridgeWithoutDetection();

    await expect(bridge.convertToWindowsPath('FAIL')).rejects.toThrow(/exited with code 3: wslpath: FAIL: No such file/);
  });

  test('wslpath gets the sanitized env plus the WSL interop variables', async () => {
    const bridge = bridgeWithoutDetection();

    await bridge.convertToWindowsPath('/home/user');
    const env = recordedEnv('wslpath');
    expect(env[CANARY_NAME]).toBeUndefined();
    expect(Object.values(env)).not.toContain(CANARY_VALUE);
    for (const [name, value] of Object.entries(INTEROP_ENV)) expect(env[name]).toBe(value);
  });
});

describe.skipIf(IS_WINDOWS)('WSLBridge.runPowerShell', () => {
  const WRAPPER = /^\. \(\[ScriptBlock\]::Create\(\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('([A-Za-z0-9+/=]*)'\)\)\)\)$/;

  test('the script reaches powershell.exe only as base64 inside the fixed wrapper', async () => {
    const bridge = bridgeWithoutDetection();
    const scripts = [
      ...HOSTILE,
      `Write-Output "$env:USERPROFILE"; Copy-Item "a b" 'c''d'`,
      'multi\r\nline\n`$(backtick)`\t$x = @"\nhere\n"@',
    ];

    for (const script of scripts) {
      const result = await bridge.runPowerShell(script);
      expect(result.stdout).toBe('ps-ok\r\n');
      expect(result.exitCode).toBe(0);

      const argv = recordedArgv('powershell.exe')!;
      expect(argv.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
      expect(argv).toHaveLength(4);
      const match = WRAPPER.exec(argv[3]!);
      expect(match).not.toBeNull();
      // The script, then the exit-code line on its own line (pinned exactly).
      expect(Buffer.from(match![1]!, 'base64').toString('utf8')).toBe(`${script}\n;if (-not $?) { exit 1 }`);
      expect(argv[3]).not.toContain('"');
    }

    expect(existsSync(PWNED)).toBe(false);
  });

  test('powershell.exe gets the sanitized env plus the WSL interop variables', async () => {
    const bridge = bridgeWithoutDetection();

    await bridge.runPowerShell('Get-Date');
    const env = recordedEnv('powershell.exe');
    expect(env[CANARY_NAME]).toBeUndefined();
    for (const [name, value] of Object.entries(INTEROP_ENV)) expect(env[name]).toBe(value);
  });

  test('a script too long for a Windows command line fails before spawning', async () => {
    const bridge = bridgeWithoutDetection();

    await expect(bridge.runPowerShell('x'.repeat(POWERSHELL_COMMAND_MAX))).rejects.toThrow(/too long/);
    expect(recordedArgv('powershell.exe')).toBeNull();
    expect(buildPowerShellCommand('x'.repeat(20_000)).length).toBeLessThanOrEqual(POWERSHELL_COMMAND_MAX);
  });
});

describe.skipIf(IS_WINDOWS)('WSLBridge Windows home detection', () => {
  test('asks cmd.exe for %USERPROFILE% with fixed argv and no shell', async () => {
    stubWSL(true);
    const bridge = new WSLBridge();

    const deadline = Date.now() + 4000;
    while (bridge.getWindowsHome() === null && Date.now() < deadline) {
      await Bun.sleep(10);
    }

    expect(bridge.getWindowsHome()).toBe('/mnt/c/Users/tester');
    expect(recordedArgv('cmd.exe')).toEqual(['/d', '/c', 'echo', '%USERPROFILE%']);
    expect(recordedEnv('cmd.exe')[CANARY_NAME]).toBeUndefined();
  });
});

describe.skipIf(IS_WINDOWS)('WSLBridge outside WSL', () => {
  test('every spawning method refuses without running anything', async () => {
    stubWSL(false);
    const bridge = new WSLBridge();

    await expect(bridge.convertToWindowsPath('/tmp')).rejects.toThrow('Not running in WSL environment');
    await expect(bridge.convertToWSLPath('C:\\')).rejects.toThrow('Not running in WSL environment');
    await expect(bridge.runPowerShell('Get-Date')).rejects.toThrow('Not running in WSL environment');
    expect(bridge.getWindowsHome()).toBeNull();
    for (const name of Object.keys(FAKES)) expect(recordedArgv(name)).toBeNull();
  });
});

describe.skipIf(IS_WINDOWS)('runArgv', () => {
  test('the timeout is a hard deadline, not a wait for the child or its pipes', async () => {
    const started = Date.now();
    const run = runArgv(['hang.exe'], 2000);
    const rejected = expect(run).rejects.toThrow('hang.exe timed out after 2000ms');

    // The child is up before the deadline, so what follows is a timeout of a
    // running child rather than of one that never started.
    const pidFile = join(logDir, 'hang.pid');
    while (!existsSync(pidFile) && Date.now() - started < 1900) await Bun.sleep(5);
    expect(existsSync(pidFile)).toBe(true);

    try {
      await rejected;
      // Waiting for the child or its pipes would take the full 5s.
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      // runArgv leaves grandchildren alone; this test's own must not outlive it.
      try { process.kill(Number(readFileSync(join(logDir, 'hang.child'), 'utf-8').trim()), 'SIGKILL'); } catch { /* gone */ }
    }

    // And the child itself was killed, not just abandoned.
    const pid = Number(readFileSync(join(logDir, 'hang.pid'), 'utf-8').trim());
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const until = Date.now() + 1000;
    while (alive() && Date.now() < until) await Bun.sleep(10);
    expect(alive()).toBe(false);
  }, 10_000);

  test('a missing executable rejects instead of resolving', async () => {
    const error = await runArgv(['jarvis-no-such-program-519']).then(() => null, (e: unknown) => e);
    // Bun reports ENOENT as `code`; its message wording is not relied on.
    expect((error as { code?: string } | null)?.code).toBe('ENOENT');
  });
});

// ── The wrapper under a real PowerShell, when one is installed ──
//
// pwsh 7, not the Windows PowerShell 5.1 the daemon runs on WSL: the wrapper
// uses nothing believed to differ between them, but the exit codes here are
// pwsh's. A second `powershell.exe` fake execs pwsh with the argv
// runPowerShell built, so this is the real method end to end, minus WSL
// interop.

/** Probed by running it, as desktop-notify.test.ts does: a broken install skips rather than fails. */
const PWSH = (() => {
  if (IS_WINDOWS) return null;
  const path = Bun.which('pwsh');
  if (!path) return null;
  const r = Bun.spawnSync([path, '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', timeout: 20_000,
  });
  return r.exitCode === 0 ? path : null;
})();

/** A PowerShell single-quoted literal: `'` and U+2018..U+201B all close one, so all are doubled. */
function psLiteral(text: string): string {
  return `'${text.replace(/['‘-‛]/g, q => q + q)}'`;
}

describe.skipIf(!PWSH)('WSLBridge.runPowerShell under a real PowerShell', () => {
  const pwshBin = join(root, 'pwsh-bin');

  beforeAll(() => {
    mkdirSync(pwshBin);
    const quoted = `'${PWSH!.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(pwshBin, 'powershell.exe'), `#!/bin/sh\nexec ${quoted} "$@"\n`);
    chmodSync(join(pwshBin, 'powershell.exe'), 0o755);
  });

  beforeEach(() => {
    process.env.PATH = `${pwshBin}:${process.env.PATH}`;
  });

  const ROUND_TRIP = [...HOSTILE, 'ünïcödé ✓ 😀 ‚high‛', "it's ‘both’"];
  // One script: every text as a literal, echoed back as base64 of its UTF-8.
  // Unicode sits in the script text itself, outside any literal, too.
  const ROUND_TRIP_SCRIPT = [
    '# ünïcödé ✓ 😀 in a comment',
    '$items = @(',
    ROUND_TRIP.map(psLiteral).join(',\n'),
    ')',
    '$items | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_)) }',
  ].join('\n');

  const EXIT_CASES: Array<[string, number]> = [
    ['Write-Output a; exit 7', 7],
    ['Write-Output a; Write-Error "bad"', 1],
    ["Write-Output a; & '/bin/sh' -c 'exit 7'", 1],
    ['throw "boom"', 1],
    ['Write-Error early; Write-Output ok', 0],
    ['Write-Error bad # a trailing comment must not swallow the exit line', 1],
    ['Write-Output a |', 1],
  ];

  // Every pwsh start costs hundreds of ms: all the runs go concurrently, once.
  let results: Promise<Array<{ stdout: string; exitCode: number }>> | undefined;
  const runAll = () => (results ??= (async () => {
    const bridge = bridgeWithoutDetection();
    return Promise.all([ROUND_TRIP_SCRIPT, ...EXIT_CASES.map(([s]) => s)].map(s => bridge.runPowerShell(s)));
  })());

  test('every text reaches PowerShell intact', async () => {
    const [roundTrip] = await runAll();
    expect(roundTrip!.exitCode).toBe(0);
    const decoded = roundTrip!.stdout.trim().split(/\r?\n/).map(line => Buffer.from(line, 'base64').toString('utf8'));
    expect(decoded).toEqual(ROUND_TRIP);
    expect(existsSync(PWNED)).toBe(false);
  }, 40_000);

  test.each(EXIT_CASES.map(([script, code], i) => [script, code, i + 1] as const))(
    'exits as a bare -Command would: %p -> %p',
    async (_script, code, i) => {
      expect((await runAll())[i]!.exitCode).toBe(code);
    },
    40_000,
  );
});
