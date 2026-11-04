import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
    if (existing) return existing;
    mkdirSync(dataDir, { recursive: true });
    const id = create();
    // Write then rename, so a crash never leaves a partial id behind.
    const temp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${id}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
    return id;
  } catch (error) {
    console.warn(`[Daemon] Workspace id unavailable (${error instanceof Error ? error.message : String(error)}); dashboard edits will not survive a restart.`);
    return create();
  }
}

function readId(file: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const id = raw.trim();
  return VALID.test(id) ? id : null;
}
