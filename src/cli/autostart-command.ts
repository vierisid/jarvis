/**
 * `jarvis autostart` - install, refresh, inspect or remove the autostart
 * definition for this platform (#548).
 *
 * Until this existed, `installAutostart` and `startAutostartService` had no
 * caller anywhere in the tree: the generator could be fixed but the fix could
 * not reach an install, which is why #547 had to ship a read-only drift
 * detector and a copy-pasteable drop-in as its whole delivery mechanism.
 *
 * Three rules shape everything below.
 *
 * 1. A definition that differs from the one this version writes is NEVER
 *    rewritten without `--force`. There is no way to tell "written by an older
 *    JARVIS" from "edited by hand": #547's detector is tolerant of extra keys
 *    and of a different bun path on purpose, and the generated text depends on
 *    the installing shell anyway (`Bun.which('bun')`, `JARVIS_HOME`), so even an
 *    untouched install can differ legitimately. So the difference is printed,
 *    nothing is written, and the exit code is non-zero -- the user asked for an
 *    install and none happened. A prompt would have been the other option, but
 *    this also runs from provisioning scripts, where `--force` is the answer.
 *
 * 2. Nothing is started or restarted behind the user's back. A fresh install is
 *    started only when no daemon holds the lock, because the unit's ExecStart is
 *    `jarvis start --foreground`, which exits 1 against a live lock -- under
 *    Restart=on-failure that is five failed starts and a unit left FAILED, i.e.
 *    installing autostart would have broken a daemon that was running fine. A
 *    refresh never restarts: systemd picks the new ExecStart up at the next
 *    start, launchd only after a bootout/bootstrap, and which one is correct
 *    depends on whether the running daemon is the service's own. The output says
 *    so and names the command instead.
 *
 * 3. "The file is already right" is not the same as "there is nothing to do".
 *    `installSystemd` writes, reloads and enables in that order, so a failure at
 *    either of the last two leaves a byte-current unit systemd will never start.
 *    Such a definition is repaired through `enableAutostart`, which does not
 *    touch the file, so the repair cannot cost anyone the comments they added.
 */

import { c } from './helpers.ts';
import {
  checkAutostartSupport,
  checkInstalledAutostart,
  describeAutostartProblem,
  enableAutostart,
  generateAutostartDefinition,
  getAutostartDropIns,
  getAutostartName,
  getAutostartPath,
  getAutostartUnitName,
  installAutostart,
  meaningfulAutostartLines,
  readAutostartEnabled,
  readInstalledAutostart,
  startAutostartService,
  uninstallAutostart,
  type AutostartDrift,
  type AutostartKind,
  type SystemdProbeResult,
} from './autostart.ts';
import { isLocked } from '../daemon/pid.ts';

// ── Arguments ────────────────────────────────────────────────────────

export type AutostartMode = 'install' | 'status' | 'uninstall' | 'help';

export interface AutostartOptions {
  mode: AutostartMode;
  /** Overwrite a definition that differs from the one this version writes. */
  force: boolean;
  /** Start the service after installing. */
  start: boolean;
}

export type ParsedAutostartArgs = { options: AutostartOptions } | { error: string };

/**
 * Strict on purpose: an unknown flag is an error rather than an install. A typo
 * such as `jarvis autostart --uninstal` must not write the unit.
 */
export function parseAutostartArgs(args: string[]): ParsedAutostartArgs {
  const options: AutostartOptions = { mode: 'install', force: false, start: true };
  let mode: AutostartMode | null = null;

  // `--help` wins wherever it appears, and before the compatibility rules below:
  // asking how the command works must never be answered with a usage error.
  if (args.includes('--help') || args.includes('-h')) {
    return { options: { ...options, mode: 'help' } };
  }

  for (const arg of args) {
    switch (arg) {
      case '--status':
        if (mode && mode !== 'status') return { error: `--status cannot be combined with --${mode}` };
        mode = 'status';
        break;
      case '--uninstall':
        if (mode && mode !== 'uninstall') return { error: `--uninstall cannot be combined with --${mode}` };
        mode = 'uninstall';
        break;
      case '--force':
        options.force = true;
        break;
      case '--no-start':
        options.start = false;
        break;
      default:
        return { error: `unknown option: ${arg}` };
    }
  }

  if (mode) options.mode = mode;
  if (options.mode !== 'install' && options.force) {
    return { error: `--force only applies to installing; drop it from --${options.mode}` };
  }
  if (options.mode !== 'install' && !options.start) {
    return { error: `--no-start only applies to installing; drop it from --${options.mode}` };
  }
  return { options };
}

export const AUTOSTART_HELP = `${c.bold('jarvis autostart')} - keep JARVIS running across logins

${c.bold('Usage:')}
  jarvis autostart [--force] [--no-start]   Install or refresh the definition
  jarvis autostart --status                 Show what is installed
  jarvis autostart --uninstall              Remove it

${c.bold('Options:')}
  --force      Overwrite a definition that differs from this version's. Without
               it, the differences are printed and nothing is written, because
               an older install and an edit of your own look the same from here.
  --no-start   Install only. Do not start the service now.
  --status     Show where the definition lives, whether it matches this version,
               whether it is enabled, and what a stale one still does.
  --uninstall  Stop the service and remove the definition.

${c.bold('Notes:')}
  A fresh install is started only when no daemon is running already: the service
  starts the daemon itself, and a second one would fail on the lock.
  A refresh never restarts a running daemon - it keeps the definition it was
  started with until it restarts.
  On Linux the service starts at boot too, as long as \`loginctl enable-linger\`
  worked; a macOS launch agent starts at login.`;

// ── Comparing what is installed with what we would write ─────────────

export type AutostartFileState = 'absent' | 'current' | 'differs';

export interface AutostartComparison {
  state: AutostartFileState;
  /** Meaningful lines on disk that the new definition does not have. */
  onlyOnDisk: string[];
  /** Meaningful lines the new definition has that are not on disk. */
  onlyInNew: string[];
  /**
   * Comment LINES on disk that the new definition does not contain verbatim.
   * Not necessarily the user's own: this repo reworded the unit's comments in
   * #543/#547, so an older install contributes to this too. A multi-line XML
   * comment counts as its first line only.
   */
  commentsOnlyOnDisk: number;
}

function multisetDiff(from: string[], to: string[]): { removed: string[]; added: string[] } {
  const counts = new Map<string, number>();
  for (const line of to) counts.set(line, (counts.get(line) ?? 0) + 1);
  const removed: string[] = [];
  for (const line of from) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else removed.push(line);
  }
  const added: string[] = [];
  for (const line of to) {
    // Walk `to` again so additions keep the order they are written in.
    const n = counts.get(line) ?? 0;
    if (n > 0) { added.push(line); counts.set(line, n - 1); }
  }
  return { removed, added };
}

/** Comment lines in `installed` that do not appear verbatim in `generated`. */
function commentsOnlyOnDisk(installed: string, generated: string, kind: AutostartKind): number {
  const own = new Set(generated.split('\n').map((l) => l.trim()));
  const isComment = (line: string) =>
    kind === 'systemd' ? line.startsWith('#') || line.startsWith(';') : line.startsWith('<!--');
  return installed
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => isComment(l) && !own.has(l))
    .length;
}

/**
 * Compared by MEANING, not by bytes: systemd directives with their section,
 * launchd key/value pairs (`KeepAlive.SuccessfulExit=<false/>`).
 *
 * So a comment-only difference -- this version reworded the rationale in the
 * unit, or the user wrote a note of their own above a directive -- is not a
 * reason to demand `--force`, and is not a reason to rewrite the file either.
 * `commentsOnlyOnDisk` counts what a rewrite WOULD cost, for the one case where
 * a rewrite happens anyway: `--force` replaces the whole file.
 */
export function compareAutostart(
  installed: string | null,
  generated: string,
  kind: AutostartKind,
): AutostartComparison {
  if (installed === null) return { state: 'absent', onlyOnDisk: [], onlyInNew: [], commentsOnlyOnDisk: 0 };
  const before = meaningfulAutostartLines(installed, kind);
  const after = meaningfulAutostartLines(generated, kind);
  const { removed, added } = multisetDiff(before, after);
  return {
    state: removed.length === 0 && added.length === 0 ? 'current' : 'differs',
    onlyOnDisk: removed,
    onlyInNew: added,
    commentsOnlyOnDisk: commentsOnlyOnDisk(installed, generated, kind),
  };
}

// ── Dependencies (injected in tests) ─────────────────────────────────

export interface AutostartCommandDeps {
  platform: string;
  support(): SystemdProbeResult;
  path(): string | null;
  manager(): string;
  unitName(): string;
  generate(): string;
  readInstalled(path: string): string | null;
  install(): Promise<boolean>;
  /** Register an already-correct definition with the manager, without writing. */
  enable(): boolean;
  start(options: { replaceLoaded: boolean }): Promise<boolean>;
  uninstall(): Promise<boolean>;
  /** systemd's `is-enabled`; null when the answer is not knowable here. */
  enabled(): boolean | null;
  /** Drop-in override files that change the effective definition. */
  dropIns(path: string): string[];
  runningPid(): number | null;
  drift(): AutostartDrift | null;
  log(line: string): void;
}

/**
 * The real wiring. Exported so a test can assert it is internally consistent:
 * every test below replaces all of it, so a swapped accessor here would
 * otherwise be invisible.
 */
export function defaultAutostartDeps(): AutostartCommandDeps {
  return {
    platform: process.platform,
    support: checkAutostartSupport,
    path: getAutostartPath,
    manager: getAutostartName,
    unitName: getAutostartUnitName,
    generate: generateAutostartDefinition,
    readInstalled: readInstalledAutostart,
    install: installAutostart,
    enable: enableAutostart,
    start: startAutostartService,
    uninstall: uninstallAutostart,
    enabled: readAutostartEnabled,
    dropIns: getAutostartDropIns,
    runningPid: isLocked,
    drift: checkInstalledAutostart,
    log: (line) => console.log(line),
  };
}

function kindOf(platform: string): AutostartKind | null {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  return null;
}

// ── Output helpers ───────────────────────────────────────────────────

const MAX_DIFF_LINES = 10;

/**
 * printErr's shape, through the injected sink: every line this command emits has
 * to be capturable, or a test cannot assert what the user was told.
 */
function logErr(log: (line: string) => void, message: string): void {
  log(`  ${c.red('✗')} ${message}`);
}

function listLines(log: (line: string) => void, marker: string, lines: string[], hiddenNote: string): void {
  for (const line of lines.slice(0, MAX_DIFF_LINES)) {
    log(c.dim(`      ${marker} ${line}`));
  }
  if (lines.length > MAX_DIFF_LINES) {
    log(c.dim(`      ... and ${lines.length - MAX_DIFF_LINES} more${hiddenNote}`));
  }
}

/** How to apply a definition the running daemon has not picked up yet. */
function applyNowHint(kind: AutostartKind, unit: string, path: string): string[] {
  if (kind === 'systemd') {
    return [
      'A daemon is running with the definition it was started with.',
      `If it is the service's own, apply the new one now:  systemctl --user restart ${unit}`,
    ];
  }
  return [
    'A daemon is running with the definition it was started with.',
    "If it is the agent's own, apply the new one now:",
    `  launchctl bootout gui/$(id -u)/${unit} && launchctl bootstrap gui/$(id -u) ${path}`,
  ];
}

/**
 * What happens next when nothing was started here.
 *
 * With a daemon already up, the manual start command is deliberately NOT
 * offered: against a live lock the service's own ExecStart exits non-zero, which
 * is how the start limit gets hit and the unit ends up failed -- the exact
 * outcome this command avoids by not starting.
 */
function bootExpectation(kind: AutostartKind, unit: string, path: string, pid: number | null): string[] {
  if (pid !== null) {
    return kind === 'systemd'
      ? [`Nothing was started: JARVIS is already running (PID ${pid}). The service takes over at your next login.`]
      : [`Nothing was loaded: JARVIS is already running (PID ${pid}). The agent takes over at your next login.`];
  }
  return kind === 'systemd'
    ? [`Nothing was started. The service starts JARVIS at your next login, or now: systemctl --user start ${unit}`]
    : [
      'Nothing was loaded. The agent starts JARVIS at your next login.',
      `  Load it now: launchctl bootstrap gui/$(id -u) ${path}`,
    ];
}

function reportDrift(log: (line: string) => void, drift: AutostartDrift | null): void {
  if (!drift) return;
  log(c.yellow(`  ! ${drift.path} still has what this version fixes:`));
  for (const problem of drift.problems) {
    log(c.dim(`      ${describeAutostartProblem(problem)}`));
  }
}

// ── The command ──────────────────────────────────────────────────────

/**
 * Returns the process exit code. For an install, 0 only when the definition on
 * disk is the one this version writes AND the manager knows about it, so a
 * refusal to overwrite, a unit that is present but not enabled, and a failed
 * start are all visible to a script; for --uninstall, 0 when nothing is left.
 * `--status` answers a question and always exits 0 -- absent, drifted and
 * unenabled are answers, not failures -- so scripts use the install path to
 * assert a state, not --status.
 */
export async function runAutostartCommand(
  args: string[] = [],
  overrides: Partial<AutostartCommandDeps> = {},
): Promise<number> {
  const deps: AutostartCommandDeps = { ...defaultAutostartDeps(), ...overrides };
  const { log } = deps;

  const parsed = parseAutostartArgs(args);
  if ('error' in parsed) {
    logErr(log, `jarvis autostart: ${parsed.error}`);
    log(c.dim('  Run `jarvis autostart --help` for usage.'));
    return 1;
  }
  const options = parsed.options;
  if (options.mode === 'help') {
    log(AUTOSTART_HELP);
    return 0;
  }

  const kind = kindOf(deps.platform);
  const path = deps.path();
  if (kind === null || path === null) {
    log(c.yellow(`Autostart is not available on ${deps.platform}.`));
    log(c.dim('  Linux uses a systemd user service, macOS a launchd user agent.'));
    // --status answers a question, and "not available here" IS the answer; so
    // does --uninstall, which has nothing it could have failed to remove.
    return options.mode === 'install' ? 1 : 0;
  }
  const unit = deps.unitName();

  if (options.mode === 'uninstall') {
    const present = deps.readInstalled(path) !== null;
    if (present) {
      log(c.cyan(`Removing ${deps.manager()}: ${path}`));
      log(c.dim('  This stops the service, so a daemon running under it exits too.'));
    } else {
      // Not an early return: the file can be gone while the unit is still
      // enabled and running (somebody deleted it by hand), and uninstallSystemd
      // stops and disables unconditionally. Both platforms' removers are
      // idempotent, so this is safe when there really is nothing left.
      log(c.yellow(`No ${deps.manager()} definition is installed at ${path}.`));
      log(c.dim('  Clearing any registration left behind anyway.'));
    }
    // uninstallAutostart prints its own result line.
    return (await deps.uninstall()) ? 0 : 1;
  }

  const installed = deps.readInstalled(path);
  const comparison = compareAutostart(installed, deps.generate(), kind);

  if (options.mode === 'status') {
    printStatus(deps, { kind, path, unit, comparison });
    return 0;
  }

  // ── install / refresh ──
  const support = deps.support();
  if (!support.supported) {
    logErr(log, `Cannot install autostart: ${support.reason ?? 'the service manager is unreachable'}`);
    if (kind === 'systemd') {
      log(c.dim('  A systemd user manager has to be reachable. Under WSL2, enable systemd'));
      log(c.dim('    (/etc/wsl.conf: [boot] systemd=true) and restart the distro.'));
      log(c.dim('  In a container, supervise the daemon with the container runtime instead.'));
    }
    return 1;
  }

  // `--force` is an explicit request, so it writes even when the content already
  // matches: it is also how to re-run the reload and enable steps from scratch.
  const wrote = comparison.state !== 'current' || options.force;

  if (!wrote) {
    log(c.green(`✓ ${deps.manager()} is already what this version installs.`));
    log(c.dim(`  ${path} (left untouched)`));
    // A byte-current unit the manager will not start is the one "nothing to do"
    // that really is something to do: installSystemd writes before it reloads and
    // enables, so a failure there leaves exactly this. Repaired without touching
    // the file, which is what keeps the user's comments.
    if (deps.enabled() === false) {
      log(c.yellow('  ! ...but the manager will not start it by itself. Enabling it now.'));
      if (!deps.enable()) return 1;
    }
  } else {
    if (comparison.state === 'differs' && !options.force) {
      log(c.yellow(`! ${path} differs from the definition this version installs.`));
      // A binary property list (`plutil -convert binary1`) is one launchd loads
      // happily, and reading it as text yields no pairs, so the fallback would
      // print control bytes and one enormous line as the "difference".
      if (installed !== null && installed.includes('\u0000')) {
        log(c.dim('    The file on disk is not text (a binary property list), so what changed'));
        log(c.dim('    cannot be shown. Compare it yourself with: plutil -p <path>'));
      } else if (comparison.onlyOnDisk.length > 0) {
        log(c.dim('    on disk, and not in the new one:'));
        listLines(log, '-', comparison.onlyOnDisk, ', which --force also removes');
      }
      if (comparison.onlyInNew.length > 0 && !(installed !== null && installed.includes('\u0000'))) {
        log(c.dim('    in the new one, and not on disk:'));
        listLines(log, '+', comparison.onlyInNew, '');
      }
      log('');
      log(c.dim('  Nothing was written. This cannot tell an older install from an edit'));
      log(c.dim('  of your own, and the bun path alone differs between shells.'));
      log(c.dim('  Overwrite it:   jarvis autostart --force'));
      if (comparison.commentsOnlyOnDisk > 0) {
        // --force replaces the whole file, and comments are deliberately not
        // compared, so this is the one cost the diff above cannot show. Said
        // without attributing them: an older JARVIS wrote comments of its own.
        log(c.dim(`                  (it rewrites the whole file: ${comparison.commentsOnlyOnDisk} comment line(s)`));
        log(c.dim('                   on disk are not in the new definition and would be lost)'));
      }
      log(kind === 'systemd'
        ? c.dim(`  Keep your edit: systemctl --user edit ${unit}   (a drop-in survives a reinstall)`)
        : c.dim('  Keep your edit: copy your changes back into the plist after --force.'));
      return 1;
    }

    log(c.cyan(installed === null
      ? `Installing ${deps.manager()}...`
      : `Refreshing ${deps.manager()} (--force)...`));
    // installAutostart prints the path it wrote and its own failures.
    if (!await deps.install()) return 1;
  }

  // ── start, or say why not ──
  const pid = deps.runningPid();
  if (!options.start) {
    for (const line of bootExpectation(kind, unit, path, pid)) log(c.dim(`  ${line}`));
    return 0;
  }
  if (pid !== null) {
    log(c.dim(`  JARVIS is already running (PID ${pid}); not starting a second one.`));
    // Only when there IS a new definition to apply. After a run that wrote
    // nothing there is nothing to restart for, and saying otherwise would churn
    // the user's daemon for no reason.
    if (wrote) {
      for (const line of applyNowHint(kind, unit, path)) log(c.dim(`  ${line}`));
    }
    return 0;
  }
  if (wrote && installed !== null) {
    log(c.dim('  Starting the service with the new definition...'));
  }
  // startAutostartService prints its own success and failure lines.
  // replaceLoaded matters on macOS only: `launchctl bootstrap` on an already
  // loaded agent keeps the plist launchd read last, so a refresh would look like
  // it worked while the old definition stayed live. The lock being free (pid ===
  // null, checked above) is what makes booting the agent out safe.
  if (!await deps.start({ replaceLoaded: wrote })) {
    for (const line of bootExpectation(kind, unit, path, null)) log(c.dim(`  ${line}`));
    return 1;
  }
  return 0;
}

function printStatus(
  deps: AutostartCommandDeps,
  ctx: { kind: AutostartKind; path: string; unit: string; comparison: AutostartComparison },
): void {
  const { log } = deps;
  const { comparison, path, kind, unit } = ctx;
  log(`Autostart: ${c.bold(deps.manager())}`);
  log(c.dim(`  Definition: ${path}`));

  const state = comparison.state === 'absent'
    ? 'not installed'
    : comparison.state === 'current'
      ? 'installed, and the same as this version installs'
      : `installed, and different from this version in ${comparison.onlyOnDisk.length + comparison.onlyInNew.length} line(s)`;
  log(c.dim(`  State:      ${state}`));

  let needsEnable = false;
  if (comparison.state !== 'absent') {
    const enabled = deps.enabled();
    if (enabled !== null) {
      needsEnable = !enabled;
      log(c.dim(`  Enabled:    ${enabled
        ? 'yes, it starts at login (and at boot, with lingering enabled)'
        : `no, the file is there but the manager will not start it (systemctl --user is-enabled ${unit})`}`));
    }
    const dropIns = deps.dropIns(path);
    if (dropIns.length > 0) {
      // The state above compared the main file only, and #547's drift detector
      // goes silent entirely once a drop-in exists. Neither can say what the
      // override changed, so name the one command that shows the merge.
      log(c.dim(`  Overrides:  ${dropIns.join(', ')}`));
      log(c.dim('              the effective definition is these merged over the file above:'));
      log(c.dim(`              systemctl --user cat ${unit}`));
    }
  }

  const pid = deps.runningPid();
  log(c.dim(`  Daemon:     ${pid === null ? 'not running' : `running (PID ${pid})`}`));

  const support = deps.support();
  if (!support.supported) {
    log(c.yellow(`  ! ${deps.manager()} is not usable here: ${support.reason ?? 'unreachable'}`));
  }

  reportDrift(log, deps.drift());

  if (comparison.state === 'absent') {
    log(c.dim('  Install it: jarvis autostart'));
  } else if (comparison.state === 'differs') {
    log(c.dim('  Refresh it: jarvis autostart          (prints what would change)'));
    log(c.dim('              jarvis autostart --force  (writes it)'));
    if (kind === 'systemd') {
      log(c.dim(`  Keep edits: systemctl --user edit ${unit}`));
    }
  } else if (needsEnable) {
    log(c.dim('  Enable it:  jarvis autostart   (the file is current; this only registers it)'));
  }
}
