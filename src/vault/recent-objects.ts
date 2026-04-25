/**
 * Recent objects — backing table for the dashboard ⌘K palette's "Recent"
 * group. Survives reload / cross-device, unlike the localStorage cache the
 * UI keeps as an offline fallback.
 *
 * Behavior:
 *   - `record()` upserts on (object_type, object_id), bumping `picked_at`.
 *   - `list()` returns the N most-recent picks, newest first.
 *   - `trim()` drops anything past the size cap. Called inline from `record`
 *     so the table stays bounded without a separate maintenance job.
 */

import { getDb, generateId } from './schema.ts';

export type RecentObjectRow = {
  id: string;
  object_type: string;
  object_id: string;
  title: string;
  summary: string | null;
  meta: string | null;
  picked_at: number;
};

const DEFAULT_LIMIT = 5;
const MAX_ROWS = 50;

export function recordRecentObject(input: {
  object_type: string;
  object_id: string;
  title: string;
  summary?: string;
  meta?: string;
}): void {
  const db = getDb();
  const now = Date.now();

  const existing = db
    .prepare('SELECT id FROM recent_objects WHERE object_type = ? AND object_id = ?')
    .get(input.object_type, input.object_id) as { id: string } | undefined;

  if (existing) {
    db.run(
      `UPDATE recent_objects SET title = ?, summary = ?, meta = ?, picked_at = ? WHERE id = ?`,
      [input.title, input.summary ?? null, input.meta ?? null, now, existing.id],
    );
  } else {
    db.run(
      `INSERT INTO recent_objects (id, object_type, object_id, title, summary, meta, picked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId(),
        input.object_type,
        input.object_id,
        input.title,
        input.summary ?? null,
        input.meta ?? null,
        now,
      ],
    );
  }

  trimRecentObjects();
}

export function listRecentObjects(limit: number = DEFAULT_LIMIT): RecentObjectRow[] {
  const db = getDb();
  const safeLimit = Math.min(Math.max(1, limit), 50);
  return db
    .prepare(
      `SELECT id, object_type, object_id, title, summary, meta, picked_at
       FROM recent_objects ORDER BY picked_at DESC LIMIT ?`,
    )
    .all(safeLimit) as RecentObjectRow[];
}

export function clearRecentObjects(): void {
  const db = getDb();
  db.run('DELETE FROM recent_objects');
}

function trimRecentObjects(): void {
  const db = getDb();
  // Keep only the MAX_ROWS most-recent rows. Cheap because picked_at is indexed.
  db.run(
    `DELETE FROM recent_objects WHERE id NOT IN (
       SELECT id FROM recent_objects ORDER BY picked_at DESC LIMIT ?
     )`,
    [MAX_ROWS],
  );
}
