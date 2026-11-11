/**
 * Is the database file there, and is it still the one Jarvis opened?
 *
 * `initDatabase` creates a database when there is none. That is right for a
 * first start and wrong for an install that already has other state: a missing
 * or empty `jarvis.db` next to `sidecar-keys/`, `workspace-id` or `.secrets.*`
 * is lost data, not a new install, and starting empty locks out the enrolled
 * devices while looking like a clean slate. These checks refuse that start
 * with a plain message and the restore command, and notice (while running) a
 * database file that was deleted, emptied or swapped, so writes stop instead of
 * going to a file that no longer exists.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Start over on purpose: lets Jarvis create an empty database next to existing state. */
export const NEW_DATABASE_FLAG = '--new-database';
export const NEW_DATABASE_ENV = 'JARVIS_ALLOW_NEW_DATABASE';

export type DatabaseProblemKind = 'missing' | 'empty' | 'damaged' | 'unwritable';

/** An error whose message is already the plain text for the owner: no stack needed. */
export class DatabaseProblemError extends Error {
  constructor(readonly kind: DatabaseProblemKind, message: string) {
    super(message);
    this.name = 'DatabaseProblemError';
  }
}

const RESTORE_HINT = 'To bring your data back, run: jarvis restore <your-backup-file>';

function nonEmptyDir(dir: string): boolean {
  try { return readdirSync(dir).length > 0; } catch { return false; }
}

/** What in the data folder shows that this install has been used before. */
export function installStateEvidence(dataDir: string, dbPath: string): string[] {
  const found: string[] = [];
  if (existsSync(join(dataDir, 'workspace-id'))) found.push('workspace-id');
  if (nonEmptyDir(join(dataDir, 'sidecar-keys'))) found.push('sidecar-keys');
  for (const name of ['.secrets.enc', '.secrets.key']) if (existsSync(join(dataDir, name))) found.push(name);
  try { if (statSync(`${dbPath}-wal`).size > 0) found.push('jarvis.db-wal'); } catch { /* none */ }
  return found;
}

export type DatabaseFileState = 'ok' | 'fresh' | 'missing' | 'empty';

export function inspectDatabaseFile(dbPath: string, dataDir: string): { state: DatabaseFileState; evidence: string[] } {
  if (dbPath === ':memory:' || dbPath === '') return { state: 'ok', evidence: [] };
  let size: number | null = null;
  try { size = statSync(dbPath).size; } catch { size = null; }
  if (size !== null && size > 0) return { state: 'ok', evidence: [] };
  const evidence = installStateEvidence(dataDir, dbPath);
  if (evidence.length === 0) return { state: 'fresh', evidence };
  return { state: size === null ? 'missing' : 'empty', evidence };
}

/**
 * Refuse to carry on with an empty database when the install has state.
 * `allowNew` (the `--new-database` flag or JARVIS_ALLOW_NEW_DATABASE=1) is the
 * owner explicitly asking for a fresh one.
 */
export function assertDatabaseUsable(dbPath: string, dataDir: string, opts: { allowNew?: boolean } = {}): void {
  if (opts.allowNew || process.env[NEW_DATABASE_ENV] === '1') return;
  const { state } = inspectDatabaseFile(dbPath, dataDir);
  if (state !== 'missing' && state !== 'empty') return;
  throw new DatabaseProblemError(state,
    `Jarvis found your saved settings in ${dataDir}, but its database file is ${state === 'missing' ? 'missing' : 'empty'}. `
    + 'It will not start with a new empty database: that would hide your data and lock out your devices.\n'
    + `${RESTORE_HINT}\n`
    + `To start over on purpose, run: jarvis start ${NEW_DATABASE_FLAG}`);
}

const CORRUPT = /malformed|SQLITE_CORRUPT|not a database|SQLITE_NOTADB/i;
const READONLY = /readonly database|SQLITE_READONLY/i;

/** A plain error for a database that would not open, or null when it is some other failure. */
export function describeOpenFailure(message: string, dbPath: string): DatabaseProblemError | null {
  if (CORRUPT.test(message)) {
    return new DatabaseProblemError('damaged',
      `Jarvis's database file is damaged (${dbPath}), so Jarvis did not start. It has not changed the file.\n`
      + `${RESTORE_HINT}\n`
      + 'To check the file, run: jarvis doctor');
  }
  if (READONLY.test(message)) {
    return new DatabaseProblemError('unwritable',
      `Jarvis cannot write to its database file (${dbPath}). Check that the file and its folder can be written by the user running Jarvis.`);
  }
  return null;
}

/** Plain message for the problem found by watching a running database file. */
export const DATABASE_LOST_MESSAGE = {
  missing: 'Jarvis\'s database file was deleted while it was running. Nothing new can be saved. Stop Jarvis, run "jarvis restore <your-backup-file>", and start it again.',
  replaced: 'Jarvis\'s database file was replaced while it was running. Nothing new can be saved until Jarvis is restarted.',
  emptied: 'Jarvis\'s database file was emptied while it was running. Nothing new can be saved. Stop Jarvis, run "jarvis restore <your-backup-file>", and start it again.',
} as const;

interface Identity { dev: number; ino: number; size: number }

/** Remembers which file Jarvis opened; `check` says whether it is still that file. */
export class DatabaseFileWatch {
  private identity: Identity | null = null;
  constructor(private readonly dbPath: string) { this.baseline(); }

  baseline(): void {
    try {
      const s = statSync(this.dbPath);
      this.identity = { dev: s.dev, ino: s.ino, size: s.size };
    } catch { this.identity = null; }
  }

  /** The problem now, or null when the file is as it was. */
  check(): keyof typeof DATABASE_LOST_MESSAGE | null {
    if (!this.identity) return null;
    let s: { dev: number; ino: number; size: number };
    try { s = statSync(this.dbPath); } catch { return 'missing'; }
    if (s.ino !== 0 && this.identity.ino !== 0 && (s.ino !== this.identity.ino || s.dev !== this.identity.dev)) return 'replaced';
    if (s.size === 0 && this.identity.size > 0) return 'emptied';
    return null;
  }
}

/** The database file Jarvis has open is gone or swapped: sticky, only a restart clears it. */
let lost: string | null = null;

/** The plain message when the database file was lost while running, else null. */
export function databaseLostMessage(): string | null {
  return lost;
}

/** Stop accepting writes. Logged once. */
export function markDatabaseLost(message: string): void {
  if (lost) return;
  console.error(`[Database] ${message}`);
  lost = message;
}

/** Test hook. */
export function resetDatabaseLost(): void {
  lost = null;
}

let watch: DatabaseFileWatch | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Check the watched file now; on a problem, stop writes (sticky until restart). */
export function checkDatabaseFile(): void {
  const problem = watch?.check();
  if (problem) markDatabaseLost(DATABASE_LOST_MESSAGE[problem]);
}

/** Start watching the database file the daemon just opened. */
export function watchDatabaseFile(dbPath: string, intervalMs = 5_000): void {
  stopWatchingDatabaseFile();
  if (dbPath === ':memory:' || dbPath === '') return;
  watch = new DatabaseFileWatch(dbPath);
  timer = setInterval(checkDatabaseFile, intervalMs);
  (timer as { unref?: () => void }).unref?.();
}

export function stopWatchingDatabaseFile(): void {
  if (timer) clearInterval(timer);
  timer = null;
  watch = null;
}
