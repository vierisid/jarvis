import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { Scope, Store } from './types.ts';

export function scopeKey(scope: Scope): string {
  return createHash('sha256').update(JSON.stringify([scope.actorId, scope.projectId])).digest('hex');
}
export const settingsKey = (scope: Scope) => `onboarding-next.interview.v1.${scopeKey(scope)}`;

/** Uses the existing vault settings table and its explicit database owner.
 * No open, migration, read, registration or other effect on construction. */
export function createSettingsInterviewStore(databaseForScope: (scope: Scope) => Database): Store {
  return {
    transaction(scope, operation) {
      const db = databaseForScope(scope);
      return db.transaction(() => {
        const row = db.query('SELECT value FROM settings WHERE key = ?').get(settingsKey(scope)) as { value: string } | null;
        const current: unknown = row ? JSON.parse(row.value) : null;
        if (row && current === null) throw new Error('Invalid interview record');
        return operation({ current, write(record) {
          db.run(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          [settingsKey(scope), JSON.stringify(record)]);
        } });
      }).immediate();
    },
  };
}
