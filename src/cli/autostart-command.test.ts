/**
 * `jarvis autostart` (#548): the command that finally installs the definition
 * the generators have always produced.
 *
 * Every dependency that touches the machine is injected, so nothing here writes
 * a unit, enables one, or talks to systemd/launchd. What is asserted is the
 * BRANCHING -- above all the things that would make the command dangerous or
 * dishonest: a rewrite that silently discards an edit, a success report for a
 * run that changed nothing, and advice that would break a running daemon.
 */
import { describe, expect, test } from 'bun:test';
import {
  AUTOSTART_HELP,
  compareAutostart,
  defaultAutostartDeps,
  parseAutostartArgs,
  runAutostartCommand,
  type AutostartCommandDeps,
} from './autostart-command.ts';
import { generateLaunchdPlist, generateSystemdUnit, meaningfulAutostartLines } from './autostart.ts';

const UNIT_A = `[Unit]
Description=J.A.R.V.I.S. Daemon
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
ExecStart=/home/u/.bun/bin/bun /opt/jarvis/bin/jarvis.ts start --foreground --no-open
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;

/** The same unit as an older JARVIS would have written it: 2 out, 4 in. */
const UNIT_OLD = `[Unit]
Description=J.A.R.V.I.S. Daemon

[Service]
ExecStart=/home/u/.bun/bin/bun /opt/jarvis/bin/jarvis.ts start --foreground
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;

const PLIST_PATH = '/Users/u/Library/LaunchAgents/ai.jarvis.daemon.plist';

interface Recorder {
  deps: Partial<AutostartCommandDeps>;
  out(): string;
  calls: string[];
  startedWith: { replaceLoaded: boolean }[];
}

function recorder(
  over: Partial<AutostartCommandDeps> = {},
  opts: { installOk?: boolean; startOk?: boolean; uninstallOk?: boolean; enableOk?: boolean } = {},
): Recorder {
  const lines: string[] = [];
  const calls: string[] = [];
  const startedWith: { replaceLoaded: boolean }[] = [];
  const deps: Partial<AutostartCommandDeps> = {
    platform: 'linux',
    support: () => ({ supported: true }),
    path: () => '/home/u/.config/systemd/user/jarvis.service',
    manager: () => 'systemd (User Service)',
    unitName: () => 'jarvis.service',
    generate: () => UNIT_A,
    readInstalled: () => null,
    install: async () => { calls.push('install'); return opts.installOk ?? true; },
    enable: () => { calls.push('enable'); return opts.enableOk ?? true; },
    start: async (o) => { calls.push('start'); startedWith.push(o); return opts.startOk ?? true; },
    uninstall: async () => { calls.push('uninstall'); return opts.uninstallOk ?? true; },
    enabled: () => true,
    dropIns: () => [],
    runningPid: () => null,
    drift: () => null,
    log: (line) => { lines.push(line); },
    ...over,
  };
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  return { deps, calls, startedWith, out: () => strip(lines.join('\n')) };
}

/** A recorder wired for macOS. */
function darwinRecorder(
  over: Partial<AutostartCommandDeps> = {},
  opts: Parameters<typeof recorder>[1] = {},
): Recorder {
  return recorder({
    platform: 'darwin',
    manager: () => 'launchd (User Agent)',
    unitName: () => 'ai.jarvis.daemon',
    path: () => PLIST_PATH,
    generate: () => generateLaunchdPlist(),
    // launchd has no is-enabled equivalent.
    enabled: () => null,
    ...over,
  }, opts);
}

describe('parseAutostartArgs', () => {
  test('no arguments installs, starting the service', () => {
    expect(parseAutostartArgs([])).toEqual({ options: { mode: 'install', force: false, start: true } });
  });

  test('each mode and modifier is recognised', () => {
    expect(parseAutostartArgs(['--status'])).toEqual({ options: { mode: 'status', force: false, start: true } });
    expect(parseAutostartArgs(['--uninstall'])).toEqual({ options: { mode: 'uninstall', force: false, start: true } });
    expect(parseAutostartArgs(['--force'])).toEqual({ options: { mode: 'install', force: true, start: true } });
    expect(parseAutostartArgs(['--no-start'])).toEqual({ options: { mode: 'install', force: false, start: false } });
    expect(parseAutostartArgs(['--force', '--no-start'])).toEqual({ options: { mode: 'install', force: true, start: false } });
    expect(parseAutostartArgs(['--help'])).toEqual({ options: { mode: 'help', force: false, start: true } });
  });

  // A typo must not install. This is the one place where being lenient would
  // write a file the user did not ask for.
  test('an unknown option is an error, not an install', () => {
    expect(parseAutostartArgs(['--uninstal'])).toEqual({ error: 'unknown option: --uninstal' });
    expect(parseAutostartArgs(['status'])).toEqual({ error: 'unknown option: status' });
    // No -f: `jarvis logs -f` means --follow, and one letter meaning two things
    // across one CLI is worth less than it costs.
    expect(parseAutostartArgs(['-f'])).toEqual({ error: 'unknown option: -f' });
    expect(parseAutostartArgs(['--status', '--uninstall'])).toEqual({ error: '--uninstall cannot be combined with --status' });
    expect(parseAutostartArgs(['--uninstall', '--force'])).toEqual({ error: '--force only applies to installing; drop it from --uninstall' });
    expect(parseAutostartArgs(['--status', '--no-start'])).toEqual({ error: '--no-start only applies to installing; drop it from --status' });
  });

  // Asking how the command works must never be answered with a usage error,
  // whatever else is on the line and in whatever order.
  test('--help wins over every other flag, in any position', () => {
    for (const args of [['--help', '--force'], ['--uninstall', '--help'], ['-h', '--status', '--no-start']]) {
      expect(parseAutostartArgs(args)).toEqual({ options: { mode: 'help', force: false, start: true } });
    }
  });

  test('the help text is plain ASCII and names every option', () => {
    const plain = AUTOSTART_HELP.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toMatch(/^[\x20-\x7e\n]+$/);
    for (const flag of ['--force', '--no-start', '--status', '--uninstall']) {
      expect(plain).toContain(flag);
    }
    // Reboot survival is a linger thing on Linux and not a thing at all on
    // macOS, so the headline promise is logins.
    expect(plain).toContain('across logins');
    expect(plain).toContain('enable-linger');
  });
});

describe('compareAutostart', () => {
  test('absent when nothing is installed', () => {
    expect(compareAutostart(null, UNIT_A, 'systemd').state).toBe('absent');
  });

  test('the definition we would write is current', () => {
    expect(compareAutostart(UNIT_A, UNIT_A, 'systemd').state).toBe('current');
    const plist = generateLaunchdPlist();
    expect(compareAutostart(plist, plist, 'launchd').state).toBe('current');
  });

  // The user's own comment, and this version's reworded rationale, are not
  // differences: demanding --force for them would train people to pass it.
  test('comments, blank lines and indentation are not differences', () => {
    const edited = `# my note, do not remove\n${UNIT_A.replace('[Service]\n', '[Service]\n  # why\n')}`;
    const cmp = compareAutostart(edited, UNIT_A, 'systemd');
    expect(cmp.state).toBe('current');
    // ...but a rewrite would still lose them, and only this knows how many.
    expect(cmp.commentsOnlyOnDisk).toBe(2);
    expect(compareAutostart(generateSystemdUnit(), generateSystemdUnit(), 'systemd').commentsOnlyOnDisk).toBe(0);
  });

  test('a changed directive is named on both sides', () => {
    const cmp = compareAutostart(UNIT_OLD, UNIT_A, 'systemd');
    expect(cmp.state).toBe('differs');
    expect(cmp.onlyOnDisk).toContain('[Service] Restart=always');
    expect(cmp.onlyInNew).toContain('[Service] Restart=on-failure');
    expect(cmp.onlyInNew).toContain('[Unit] StartLimitBurst=5');
    // The ExecStart difference is the --no-open of #544.
    expect(cmp.onlyOnDisk.some((l) => l.includes('ExecStart') && !l.includes('--no-open'))).toBe(true);
  });

  // A plist's keys and values are separate nodes, so a bag of LINES read an agent
  // that never starts at login and relaunches only after a CLEAN exit -- #549
  // inverted -- as identical to the correct one: both hold exactly one <true/>
  // and one <false/>. The comparison is over key/value pairs.
  test('a plist with two values swapped is not "current"', () => {
    const good = generateLaunchdPlist();
    const inverted = good
      .replace('<key>RunAtLoad</key>\n  <true/>', '<key>RunAtLoad</key>\n  <false/>')
      .replace('<key>SuccessfulExit</key>\n    <false/>', '<key>SuccessfulExit</key>\n    <true/>');
    expect(inverted).not.toBe(good);
    const cmp = compareAutostart(inverted, good, 'launchd');
    expect(cmp.state).toBe('differs');
    expect(cmp.onlyOnDisk).toEqual(['RunAtLoad=<false/>', 'KeepAlive.SuccessfulExit=<true/>']);
    expect(cmp.onlyInNew).toEqual(['RunAtLoad=<true/>', 'KeepAlive.SuccessfulExit=<false/>']);
  });

  test('each plist difference is named by its key, not by a bare value', () => {
    const old = generateLaunchdPlist().replace(
      /<key>KeepAlive<\/key>\s*<dict>[\s\S]*?<\/dict>/,
      '<key>KeepAlive</key>\n  <true/>',
    );
    const cmp = compareAutostart(old, generateLaunchdPlist(), 'launchd');
    expect(cmp.state).toBe('differs');
    expect(cmp.onlyOnDisk).toEqual(['KeepAlive=<true/>']);
    expect(cmp.onlyInNew).toEqual(['KeepAlive.SuccessfulExit=<false/>']);
  });

  test('plist arguments carry their position, so a reordering is a difference', () => {
    const lines = meaningfulAutostartLines(generateLaunchdPlist(), 'launchd');
    expect(lines).toContain('ProgramArguments[2]=start');
    expect(lines).toContain('ProgramArguments[4]=--no-open');
    const swapped = generateLaunchdPlist().replace(
      '<string>start</string>\n    <string>--foreground</string>',
      '<string>--foreground</string>\n    <string>start</string>',
    );
    expect(compareAutostart(swapped, generateLaunchdPlist(), 'launchd').state).toBe('differs');
  });

  test('the same directive twice is not the same as once', () => {
    const twice = UNIT_A.replace('Restart=on-failure\n', 'Restart=on-failure\nRestart=on-failure\n');
    expect(compareAutostart(twice, UNIT_A, 'systemd').state).toBe('differs');
    expect(compareAutostart(twice, UNIT_A, 'systemd').onlyOnDisk).toEqual(['[Service] Restart=on-failure']);
  });
});

describe('runAutostartCommand: installing', () => {
  test('a fresh install writes and starts', async () => {
    const r = recorder();
    expect(await runAutostartCommand([], r.deps)).toBe(0);
    expect(r.calls).toEqual(['install', 'start']);
    expect(r.out()).toContain('Installing systemd (User Service)');
  });

  test('--no-start writes and states the boot-time expectation', async () => {
    const r = recorder();
    expect(await runAutostartCommand(['--no-start'], r.deps)).toBe(0);
    expect(r.calls).toEqual(['install']);
    expect(r.out()).toContain('Nothing was started');
    expect(r.out()).toContain('systemctl --user start jarvis.service');
  });

  // The unit's ExecStart is `jarvis start --foreground`, which exits 1 against a
  // live lock. Starting it here would be five failed starts and a FAILED unit,
  // i.e. installing autostart would break a daemon that was running fine.
  test('a daemon that is already running is not started a second time', async () => {
    const r = recorder({ runningPid: () => 4242 });
    expect(await runAutostartCommand([], r.deps)).toBe(0);
    expect(r.calls).toEqual(['install']);
    expect(r.out()).toContain('already running (PID 4242)');
    expect(r.out()).toContain('systemctl --user restart jarvis.service');
  });

  // ...and for the same reason, --no-start must not hand the user the command
  // that would do exactly that.
  test('--no-start does not offer `systemctl start` while a daemon is running', async () => {
    const r = recorder({ runningPid: () => 4242 });
    expect(await runAutostartCommand(['--no-start'], r.deps)).toBe(0);
    expect(r.calls).toEqual(['install']);
    expect(r.out()).toContain('already running (PID 4242)');
    expect(r.out()).toContain('takes over at your next login');
    expect(r.out()).not.toContain('systemctl --user start');
  });

  test('a failed write reports failure and never starts', async () => {
    const r = recorder({}, { installOk: false });
    expect(await runAutostartCommand([], r.deps)).toBe(1);
    expect(r.calls).toEqual(['install']);
  });

  test('a failed start is an error, with the manual command', async () => {
    const r = recorder({}, { startOk: false });
    expect(await runAutostartCommand([], r.deps)).toBe(1);
    expect(r.calls).toEqual(['install', 'start']);
    expect(r.out()).toContain('systemctl --user start jarvis.service');
  });

  test('an already-current definition is left untouched', async () => {
    const r = recorder({ readInstalled: () => UNIT_A });
    expect(await runAutostartCommand([], r.deps)).toBe(0);
    expect(r.calls).toEqual(['start']);
    expect(r.out()).toContain('already what this version installs');
    expect(r.out()).toContain('left untouched');
  });

  // Nothing was written, so there is no new definition to apply: telling the
  // user to restart their daemon here would churn it for nothing.
  test('a current definition and a running daemon asks for no restart', async () => {
    const r = recorder({ readInstalled: () => UNIT_A, runningPid: () => 77 });
    expect(await runAutostartCommand([], r.deps)).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out()).toContain('already running (PID 77)');
    expect(r.out()).not.toContain('apply the new one');
  });

  // installSystemd writes the file BEFORE daemon-reload and enable, so a failure
  // at either leaves a byte-current unit systemd will never start. Re-running the
  // command has to repair that, and without rewriting the file.
  test('a current definition that is not enabled is enabled, not rewritten', async () => {
    const r = recorder({ readInstalled: () => UNIT_A, enabled: () => false });
    expect(await runAutostartCommand([], r.deps)).toBe(0);
    expect(r.calls).toEqual(['enable', 'start']);
    expect(r.out()).toContain('will not start it by itself');
  });

  test('a failed enable is an error', async () => {
    const r = recorder({ readInstalled: () => UNIT_A, enabled: () => false }, { enableOk: false });
    expect(await runAutostartCommand([], r.deps)).toBe(1);
    expect(r.calls).toEqual(['enable']);
  });

  test('an unknown enablement is not treated as a no', async () => {
    const r = recorder({ readInstalled: () => UNIT_A, enabled: () => null });
    expect(await runAutostartCommand([], r.deps)).toBe(0);
    expect(r.calls).toEqual(['start']);
  });

  // --force is an explicit request: it re-runs the write, and with it the reload
  // and enable steps, even when the content already matches.
  test('--force rewrites a definition that is already current', async () => {
    const r = recorder({ readInstalled: () => UNIT_A });
    expect(await runAutostartCommand(['--force'], r.deps)).toBe(0);
    expect(r.calls).toEqual(['install', 'start']);
    expect(r.out()).toContain('Refreshing');
  });

  test('--force on a fresh install is still an install', async () => {
    const r = recorder();
    expect(await runAutostartCommand(['--force'], r.deps)).toBe(0);
    expect(r.calls).toEqual(['install', 'start']);
    expect(r.out()).toContain('Installing');
  });
});

describe('runAutostartCommand: a definition that differs', () => {
  // The heart of #548's judgement call. An older install and a hand edit are
  // indistinguishable from here, so the difference is printed and NOTHING is
  // written -- and the exit code says the install did not happen.
  test('without --force it writes nothing, names the file, and exits non-zero', async () => {
    const r = recorder({ readInstalled: () => UNIT_OLD });
    expect(await runAutostartCommand([], r.deps)).toBe(1);
    expect(r.calls).toEqual([]);
    const out = r.out();
    expect(out).toContain('/home/u/.config/systemd/user/jarvis.service differs');
    expect(out).toContain('Nothing was written');
    expect(out).toContain('- [Service] Restart=always');
    expect(out).toContain('+ [Service] Restart=on-failure');
    expect(out).toContain('jarvis autostart --force');
    expect(out).toContain('systemctl --user edit jarvis.service');
  });

  // Comments are deliberately not compared, so they never appear in the diff --
  // but --force replaces the whole file, so their loss has to be said out loud.
  test('the comment lines --force would destroy are counted', async () => {
    const mine = `# ticket 123: do not touch\n# reviewed by me\n${UNIT_OLD}`;
    const r = recorder({ readInstalled: () => mine });
    expect(await runAutostartCommand([], r.deps)).toBe(1);
    expect(r.out()).toContain('2 comment line(s)');
    expect(r.out()).toContain('on disk are not in the new definition and would be lost');
  });

  test("no comment warning when there are none of the user's own", async () => {
    const r = recorder({ readInstalled: () => UNIT_OLD });
    expect(await runAutostartCommand([], r.deps)).toBe(1);
    expect(r.out()).not.toContain('comment line(s)');
  });

  test('--force writes it, and says the running daemon keeps the old one', async () => {
    const r = recorder({ readInstalled: () => UNIT_OLD, runningPid: () => 99 });
    expect(await runAutostartCommand(['--force'], r.deps)).toBe(0);
    expect(r.calls).toEqual(['install']);
    const out = r.out();
    expect(out).toContain('Refreshing');
    expect(out).toContain('running with the definition it was started with');
    expect(out).toContain('systemctl --user restart jarvis.service');
  });

  test('--force with nothing running writes and starts', async () => {
    const r = recorder({ readInstalled: () => UNIT_OLD });
    expect(await runAutostartCommand(['--force'], r.deps)).toBe(0);
    expect(r.calls).toEqual(['install', 'start']);
    expect(r.out()).toContain('Starting the service with the new definition');
  });

  // Truncation hides exactly the lines --force deletes, so it has to say so.
  test('a long diff is capped, and the cap says what --force does to the rest', async () => {
    const noisy = `[Service]\n${Array.from({ length: 30 }, (_, i) => `Environment=X${i}=1`).join('\n')}\n`;
    const r = recorder({ readInstalled: () => noisy });
    expect(await runAutostartCommand([], r.deps)).toBe(1);
    expect(r.out()).toContain('... and 20 more, which --force also removes');
  });

  test('on macOS the keep-your-edit advice is the plist one', async () => {
    const r = darwinRecorder({ readInstalled: () => '<plist><dict><key>Label</key><string>x</string></dict></plist>' });
    expect(await runAutostartCommand([], r.deps)).toBe(1);
    expect(r.out()).toContain('copy your changes back into the plist after --force');
    expect(r.out()).not.toContain('systemctl');
  });

  test('on macOS --force names bootout/bootstrap, not systemctl', async () => {
    const r = darwinRecorder({
      readInstalled: () => '<plist><dict><key>Label</key><string>x</string></dict></plist>',
      runningPid: () => 7,
    });
    expect(await runAutostartCommand(['--force'], r.deps)).toBe(0);
    expect(r.out()).toContain('launchctl bootout gui/$(id -u)/ai.jarvis.daemon');
    expect(r.out()).toContain(`launchctl bootstrap gui/$(id -u) ${PLIST_PATH}`);
  });

  // `launchctl bootstrap` on an already-loaded agent keeps the plist launchd read
  // last, so a refresh has to tell the start step to boot the agent out first.
  test('a write asks the start step to replace an already-loaded agent', async () => {
    const r = darwinRecorder({ readInstalled: () => '<plist><dict/></plist>' });
    expect(await runAutostartCommand(['--force'], r.deps)).toBe(0);
    expect(r.startedWith).toEqual([{ replaceLoaded: true }]);
  });

  test('a run that wrote nothing does not boot the agent out', async () => {
    const plist = generateLaunchdPlist();
    const r = darwinRecorder({ readInstalled: () => plist });
    expect(await runAutostartCommand([], r.deps)).toBe(0);
    expect(r.startedWith).toEqual([{ replaceLoaded: false }]);
  });

  test('on macOS a failed load is an error, with the launchctl command', async () => {
    const r = darwinRecorder({}, { startOk: false });
    expect(await runAutostartCommand([], r.deps)).toBe(1);
    expect(r.out()).toContain('Nothing was loaded');
    expect(r.out()).toContain(`launchctl bootstrap gui/$(id -u) ${PLIST_PATH}`);
  });

  test('on macOS --no-start says the agent takes over at login', async () => {
    const r = darwinRecorder();
    expect(await runAutostartCommand(['--no-start'], r.deps)).toBe(0);
    expect(r.calls).toEqual(['install']);
    expect(r.out()).toContain('Nothing was loaded. The agent starts JARVIS at your next login.');
  });
});

describe('runAutostartCommand: --status', () => {
  test('reports absent, and how to install', async () => {
    const r = recorder();
    expect(await runAutostartCommand(['--status'], r.deps)).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out()).toContain('State:      not installed');
    expect(r.out()).toContain('Install it: jarvis autostart');
  });

  test('reports a current definition, enablement and the daemon', async () => {
    const r = recorder({ readInstalled: () => UNIT_A, runningPid: () => 321 });
    expect(await runAutostartCommand(['--status'], r.deps)).toBe(0);
    expect(r.out()).toContain('the same as this version installs');
    expect(r.out()).toContain('Enabled:    yes');
    expect(r.out()).toContain('running (PID 321)');
  });

  test('a present but not enabled unit is called out, with the remedy', async () => {
    const r = recorder({ readInstalled: () => UNIT_A, enabled: () => false });
    expect(await runAutostartCommand(['--status'], r.deps)).toBe(0);
    expect(r.out()).toContain('will not start it');
    expect(r.out()).toContain('Enable it:  jarvis autostart');
  });

  test('an unknown enablement is omitted rather than guessed', async () => {
    const r = recorder({ readInstalled: () => UNIT_A, enabled: () => null });
    expect(await runAutostartCommand(['--status'], r.deps)).toBe(0);
    expect(r.out()).not.toContain('Enabled:');
  });

  // A drop-in changes the effective unit, and #547's drift detector goes silent
  // once one exists. Status must not report "current" as if that were the whole
  // story.
  test('drop-in overrides are listed, with the command that shows the merge', async () => {
    const r = recorder({
      readInstalled: () => UNIT_A,
      dropIns: () => ['/home/u/.config/systemd/user/jarvis.service.d/override.conf'],
    });
    expect(await runAutostartCommand(['--status'], r.deps)).toBe(0);
    expect(r.out()).toContain('Overrides:  /home/u/.config/systemd/user/jarvis.service.d/override.conf');
    expect(r.out()).toContain('systemctl --user cat jarvis.service');
  });

  test('a drifted definition is counted exactly, and its problems named', async () => {
    const r = recorder({
      readInstalled: () => UNIT_OLD,
      drift: () => ({ path: '/x/jarvis.service', problems: ['opens-a-browser', 'unbounded-restarts'] }),
    });
    expect(await runAutostartCommand(['--status'], r.deps)).toBe(0);
    const out = r.out();
    // 2 directives only on disk, 4 only in the new one.
    expect(out).toContain('different from this version in 6 line(s)');
    expect(out).toContain('opens a browser');
    expect(out).toContain('Refresh it: jarvis autostart');
  });

  test('an unreachable manager is reported without failing the command', async () => {
    const r = recorder({
      readInstalled: () => UNIT_A,
      support: () => ({ supported: false, reason: 'Failed to connect to bus' }),
    });
    expect(await runAutostartCommand(['--status'], r.deps)).toBe(0);
    expect(r.out()).toContain('Failed to connect to bus');
  });
});

describe('runAutostartCommand: --uninstall', () => {
  // The file can be gone while the unit is still enabled and running, so the
  // removal runs either way; both platforms' removers are idempotent.
  test('a missing definition still clears any registration', async () => {
    const r = recorder();
    expect(await runAutostartCommand(['--uninstall'], r.deps)).toBe(0);
    expect(r.calls).toEqual(['uninstall']);
    expect(r.out()).toContain('No systemd (User Service) definition is installed');
    expect(r.out()).toContain('Clearing any registration left behind');
  });

  test('an installed definition is removed, and the stop is announced', async () => {
    const r = recorder({ readInstalled: () => UNIT_A });
    expect(await runAutostartCommand(['--uninstall'], r.deps)).toBe(0);
    expect(r.calls).toEqual(['uninstall']);
    expect(r.out()).toContain('This stops the service');
  });

  test('a removal that fails exits non-zero', async () => {
    const r = recorder({ readInstalled: () => UNIT_A }, { uninstallOk: false });
    expect(await runAutostartCommand(['--uninstall'], r.deps)).toBe(1);
  });

  // The definition is removed even when we would refuse to overwrite it: a hand
  // edit is a reason not to rewrite, not a reason to keep it forever.
  test('a hand-edited definition is still removed', async () => {
    const r = recorder({ readInstalled: () => `${UNIT_OLD}\n# mine\nNice=5\n` });
    expect(await runAutostartCommand(['--uninstall'], r.deps)).toBe(0);
    expect(r.calls).toEqual(['uninstall']);
  });
});

describe('runAutostartCommand: platforms and preconditions', () => {
  test('an unsupported platform refuses to install and exits non-zero', async () => {
    const r = recorder({ platform: 'freebsd', path: () => null });
    expect(await runAutostartCommand([], r.deps)).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.out()).toContain('not available on freebsd');
  });

  test('--status and --uninstall on an unsupported platform are answers, not errors', async () => {
    for (const mode of ['--status', '--uninstall']) {
      const r = recorder({ platform: 'freebsd', path: () => null });
      expect(await runAutostartCommand([mode], r.deps)).toBe(0);
      expect(r.calls).toEqual([]);
    }
  });

  // An install that cannot work must not write a unit nothing will ever read.
  test('an unreachable systemd user manager blocks the install', async () => {
    const r = recorder({ support: () => ({ supported: false, reason: 'Failed to connect to bus' }) });
    expect(await runAutostartCommand([], r.deps)).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.out()).toContain('Cannot install autostart: Failed to connect to bus');
    expect(r.out()).toContain('systemd=true');
  });

  test('on macOS the WSL advice is not printed', async () => {
    const r = darwinRecorder({ support: () => ({ supported: false, reason: 'launchctl missing' }) });
    expect(await runAutostartCommand([], r.deps)).toBe(1);
    expect(r.out()).toContain('launchctl missing');
    expect(r.out()).not.toContain('systemd=true');
  });

  // Removing what is there must not depend on the manager being reachable.
  test('--uninstall still works when the manager is unreachable', async () => {
    const r = recorder({
      readInstalled: () => UNIT_A,
      support: () => ({ supported: false, reason: 'Failed to connect to bus' }),
    });
    expect(await runAutostartCommand(['--uninstall'], r.deps)).toBe(0);
    expect(r.calls).toEqual(['uninstall']);
  });

  test('a bad option exits non-zero and writes nothing', async () => {
    const r = recorder();
    expect(await runAutostartCommand(['--frce'], r.deps)).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.out()).toContain('unknown option: --frce');
    expect(r.out()).toContain('jarvis autostart --help');
  });

  test('--help prints usage and does nothing else', async () => {
    const r = recorder();
    expect(await runAutostartCommand(['--help'], r.deps)).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out()).toContain('jarvis autostart --status');
  });

  test('the definition read is the one whose path is printed', async () => {
    // readInstalled takes the path the command resolved, so the file that is
    // compared and the file that is named can never drift apart.
    const seen: string[] = [];
    const r = recorder({ readInstalled: (p) => { seen.push(p); return null; } });
    await runAutostartCommand(['--status'], r.deps);
    expect(seen).toEqual(['/home/u/.config/systemd/user/jarvis.service']);
  });
});

// Every test above replaces the whole dependency set, so a swapped accessor in
// the real wiring would be invisible. This checks that wiring, without calling
// anything that spawns or writes.
describe('defaultAutostartDeps', () => {
  test('the path, the unit name and the generated definition agree', () => {
    const deps = defaultAutostartDeps();
    expect(deps.platform).toBe(process.platform);
    const path = deps.path();
    if (process.platform === 'linux') {
      expect(deps.unitName()).toBe('jarvis.service');
      expect(path).toEndWith('/.config/systemd/user/jarvis.service');
      expect(deps.generate()).toContain('ExecStart=');
      expect(deps.manager()).toContain('systemd');
    } else if (process.platform === 'darwin') {
      expect(deps.unitName()).toBe('ai.jarvis.daemon');
      expect(path).toEndWith('/Library/LaunchAgents/ai.jarvis.daemon.plist');
      expect(deps.generate()).toContain('<key>KeepAlive</key>');
      expect(deps.manager()).toContain('launchd');
    } else {
      expect(path).toBeNull();
    }
  });

  test('readInstalled reads the path it is given, not one of its own', () => {
    const deps = defaultAutostartDeps();
    expect(deps.readInstalled('/nonexistent/jarvis.service')).toBeNull();
    expect(deps.dropIns('/nonexistent/jarvis.service')).toEqual([]);
  });
});
