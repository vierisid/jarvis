/**
 * Whether Jarvis can save anything right now.
 *
 * A full disk does not stop Jarvis from reading: it stops every write. Without
 * a shared record of that, each caller either logged raw SQLite text, retried
 * four times a second, or answered "ok" for a change it could not keep. This
 * module is that record: failed writes mark storage as not writable, a probe
 * write (only while it is marked) marks it writable again, and the health
 * route, the run worker and the dashboard banner read it.
 */

import { getDb } from './schema.ts';

export const STORAGE_FULL_MESSAGE = 'Jarvis cannot save: the disk is full. Free some space and Jarvis will carry on.';
export const STORAGE_FAILED_MESSAGE = 'Jarvis cannot save right now. Check that the disk has space and that Jarvis may write to its data folder.';

export type StorageReason = 'disk_full' | 'write_failed';

export interface StorageStatus {
  writable: boolean;
  reason: StorageReason | null;
  /** Plain words for the owner; null while storage is writable. */
  message: string | null;
  /** Epoch ms of the first failure in the current streak. */
  since: number | null;
}

const FULL = /database or disk is full|SQLITE_FULL|no space left on device|ENOSPC|disk is full|disk quota exceeded|EDQUOT/i;
const WRITE_FAILED = /attempt to write a readonly database|SQLITE_READONLY|disk I\/O error|SQLITE_IOERR/i;

function textOf(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown; errno?: unknown };
    return [e.code, e.errno, e.message].filter((part) => part !== undefined && part !== null).join(' ');
  }
  return String(err);
}

/** True when the error is SQLite or the OS saying there is no room left. */
export function isStorageFullError(err: unknown): boolean {
  return FULL.test(textOf(err));
}

/** True when a write failed because the disk or file refused it. */
export function isStorageWriteError(err: unknown): boolean {
  const text = textOf(err);
  return FULL.test(text) || WRITE_FAILED.test(text);
}

let current: { reason: StorageReason; since: number } | null = null;

export function storageStatus(): StorageStatus {
  if (!current) return { writable: true, reason: null, message: null, since: null };
  return {
    writable: false,
    reason: current.reason,
    message: current.reason === 'disk_full' ? STORAGE_FULL_MESSAGE : STORAGE_FAILED_MESSAGE,
    since: current.since,
  };
}

/** Record a failed write. Other errors are not storage trouble and are ignored. */
export function noteStorageFailure(err: unknown): boolean {
  if (!isStorageWriteError(err)) return false;
  // A streak that began as a full disk keeps saying so until saving works.
  const reason: StorageReason = isStorageFullError(err) || current?.reason === 'disk_full' ? 'disk_full' : 'write_failed';
  if (!current) console.error(`[Storage] Cannot save (${reason === 'disk_full' ? 'disk full' : 'write refused'}). Writes pause until it works again.`);
  current = { reason, since: current?.since ?? Date.now() };
  return true;
}

export function noteStorageOk(): void {
  if (!current) return;
  console.log('[Storage] Saving works again.');
  current = null;
}

/**
 * Try one tiny write. Called only while storage is marked unwritable, so a
 * healthy install never pays for it. Returns whether the write worked.
 */
export function probeStorage(): boolean {
  try {
    getDb().run(
      `INSERT INTO settings (key, value, updated_at) VALUES ('storage.probe', ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [String(Date.now())],
    );
    noteStorageOk();
    return true;
  } catch (err) {
    noteStorageFailure(err);
    return false;
  }
}

/** Test hook: forget any recorded failure. */
export function resetStorageStatus(): void {
  current = null;
}

/** The plain answer for a request that failed because nothing can be saved. */
export function storageFailureBody(err: unknown): { error: string; code: 'storage_full' | 'storage_unwritable' } {
  return isStorageFullError(err)
    ? { error: STORAGE_FULL_MESSAGE, code: 'storage_full' }
    : { error: STORAGE_FAILED_MESSAGE, code: 'storage_unwritable' };
}

/**
 * Replace raw SQLite text in a 5xx JSON answer with the plain message, and
 * record the failure. Anything else passes through untouched.
 */
export async function plainStorageResponse(res: Response): Promise<Response> {
  if (res.status < 500) return res;
  if (!(res.headers.get('content-type') ?? '').includes('json')) return res;
  let text: string;
  try { text = await res.clone().text(); } catch { return res; }
  if (!isStorageWriteError(text)) return res;
  noteStorageFailure(text);
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('content-type');
  return Response.json(storageFailureBody(text), { status: res.status, headers });
}
