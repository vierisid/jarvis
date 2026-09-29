/**
 * Make the daemon's own /proc entries unreadable to same-uid processes (#546).
 *
 * On Linux, `prctl(PR_SET_DUMPABLE, 0)` marks the process non-dumpable. The
 * kernel then reassigns the FILES under `/proc/<pid>` to root and refuses
 * ptrace-gated reads to anyone else, which closes:
 *
 *   - `/proc/<pid>/environ`, the daemon's whole startup environment -- every
 *     API key, the workflow encryption key, the debug-RPC secret. This is the
 *     kernel-level half of #528/#551: the tool layer refuses the PATH, this
 *     refuses the READ, so a shell one-liner from a workflow CODE step or
 *     `run_command` gets EACCES instead of the secrets;
 *   - `/proc/<pid>/fd/` and `/proc/<pid>/fdinfo/`, i.e. which files and sockets
 *     the daemon has open, and a way to reopen them;
 *   - `/proc/<pid>/mem`, `maps`, `smaps`, `pagemap`, `stack`, `auxv`,
 *     `syscall`, `io`, and the `exe`/`cwd`/`root` links;
 *   - ptrace attach by the same user (gdb, strace), and core dumps of the
 *     daemon, which are a full dump of its secrets by another name.
 *
 * WHAT IT DOES NOT CLOSE, measured, because the tool layer still has to:
 * `/proc/<pid>/cmdline`, `stat`, `status`, `statm`, `cgroup`, `limits`, `comm`,
 * `mounts` and `mountinfo` stay readable to any same-uid process. (`wchan`
 * opens and reads too, but answers `0` to a stranger rather than the real
 * symbol -- it is ptrace-gated in the kernel, so it is neither closed nor
 * informative. Do not cite it either way.)
 * Three of those (`cmdline`, `mounts`, `mountinfo`) are in
 * PROC_REFUSED_LEAVES in src/actions/tools/file-path-policy.ts precisely
 * because they leak. So this does NOT make the path-level refusals redundant
 * and is no reason to relax them. Nor is it a same-uid security boundary at
 * all: the same user still reads `~/.jarvis`, the keychain and the log file
 * directly, root can still attach, and anything already in the daemon's argv
 * stays visible. It raises the cost of one channel.
 *
 * Note that mode is NOT the rule for what survives. Two independent mechanisms
 * are at work: the kernel's `task_dump_owner()` flips files to root ownership,
 * which closes the mode-0400 ones (`environ`, `io`, `auxv`, `syscall`) to
 * EVERYONE INCLUDING THE DAEMON ITSELF, while ptrace gating closes a larger
 * set to strangers only -- `/proc/<pid>/maps` is mode 0444 and still EACCES to
 * a same-uid reader. Do not clear a new `/proc` read by checking its mode.
 *
 * WHAT THE DAEMON ITSELF KEEPS. `/proc/self/stat` (the engine owner-start
 * stamp, src/workflows/runner/engine-runtime/spawn.ts), `/proc/self/cgroup`
 * (container detection) and `readlink /proc/self/fd/<n>` (#551's TOCTOU close
 * in src/actions/tools/builtin.ts) all keep working: `fd/` flips to root but
 * the kernel still admits the owning thread group. The daemon LOSES its own
 * `environ`, `io`, `auxv` and `syscall`, and loses WRITE access to its own
 * `comm`, `oom_score_adj` and `clear_refs` -- nothing here touches those, but
 * it does mean the brain's OOM score can no longer be adjusted after boot by
 * anything running as its user; that has to come from the supervisor before
 * exec (`OOMScoreAdjust=` in the unit).
 *
 * WHY ENGINE REAPING SURVIVES (#501, #491), which is the whole risk of this
 * change, since a reaper that silently stops identifying orphans leaks them
 * instead of failing loudly:
 *
 *   - `execve` resets dumpable to 1 for a same-uid, non-secureexec exec, and
 *     every child here is the same uid running `bun`. So engines are dumpable
 *     and the reaper's `environ`, `cmdline` and directory-uid reads on them all
 *     work. This is the invariant the entire argument rests on;
 *   - the #501 watchdog inside the engine reads its owner's
 *     `/proc/<owner>/stat` field 22 and calls `kill(owner, 0)`. `stat` is not
 *     ptrace-gated, and the kill probe returns success rather than EPERM --
 *     both measured against a non-dumpable owner. EPERM would have been worse
 *     than a leak: engine-reaper.ts reads EPERM as a recycled pid, so every
 *     pooled engine of a live daemon would have been killed at the next boot
 *     reap;
 *   - the reaper skips `process.pid` outright, and an external reaper
 *     (scripts/reap-engines.ts) gets EACCES on the daemon's environ, which it
 *     reads as "not an engine" -- the correct answer.
 *
 * IMPORTED FROM ONE PLACE ONLY: src/daemon/index.ts. A test in
 * process-hardening.test.ts pins that. If an engine, a bundle or the CLI ever
 * called this, the engine would become non-dumpable, `identifyEngine` would
 * catch the EACCES and return null, and the reaper would both stop reclaiming
 * orphans AND lose the protection that stops the bundle pruner deleting a
 * `main.js` out from under a running engine. All silently.
 */

import { cc } from 'bun:ffi';
import setDumpableSource from './set-dumpable.c' with { type: 'file' };
import {
  ENGINE_MARKER_ENV,
  ENGINE_MARKER_VALUE,
} from '../workflows/runner/engine-runtime/engine-lifecycle.ts';

/** What the hardening attempt did. Every case is logged; none throws. */
export type HardeningOutcome =
  /** Non-dumpable, and the kernel confirmed it on read-back. */
  | { kind: 'hardened' }
  /**
   * The call reported success but the flag did not change. A seccomp filter or
   * a sandboxed kernel (gVisor) can do this. Not an error, but the operator
   * must not believe in a control that is not in effect.
   */
  | { kind: 'not-verified'; dumpable: number }
  /** `daemon.allow_process_inspection: true`. The operator asked for this. */
  | { kind: 'allowed-by-config' }
  /** Not Linux: prctl does not exist. */
  | { kind: 'unsupported'; platform: string }
  /** The helper could not be built or loaded (no headers, no symbol). */
  | { kind: 'unavailable'; reason: string }
  /** prctl itself refused. */
  | { kind: 'refused'; errno: number }
  /**
   * This process carries the engine marker, so it is an engine (or a child of
   * one) rather than the daemon. Hardening it would make the reaper blind to
   * it. Refused at runtime because no static check can cover every route to
   * this function -- a dynamic import built from a path, for one.
   */
  | { kind: 'refused-engine-process' };

type DumpableSymbols = {
  do_set_dumpable: (value: number) => number;
  do_get_dumpable: () => number;
};

let symbols: DumpableSymbols | null = null;

/**
 * Compile the helper on first use, never at module load: importing this module
 * must stay safe on a platform or a toolchain where the C cannot be built. The
 * `import ... with { type: 'file' }` above is only a path string and is
 * harmless everywhere.
 *
 * This is a second TinyCC compilation unit on the boot path (~150-200ms
 * measured, alongside flock.c's). Accepted rather than folded into flock.c so
 * that the lock module -- which the CLI imports, and which every `jarvis`
 * invocation therefore loads -- cannot reach these symbols at all. Keeping the
 * blast radius of a stray call small is worth more here than the milliseconds,
 * given what a non-dumpable engine would do to the reaper.
 */
function load(): DumpableSymbols {
  if (symbols === null) {
    const built = cc({
      source: setDumpableSource,
      symbols: {
        do_set_dumpable: { args: ['i32'], returns: 'i32' },
        do_get_dumpable: { args: [], returns: 'i32' },
      },
    });
    symbols = built.symbols as DumpableSymbols;
  }
  return symbols;
}

export interface HardeningDeps {
  /** Defaults to `process.platform`. */
  platform?: string;
  /** Defaults to `process.env`. Only read, to spot an engine process. */
  env?: Record<string, string | undefined>;
  /**
   * The value of `daemon.allow_process_inspection` as the config loader
   * resolved it. Deliberately `unknown`: the hardening happens unless this is
   * EXACTLY `true`, so a value that slipped through unresolved (a string
   * `"yes"`, a mapping) fails closed rather than disabling the control.
   */
  allowInspection?: unknown;
  /**
   * The native helper, BOTH functions or neither. Deliberately not two
   * independent overrides: a caller that replaced only the getter would reach
   * the real `prctl` through the setter and make its own process non-dumpable
   * -- in a test runner that costs every later test in the process its
   * /proc/self/environ, which is exactly the accident this module's tests are
   * arranged to avoid.
   */
  symbols?: DumpableSymbols;
  /**
   * Resolve the native helper. Defaults to compiling set-dumpable.c. A test
   * substitutes one that throws to stand in for the real failures: no system
   * headers, no TinyCC, a libc whose prctl is missing.
   */
  loadSymbols?: () => DumpableSymbols;
  /** Where the "it worked" line goes. Defaults to console.log. */
  log?: (line: string) => void;
  /**
   * Where every outcome that is NOT "hardened" goes. Defaults to console.warn,
   * and separate from `log` on purpose: "a security control you believe in is
   * not in effect" deserves journald's warning priority and should be findable
   * by a log scanner, not buried at info level next to the boot chatter.
   */
  warn?: (line: string) => void;
}

/**
 * Called once, early in startDaemon(). Never throws, whatever happens: a
 * hardening call that fails is a line in the log, not a daemon that will not
 * start.
 */
export function hardenProcessInspection(deps: HardeningDeps = {}): HardeningOutcome {
  const platform = deps.platform ?? process.platform;
  const log = deps.log ?? ((line: string) => console.log(line));
  const warn = deps.warn ?? ((line: string) => console.warn(line));

  /*
   * Never harden an ENGINE. A non-dumpable engine is the one way this change
   * could break #501 silently: identifyEngine() would catch the EACCES on its
   * environ, return null, and the reaper would both stop reclaiming orphans
   * and lose the protection that stops the bundle pruner deleting a `main.js`
   * out from under a running engine.
   *
   * The import guard in the tests keeps this module out of everything but the
   * daemon's entry point, but it can only see literal import specifiers, and a
   * specifier built at runtime slips past it. This check does not care how the
   * call was reached. It is deliberately the FIRST thing here: refusing to
   * harden leaves the pre-#546 status quo, which is recoverable, while
   * hardening an engine is not.
   */
  const env = deps.env ?? process.env;
  if (env[ENGINE_MARKER_ENV] === ENGINE_MARKER_VALUE) {
    warn(
      '[Daemon] REFUSING to block process inspection: this process carries ' +
        `${ENGINE_MARKER_ENV}, so it is a workflow engine, not the daemon. ` +
        'Hardening it would make the engine reaper unable to identify it ' +
        '(#501). Nothing was changed; this is a bug in the caller.',
    );
    return { kind: 'refused-engine-process' };
  }

  // prctl is Linux-only. macOS has no equivalent that is worth pretending
  // about (its task ports are guarded by the platform's own policy), and the
  // daemon is unsupported on native Windows. Both get nothing, and say so
  // once, so a reader of the log is never left guessing whether it worked.
  //
  // BEFORE the config check, not after: off Linux there is nothing for the
  // hatch to turn off, so reporting `allowed-by-config` there would claim a
  // change that never applied, and its warning talks about /proc entries that
  // do not exist on the platform reading it.
  if (platform !== 'linux') {
    log(
      `[Daemon] Process inspection hardening is Linux-only; on ${platform} the ` +
        "daemon's /proc-equivalent state is left as the platform has it.",
    );
    return { kind: 'unsupported', platform };
  }

  // Fail closed: only an explicit `true` from the config reader opens this.
  if (deps.allowInspection === true) {
    warn(
      '[Daemon] Process inspection ALLOWED by daemon.allow_process_inspection: ' +
        "this daemon's /proc entries, including its environment and its open " +
        'files, are readable by any process running as this user.',
    );
    return { kind: 'allowed-by-config' };
  }

  let set: (value: number) => number;
  let get: () => number;
  try {
    const resolved = deps.symbols ?? (deps.loadSymbols ?? load)();
    set = resolved.do_set_dumpable;
    get = resolved.do_get_dumpable;
  } catch (err) {
    // No system headers, no TinyCC, a missing symbol, a libc without prctl.
    // Log and carry on -- this is defense in depth, and the daemon not
    // starting is a worse outcome than the hardening being absent.
    const reason = err instanceof Error ? err.message : String(err);
    warn(
      `[Daemon] Could not load the process-hardening helper (${reason}); ` +
        "continuing WITHOUT it: this daemon's /proc entries stay readable to " +
        'processes running as this user.',
    );
    return { kind: 'unavailable', reason };
  }

  let rc: number;
  try {
    rc = set(0);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`[Daemon] prctl(PR_SET_DUMPABLE, 0) could not be called (${reason}); continuing without it.`);
    return { kind: 'unavailable', reason };
  }
  if (rc !== 0) {
    warn(`[Daemon] prctl(PR_SET_DUMPABLE, 0) failed with errno ${rc}; continuing without it.`);
    return { kind: 'refused', errno: rc };
  }

  // Read back, because success from the call is not proof of effect.
  let dumpable = -1;
  try {
    dumpable = get();
  } catch {
    dumpable = -1;
  }
  if (dumpable !== 0) {
    warn(
      `[Daemon] prctl(PR_SET_DUMPABLE, 0) reported success but the flag is ` +
        `${dumpable === -1 ? 'unreadable' : dumpable}; assume this daemon's ` +
        '/proc entries are still readable by this user.',
    );
    return { kind: 'not-verified', dumpable };
  }

  log(
    "[Daemon] Process inspection blocked: this daemon's /proc environment, open " +
      'files and memory are closed to other processes running as this user ' +
      '(PR_SET_DUMPABLE=0). Set daemon.allow_process_inspection: true to allow ' +
      'strace/gdb/core dumps of the daemon.',
  );
  return { kind: 'hardened' };
}
