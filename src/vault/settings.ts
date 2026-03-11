/**
 * Key-value settings store backed by SQLite.
 *
 * Used for persistent configuration that can be edited from the dashboard
 * (e.g., LLM provider/model preferences).
 */

import { getDb } from './schema.ts';

export function getSetting(key: string): string | null {
  const db = getDb();
  const row = db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value],
  );
}

export function deleteSetting(key: string): void {
  const db = getDb();
  db.run('DELETE FROM settings WHERE key = ?', [key]);
}

export function getSettingsByPrefix(prefix: string): Record<string, string> {
  const db = getDb();
  const rows = db.query('SELECT key, value FROM settings WHERE key LIKE ?').all(`${prefix}%`) as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}
