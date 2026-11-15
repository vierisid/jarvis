/**
 * The few things the notch remembers about how the person wants it: their
 * quiet hours, and the day the morning line was last said. One small table in
 * the brain's database, a name and a value each. It exists only on a brain
 * that has had the notch on.
 */
import type { Database } from 'bun:sqlite';

export class NotchSettings {
  constructor(private readonly db: Database) {
    db.run('CREATE TABLE IF NOT EXISTS notch_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  }

  /** What is kept under a name, or `otherwise` when nothing is, or what is there cannot be read. */
  get<T>(name: string, otherwise: T): T {
    const row = this.db.query('SELECT value FROM notch_settings WHERE name = ?').get(name) as { value: string } | null;
    if (!row) return otherwise;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return otherwise;
    }
  }

  set(name: string, value: unknown, now = Date.now()): void {
    this.db.run(
      'INSERT INTO notch_settings (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [name, JSON.stringify(value), now],
    );
  }
}
