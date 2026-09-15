import { deleteSetting, getSetting, setSetting } from './settings.ts';
import { createEntity, updateEntity } from './entities.ts';
import { createFact, findFacts, type Fact } from './facts.ts';
import { reconcileFacts } from './fact-schema.ts';
import { getDb } from './schema.ts';
import {
  USER_PROFILE_QUESTIONS,
  USER_PROFILE_SETTING_KEY,
  createEmptyUserProfile,
  countAnsweredUserProfileQuestions,
  normalizeUserProfileAnswers,
  profileQuestionForPredicate,
  type UserProfileFact,
  type UserProfileRecord,
} from '../user/profile.ts';

export const USER_PROFILE_VAULT_SOURCE = 'user_profile';
const USER_PROFILE_FOLLOWUP_STATE_KEY = 'user.profile.followup.v1';

export function getUserProfile(): UserProfileRecord | null {
  const raw = getSetting(USER_PROFILE_SETTING_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<UserProfileRecord>;
    const base = createEmptyUserProfile();
    return {
      version: 1,
      answers: normalizeUserProfileAnswers((parsed.answers ?? {}) as Record<string, unknown>),
      interview_facts: Array.isArray(parsed.interview_facts)
        ? (parsed.interview_facts as UserProfileFact[])
        : undefined,
      created_at: typeof parsed.created_at === 'number' ? parsed.created_at : base.created_at,
      updated_at: typeof parsed.updated_at === 'number' ? parsed.updated_at : base.updated_at,
      completed_at: typeof parsed.completed_at === 'number' ? parsed.completed_at : null,
    };
  } catch {
    return null;
  }
}

export function saveUserProfile(input: Record<string, unknown>): UserProfileRecord {
  return getDb().transaction(() => saveUserProfileRecord(input)).immediate();
}

function saveUserProfileRecord(input: Record<string, unknown>): UserProfileRecord {
  const existing = getUserProfile();
  const now = Date.now();
  const answers = normalizeUserProfileAnswers(input);
  const profile: UserProfileRecord = {
    version: 1,
    answers,
    // Preserve interview facts on wizard saves — the two surfaces are
    // independent capture paths feeding the same record.
    interview_facts: existing?.interview_facts,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    completed_at: countAnsweredUserProfileQuestions({
      version: 1,
      answers,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      completed_at: null,
    }) > 0 ? now : null,
  };

  setSetting(USER_PROFILE_SETTING_KEY, JSON.stringify(profile));
  syncUserProfileKnowledge(profile);
  return profile;
}

/** Called inside the fact correction transaction, so settings and projections commit together. */
export function syncUserProfileFactCorrection(fact: Fact, object: string): void {
  const question = profileQuestionForPredicate(fact.predicate_key);
  if (!question || fact.scope || fact.valid_from !== null || fact.valid_to !== null) return;
  // A separately entered legal name is not necessarily the preferred-name projection.
  if (fact.predicate_key === 'name' && !hasProfileEvidence(fact)) return;
  const currentUser = getDb().query<{ id: string }, [string]>(
    'SELECT id FROM entities WHERE source = ? ORDER BY updated_at DESC LIMIT 1'
  ).get(USER_PROFILE_VAULT_SOURCE);
  const profile = getUserProfile();
  if (!profile || currentUser?.id !== fact.subject_id) return;
  saveUserProfile({ ...profile.answers, [question]: object });
}

function hasProfileEvidence(fact: Fact): boolean {
  return fact.source === USER_PROFILE_VAULT_SOURCE || fact.evidence.some(e => e.source === USER_PROFILE_VAULT_SOURCE);
}

/**
 * Append a single structured fact captured by the Phase B onboarding
 * interviewer. Idempotent on (theme, summary) — re-recording the same
 * (theme, summary) pair updates the existing entry's `recorded_at`
 * rather than duplicating it. Used by the `record_profile_facts` tool
 * the interviewer agent calls during the conversation.
 */
export function appendUserProfileFact(fact: Omit<UserProfileFact, 'recorded_at'>): UserProfileRecord {
  const existing = getUserProfile() ?? createEmptyUserProfile();
  const now = Date.now();
  const facts = [...(existing.interview_facts ?? [])];

  const dupeIdx = facts.findIndex(
    (f) =>
      f.theme.toLowerCase() === fact.theme.toLowerCase() &&
      f.summary.toLowerCase() === fact.summary.toLowerCase(),
  );
  if (dupeIdx >= 0) {
    facts[dupeIdx] = { ...facts[dupeIdx]!, recorded_at: now };
  } else {
    facts.push({ ...fact, recorded_at: now });
  }

  const profile: UserProfileRecord = {
    ...existing,
    interview_facts: facts,
    updated_at: now,
    completed_at: existing.completed_at ?? now,
  };
  setSetting(USER_PROFILE_SETTING_KEY, JSON.stringify(profile));
  // Don't re-sync to vault entities — interview facts are summary-level,
  // not per-question; the wizard sync covers the structured side.
  return profile;
}

/**
 * Mark the Phase B interview as complete (or as skipped). Idempotent —
 * calling twice doesn't bump `completed_at`. Used by both the
 * `wrap_interview` tool and the user-side "Skip" button.
 */
export function markInterviewWrapped(): UserProfileRecord {
  const existing = getUserProfile() ?? createEmptyUserProfile();
  const now = Date.now();
  const profile: UserProfileRecord = {
    ...existing,
    completed_at: existing.completed_at ?? now,
    updated_at: now,
  };
  setSetting(USER_PROFILE_SETTING_KEY, JSON.stringify(profile));
  return profile;
}

export function clearUserProfile(): void {
  deleteSetting(USER_PROFILE_SETTING_KEY);
  clearUserProfileKnowledge();
  deleteSetting(USER_PROFILE_FOLLOWUP_STATE_KEY);
}

function syncUserProfileKnowledge(profile: UserProfileRecord): void {
  if (countAnsweredUserProfileQuestions(profile) === 0) {
    clearUserProfileKnowledge();
    return;
  }

  const db = getDb();
  const entityName = profile.answers.preferred_name?.trim() || 'User';
  const entityProperties = {
    is_current_user: true,
    profile_version: profile.version,
    profile_updated_at: profile.updated_at,
  };

  const entityRow = db.prepare(
    'SELECT id FROM entities WHERE source = ? ORDER BY updated_at DESC LIMIT 1'
  ).get(USER_PROFILE_VAULT_SOURCE) as { id: string } | null;

  const entity = entityRow
    ? updateEntity(entityRow.id, { name: entityName, properties: entityProperties })
    : createEntity('person', entityName, entityProperties, USER_PROFILE_VAULT_SOURCE);

  if (!entity) {
    throw new Error('Failed to sync user profile entity to vault');
  }

  db.transaction(() => {
    const previous = findFacts({ subject_id: entity.id }).filter(f => hasProfileEvidence(f)
      && !f.scope && f.valid_from === null && f.valid_to === null
      && (profileQuestionForPredicate(f.predicate_key) || f.verified_at === null));
    const desired = USER_PROFILE_QUESTIONS.flatMap<ProfileKnowledgeFact>(question => {
      const answer = profile.answers[question.id]?.trim();
      return answer ? [{ predicate: question.id, object: answer, confirmed: true,
        sourceRef: `profile:answer:${question.id}`, quote: answer }] : [];
    }).concat(getDerivedUserProfileFacts(profile));
    const saved = desired.map(fact => createFact(entity.id, fact.predicate, fact.object, {
      confidence: fact.confirmed ? 1 : 0.5, confirmed: fact.confirmed, source: USER_PROFILE_VAULT_SOURCE,
      basis: fact.confirmed ? undefined : 'inferred', sourceRef: fact.sourceRef, quote: fact.quote,
    }));
    for (const old of previous) if (!saved.some(f => f.id === old.id)) {
      const next = saved.find(f => f.predicate_key === old.predicate_key);
      db.run("UPDATE facts SET status = 'superseded', superseded_by = ? WHERE id = ?", [next?.id ?? null, old.id]);
      reconcileFacts(db, old.subject_id, old.predicate_key, old.scope);
    }
  }).immediate();
}

function clearUserProfileKnowledge(): void {
  const db = getDb();
  const rows = db.prepare('SELECT id FROM entities WHERE source = ?').all(USER_PROFILE_VAULT_SOURCE) as Array<{ id: string }>;
  db.prepare('DELETE FROM facts WHERE source = ?').run(USER_PROFILE_VAULT_SOURCE);
  for (const row of rows) {
    db.prepare('DELETE FROM entities WHERE id = ?').run(row.id);
  }
}

type ProfileKnowledgeFact = { predicate: string; object: string; confirmed: boolean; sourceRef: string; quote: string };

function getDerivedUserProfileFacts(profile: UserProfileRecord): ProfileKnowledgeFact[] {
  const facts: ProfileKnowledgeFact[] = [];

  const preferredName = profile.answers.preferred_name?.trim();
  if (preferredName) {
    facts.push({ predicate: 'name', object: preferredName, confirmed: true,
      sourceRef: 'profile:answer:preferred_name', quote: preferredName });
  }

  const aliasQuestions = ['important_people', 'anything_else', 'work_role', 'communication_preferences'] as const;

  for (const question of aliasQuestions) {
    const answer = profile.answers[question]?.trim();
    if (!answer) continue;
    for (const alias of extractAliases(answer)) {
      for (const predicate of ['alias', 'username']) facts.push({ predicate, object: alias,
        confirmed: false, sourceRef: `profile:derived:${question}`, quote: answer });
    }
  }

  return facts;
}

function extractAliases(text: string): string[] {
  const aliases = new Set<string>();
  const patterns = [
    /\b(?:alias|username|user\s*name|handle)\s*(?:is|=|:)?\s*["']?([A-Za-z0-9._-]{2,32})["']?/gi,
    /\bgo by\s+["']?([A-Za-z0-9._-]{2,32})["']?/gi,
    /\bcalled\s+["']?([A-Za-z0-9._-]{2,32})["']?/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const alias = match[1]?.trim().replace(/[.,!?;:]+$/g, '');
      if (alias) aliases.add(alias);
    }
  }

  return [...aliases];
}
