import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { JourneyPersistence, LegacyStatus, Scope } from './types.ts';

export function scopeId(scope: Scope): string {
  return createHash('sha256').update(JSON.stringify([scope.actorId, scope.projectId])).digest('hex');
}

export function journeySettingsKey(scope: Scope): string {
  // Separate from cfg.onboarding: an older saveUserSection cannot erase it.
  // No new table, profile store, config section or migration.
  return `onboarding-next.journey.v1.${scopeId(scope)}`;
}

/** Adapter to the existing vault settings table. Opening/initializing the vault
 * and resolving its authorized owner remain the runtime host's responsibility.
 * Construction does not read, write, register or start anything. */
export function createSettingsJourneyPersistence(deps: {
  databaseForScope(scope: Scope): Database;
  readLegacy(scope: Scope): LegacyStatus;
}): JourneyPersistence {
  return {
    transaction(scope, operation) {
      const db = deps.databaseForScope(scope);
      const key = journeySettingsKey(scope);
      return db.transaction(() => {
        const row = db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null;
        // A malformed record throws. Treating it as absent would reenroll users.
        const current: unknown = row === null ? null : JSON.parse(row.value);
        if (row !== null && current === null) throw new Error('Invalid journey record');
        return operation({
          current,
          readLegacy: () => deps.readLegacy(scope),
          write(record) {
            db.run(
              `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
              [key, JSON.stringify(record)],
            );
          },
        });
      }).immediate();
    },
  };
}
