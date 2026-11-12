/**
 * The `jarvis start` options a daemon was launched with, and the argv that
 * launches another one the same way.
 *
 * Two launchers start a daemon from inside the CLI rather than from the
 * user's own command line: `jarvis start -d`, which re-runs `jarvis start` as a
 * detached child, and `jarvis update`, which stops the daemon, updates and
 * starts a new one. Both used to hand the child a fixed argv, so the child came
 * up on the default port and data dir whatever the user had asked for.
 *
 * `jarvis update` cannot see the argv of the daemon it stops (on macOS there is
 * no portable way to read another process's arguments intact), so the daemon
 * writes its options next to its lock when it starts, tagged with its pid, and
 * the update reads them back for that pid only. A record for any other pid is
 * a previous daemon's and is ignored, and the daemon removes its own record
 * when it exits, so a later process that reuses the pid does not inherit it.
 *
 * The record is only ever argv for `bun jarvis.ts start` (no shell), and is
 * read only when it is a regular file of this user's that no one else can
 * write: every value is re-validated on the way out, and a path must be
 * absolute, so nothing in it can become another flag.
 */

import { closeSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { getPidPath } from '../daemon/pid.ts';

export interface DaemonStartOptions {
  port?: number;
  dataDir?: string;
  noLocalTools?: boolean;
  systemConfigPath?: string;
}

/** The flags, after `start --no-open`, that start a daemon with these options. */
export function daemonStartFlags(raw: DaemonStartOptions): string[] {
  const options = pickOptions(raw);
  const flags: string[] = [];
  if (options.port !== undefined) flags.push('--port', String(options.port));
  if (options.dataDir) flags.push('--data-dir', options.dataDir);
  if (options.noLocalTools) flags.push('--no-local-tools');
  if (options.systemConfigPath) flags.push('--system-config', options.systemConfigPath);
  return flags;
}

/** The `jarvis start` flags that set an option daemonStartFlags forwards. */
const START_OPTION_FLAGS = ['--port', '--data-dir', '--no-local-tools', '--system-config'];

/**
 * The argv `jarvis restart` starts the new daemon with. Given none of the start
 * options, it restarts with the ones the stopped daemon recorded, as `jarvis
 * update` does; given any, it uses exactly what it was given, so a restart can
 * also drop an option. `reused` is what it took from the record, if anything.
 */
export function restartStartArgs(args: string[], recorded: DaemonStartOptions | null): { args: string[]; reused: string[] } {
  const explicit = args.some(arg => START_OPTION_FLAGS.includes(arg) || START_OPTION_FLAGS.some(flag => arg.startsWith(`${flag}=`)));
  if (explicit || !recorded) return { args, reused: [] };
  const reused = daemonStartFlags(recorded);
  return { args: [...args, ...reused], reused };
}

/** Beside the lock, so it follows JARVIS_HOME the way the lock does. */
export function startOptionsPath(): string {
  return join(dirname(getPidPath()), 'daemon-start.json');
}

/**
 * Record what the daemon with `pid` was started with. Written on every CLI
 * start, including one with no options, so a later update never reads an
 * earlier daemon's flags. Best effort: a failure costs only the restart's
 * memory of the flags, which `jarvis update` then says.
 */
export function recordStartOptions(pid: number, options: DaemonStartOptions): void {
  const path = startOptionsPath();
  const temp = `${path}.${pid}.tmp`;
  try {
    // Absolute, because `jarvis update` may run from another directory than
    // the one this daemon resolved a relative path against.
    const picked = pickOptions(options);
    if (picked.dataDir) picked.dataDir = resolve(picked.dataDir);
    if (picked.systemConfigPath) picked.systemConfigPath = resolve(picked.systemConfigPath);
    // A fresh 0600 file renamed into place: writeFileSync's mode applies only
    // when it creates the file, and it would follow a symlink at the path.
    try { unlinkSync(temp); } catch { /* none left over */ }
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify({ pid, options: picked }) + '\n');
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* not created */ }
    console.error(`[start] Could not record the start options (jarvis update will restart with defaults): ${err instanceof Error ? err.message : err}`);
  }
}

/** Remove the record if it is `pid`'s: the daemon's exit, so a reused pid inherits nothing. */
export function clearStartOptions(pid: number): void {
  try {
    if (readRecord()?.pid === pid) unlinkSync(startOptionsPath());
  } catch { /* best effort */ }
}

/**
 * The options the daemon with `pid` recorded, or null when it recorded none
 * (started by an older version, or not through `jarvis start`), or the record
 * is not one to trust. A field of the wrong shape is dropped rather than
 * passed to the new daemon's argv.
 */
export function readStartOptions(pid: number): DaemonStartOptions | null {
  const record = readRecord();
  if (!record || record.pid !== pid || !record.options || typeof record.options !== 'object') return null;
  const options = pickOptions(record.options as Record<string, unknown>);
  // Recorded absolute; a relative one was not written by recordStartOptions,
  // and would resolve against wherever the restart happens to run.
  if (options.dataDir && !isAbsolute(options.dataDir)) delete options.dataDir;
  if (options.systemConfigPath && !isAbsolute(options.systemConfigPath)) delete options.systemConfigPath;
  return options;
}

function readRecord(): { pid?: unknown; options?: unknown } | null {
  const path = startOptionsPath();
  try {
    // Not a symlink, this user's, and not writable by anyone else: otherwise
    // whoever wrote it could choose the next daemon's data dir or config.
    const stat = lstatSync(path);
    if (!stat.isFile()) return null;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return null;
    if ((stat.mode & 0o022) !== 0) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed as { pid?: unknown; options?: unknown } : null;
  } catch {
    return null;
  }
}

/** Longest path argv will carry; a longer one is not one a daemon started with. */
const MAX_PATH_CHARS = 4096;

function validPathValue(value: unknown): value is string {
  // A value starting with '-' would be read as a flag by the child's cmdStart
  // (`--data-dir -d` would make every child detach again); a NUL cannot be
  // passed in argv at all.
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_CHARS
    && !value.startsWith('-') && !value.includes('\0');
}

function pickOptions(raw: DaemonStartOptions | Record<string, unknown>): DaemonStartOptions {
  const options: DaemonStartOptions = {};
  const { port, dataDir, noLocalTools, systemConfigPath } = raw as Record<string, unknown>;
  if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) options.port = port;
  if (validPathValue(dataDir)) options.dataDir = dataDir;
  if (noLocalTools === true) options.noLocalTools = true;
  if (validPathValue(systemConfigPath)) options.systemConfigPath = systemConfigPath;
  return options;
}
