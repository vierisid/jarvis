import { createHash } from 'node:crypto';
import { USER_PROFILE_QUESTIONS, USER_PROFILE_SETTING_KEY, type UserProfileQuestionId } from '../user/profile';
import { getDb } from './schema';
import { getSetting } from './settings';
import { getUserProfile, saveUserProfile } from './user-profile';

export class ProfileEditError extends Error {
  constructor(readonly code: 'invalid_patch' | 'revision_conflict' | 'profile_unavailable', readonly status = 400) { super(code); }
}

/** Includes canonical legacy/interview writes and memory corrections; no second profile store. */
export function readEditableProfile() {
  const raw = getSetting(USER_PROFILE_SETTING_KEY);
  if (raw !== null) {
    try {
      if (raw.length > 256_000) throw new Error();
      const value = JSON.parse(raw);
      if (!value || value.version !== 1 || !value.answers || typeof value.answers !== 'object' || Array.isArray(value.answers)) throw new Error();
    } catch { throw new ProfileEditError('profile_unavailable', 503); }
  }
  const profile = getUserProfile();
  if (raw !== null && !profile) throw new ProfileEditError('profile_unavailable', 503);
  const fieldRevisions = getDb().query('SELECT field, revision FROM memory_profile_revisions ORDER BY field').all();
  const revision = createHash('sha256').update(JSON.stringify([raw, fieldRevisions])).digest('hex');
  return { revision, profile };
}

/** Patch only named answers. A stale editor cannot overwrite a correction or a legacy save. */
export function patchUserProfile(expectedRevision: unknown, input: unknown) {
  if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision) ||
    !input || typeof input !== 'object' || Array.isArray(input)) throw new ProfileEditError('invalid_patch');
  const patch = input as Record<string, unknown>;
  const keys = Object.keys(patch);
  if (!keys.length || keys.some(key => !USER_PROFILE_QUESTIONS.some(q => q.id === key) ||
    (patch[key] !== null && (typeof patch[key] !== 'string' || (patch[key] as string).length > 4000)))) throw new ProfileEditError('invalid_patch');
  return getDb().transaction(() => {
    const current = readEditableProfile();
    if (current.revision !== expectedRevision) throw new ProfileEditError('revision_conflict', 409);
    const answers = { ...current.profile?.answers };
    for (const key of keys as UserProfileQuestionId[]) {
      const value = patch[key];
      if (value === null || !(value as string).trim()) delete answers[key];
      else answers[key] = (value as string).trim();
    }
    // Unchanged retries must not rewrite knowledge or resurrect forgotten projections.
    if (JSON.stringify(answers) !== JSON.stringify(current.profile?.answers ?? {})) saveUserProfile(answers);
    return readEditableProfile();
  }).immediate();
}
