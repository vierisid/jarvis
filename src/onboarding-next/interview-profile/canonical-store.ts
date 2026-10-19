import { USER_PROFILE_SETTING_KEY } from '../../user/profile.ts';
import { getDb } from '../../vault/schema.ts';
import { appendUserProfileFact, getUserProfile, markInterviewWrapped } from '../../vault/user-profile.ts';
import { validScope, InterviewProfileError } from './provider.ts';
import type { CanonicalStoreOptions, Store } from './types.ts';

/** Adapt the existing singleton vault and writer, without opening a database or
 * creating a second profile store. B11 supplies the authenticated vault owner.
 * All writer calls use exactly the database holding the transaction/receipt. */
export function createCanonicalInterviewProfileStore(options: CanonicalStoreOptions): Store {
  const owner = { ...options.owner };
  return {
    transaction(scope, work) {
      if (!validScope(owner) || !validScope(scope) || scope.actorId !== owner.actorId || scope.projectId !== owner.projectId) {
        throw new InterviewProfileError('stale');
      }
      const db = options.database();
      if (db !== getDb()) throw new InterviewProfileError('storage_unavailable');
      return db.transaction(() => {
        const read = (key: string): unknown => {
          const row = db.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(key);
          if (!row) return null;
          const parsed: unknown = JSON.parse(row.value);
          if (parsed === null) throw new InterviewProfileError('storage_unavailable');
          return parsed;
        };
        return work({
          readProfile() {
            // Canonical legacy reads normalize corrupt records; mutations must
            // fail closed instead of silently replacing unreadable user data.
            const raw = read(USER_PROFILE_SETTING_KEY) as Record<string, unknown> | null;
            if (raw !== null && (!raw || Array.isArray(raw) || raw.version !== 1
              || !raw.answers || typeof raw.answers !== 'object' || Array.isArray(raw.answers)
              || Object.values(raw.answers).some(v => typeof v !== 'string')
              || !['created_at', 'updated_at'].every(k => typeof raw[k] === 'number' && Number.isFinite(raw[k]))
              || (raw.completed_at !== null && (typeof raw.completed_at !== 'number' || !Number.isFinite(raw.completed_at)))
              || (raw.interview_facts !== undefined && (!Array.isArray(raw.interview_facts)
                || raw.interview_facts.some(f => !f || typeof f.theme !== 'string' || typeof f.summary !== 'string'
                  || typeof f.recorded_at !== 'number' || !Number.isFinite(f.recorded_at)
                  || (f.raw_quote !== undefined && typeof f.raw_quote !== 'string')))))) {
              throw new InterviewProfileError('storage_unavailable');
            }
            return getUserProfile();
          },
          append: fact => { appendUserProfileFact(fact, { deferCompletion: true }); },
          wrap: () => { markInterviewWrapped(); },
          readReceipt: read,
          writeReceipt(key, receipt) {
            db.run(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [key, JSON.stringify(receipt)]);
          },
        });
      }).immediate();
    },
  };
}
