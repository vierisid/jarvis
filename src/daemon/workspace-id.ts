import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** File under the data directory that holds this workspace's identity. */
export const WORKSPACE_ID_FILE = 'workspace-id';
const VALID = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Stable identity of the workspace a daemon serves. Created once per data
 * directory and reused across restarts, so the dashboard can tell a restart of
 * the same workspace (keep edit buffers) from a different one (retire them).
 * A different JARVIS_HOME or data directory has its own file and so its own id.
 *
 * Never fails startup: when the file cannot be read or written the id is
 * per-boot, which makes the dashboard treat every restart as a new workspace.
 */
export function loadWorkspaceId(dataDir: string, create: () => string = randomUUID): string {
  const file = path.join(dataDir, WORKSPACE_ID_FILE);
  try {
    const existing = readId(file);
    if (existing.id) return existing.id;
    mkdirSync(dataDir, { recursive: true });
    const id = create();
    // Write a temp file first, so a crash never leaves a partial id behind.
    const temp = `${file}.${process.pid}.${id}.tmp`;
    try {
      writeFileSync(temp, `${id}\n`, { mode: 0o600 });
      if (existing.present) renameSync(temp, file); // replace a corrupt id
      else {
        // link() fails if another process created the id first; use theirs.
        try { linkSync(temp, file); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const winner = readId(file).id;
          if (winner) return winner;
          renameSync(temp, file);
        }
      }
    } finally {
      rmSync(temp, { force: true });
    }
    return id;
  } catch (error) {
    console.warn(`[Daemon] Workspace id unavailable (${error instanceof Error ? error.message : String(error)}); dashboard edits will not survive a restart.`);
    return create();
  }
}

function readId(file: string): { present: boolean; id: string | null } {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { present: false, id: null };
    throw error;
  }
  const id = raw.trim();
  return { present: true, id: VALID.test(id) ? id : null };
}
