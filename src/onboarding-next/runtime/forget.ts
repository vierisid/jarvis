/** Forget for the user profile and onboarding-next's interview records:
 * transcripts, receipts and drafted plans. Goals already created from the
 * interview are kept: they are the user's own goals now, managed in Goals.
 * Runs whether or not onboarding-next is enabled: records written during local
 * integration must go too. */
import { getDb } from '../../vault/schema';
import { clearUserProfile } from '../../vault/user-profile';
import { INTERVIEW_KEY_PREFIX } from '../interview-session';
import { RECEIPT_KEY_PREFIX } from '../interview-profile';
import { INITIAL_PLAN_KEY_PREFIX } from './initial-goal';

/** Personal data: interview transcripts, profile-commit receipts and the model's
 * goal plans drafted from the interview. The journey record and the initial-goal
 * receipt (goal ids only) are progress, not personal data, and are kept. */
export const FORGOTTEN_ONBOARDING_PREFIXES = Object.freeze([INTERVIEW_KEY_PREFIX, RECEIPT_KEY_PREFIX, INITIAL_PLAN_KEY_PREFIX]);

/** One immediate transaction: an in-flight interview commit either lands before
 * Forget (and is deleted with it) or runs after and finds no session, so it is
 * fenced as stale and writes nothing back. */
export function forgetUserProfile(): void {
  const db = getDb();
  db.transaction(() => {
    clearUserProfile();
    for (const prefix of FORGOTTEN_ONBOARDING_PREFIXES) {
      db.run('DELETE FROM settings WHERE substr(key, 1, ?) = ?', [prefix.length, prefix]);
    }
  }).immediate();
}
