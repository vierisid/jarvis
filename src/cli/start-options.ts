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
 * a previous daemon's and is ignored.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  try {
    // Absolute, because `jarvis update` may run from another directory than
    // the one this daemon resolved a relative path against.
    const picked = pickOptions(options);
    if (picked.dataDir) picked.dataDir = resolve(picked.dataDir);
    if (picked.systemConfigPath) picked.systemConfigPath = resolve(picked.systemConfigPath);
    writeFileSync(startOptionsPath(), JSON.stringify({ pid, options: picked }) + '\n', { mode: 0o600 });
  } catch (err) {
    console.error(`[start] Could not record the start options (jarvis update will restart with defaults): ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * The options the daemon with `pid` recorded, or null when it recorded none
 * (started by an older version, or not through `jarvis start`). A field of the
 * wrong shape is dropped rather than passed to the new daemon's argv.
 */
export function readStartOptions(pid: number): DaemonStartOptions | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(startOptionsPath(), 'utf-8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as { pid?: unknown; options?: unknown };
  if (record.pid !== pid || !record.options || typeof record.options !== 'object') return null;
  return pickOptions(record.options as Record<string, unknown>);
}

function pickOptions(raw: DaemonStartOptions | Record<string, unknown>): DaemonStartOptions {
  const options: DaemonStartOptions = {};
  const { port, dataDir, noLocalTools, systemConfigPath } = raw as Record<string, unknown>;
  if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) options.port = port;
  // A value starting with '-' would be read as a flag by the child's cmdStart:
  // `--data-dir -d` would make every child detach again.
  if (typeof dataDir === 'string' && dataDir && !dataDir.startsWith('-')) options.dataDir = dataDir;
  if (noLocalTools === true) options.noLocalTools = true;
  if (typeof systemConfigPath === 'string' && systemConfigPath && !systemConfigPath.startsWith('-')) {
    options.systemConfigPath = systemConfigPath;
  }
  return options;
}
