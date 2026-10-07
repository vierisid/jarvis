import { createHmac } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { predicateKey, valueKey } from './fact-policy';

export class FactSuppressedError extends Error {
  constructor() { super('This automatic source revision was forgotten'); }
}
export const AUTOMATIC_FACT_SOURCES = new Set(['llm_extraction', 'goal_completion', 'user_profile']);
type Assertion = { subject_id: string; predicate: string; object: string; scope?: string; valid_from?: number | null; valid_to?: number | null };
type Source = { source?: string | null; source_ref?: string | null; quote?: string | null; replay?: { sourceRef: string; explicitInputAt: number } };
const hash = (db: Database, value: unknown) => {
  const row = db.query<{ hash_key: Uint8Array }, []>('SELECT hash_key FROM memory_forget_state WHERE singleton = 1').get();
  if (!row || row.hash_key.length !== 32) throw new Error('Memory suppression unavailable');
  return createHmac('sha256', row.hash_key).update(JSON.stringify(value)).digest('hex');
};
export function assertionKey(db: Database, fact: Assertion): string {
  return hash(db, ['assertion-v1', fact.subject_id, predicateKey(fact.predicate), valueKey(fact.predicate, fact.object),
    fact.scope?.trim() ?? '', fact.valid_from ?? null, fact.valid_to ?? null]);
}
export function automaticSourceKey(db: Database, source: Source): string | null {
  if (!source.source || !AUTOMATIC_FACT_SOURCES.has(source.source)) return null;
  // Conversation refs identify a turn/input pair. Profile refs include a durable
  // edit identity; retaining the answer component preserves legacy suppression.
  // Legacy goal assertions include the completion-episode entity ID.
  if (source.source_ref?.startsWith('legacy:') || (!source.source_ref && source.source !== 'goal_completion')) return legacySourceKey(db, source.source);
  return hash(db, ['source-v1', source.source, source.source_ref ?? null,
    source.source === 'user_profile' ? source.quote ?? null : null]);
}
function legacySourceKey(db: Database, source: string): string {
  return hash(db, ['legacy-source-v1', source]);
}
export function assertAutomaticFactAllowed(db: Database, fact: Assertion, source: Source): void {
  const key = automaticSourceKey(db, source);
  if (!key) return;
  const assertion = assertionKey(db, fact);
  if (db.query('SELECT 1 FROM memory_forget_suppressions WHERE assertion_key = ? AND source_key = ?')
    .get(assertion, key)) throw new FactSuppressedError();
  // A current, explicitly edited profile field is new input. Forget also records
  // its exact ref for migrated facts, so unchanged saves still hit the check above.
  // Check the persisted identity, not a caller-provided claim of a new revision.
  if (source.source === 'user_profile' && source.source_ref) {
    const edit = /^profile:(answer|derived):([^:]+):revision:(.+)$/.exec(source.source_ref);
    if (edit && db.query('SELECT 1 FROM memory_profile_revisions WHERE field = ? AND revision = ?').get(edit[2]!, edit[3]!)) return;
  }
  // Older sources did not identify the turn. Preserve their suppression on replay;
  // only a canonical user turn accepted AFTER Forget may supply that assertion anew.
  const legacyKeys = [legacySourceKey(db, source.source!)];
  if (source.replay) legacyKeys.push(automaticSourceKey(db, { source: source.source, source_ref: source.replay.sourceRef })!);
  for (const legacy of legacyKeys) {
    const old = db.query<{ forgotten_at: number }, [string, string]>(`SELECT r.forgotten_at FROM memory_forget_suppressions s
      JOIN memory_forget_receipts r ON r.fact_id = s.fact_id WHERE s.assertion_key = ? AND s.source_key = ?`).get(assertion, legacy);
    if (old && (!source.replay || !Number.isSafeInteger(source.replay.explicitInputAt)
      || source.replay.explicitInputAt <= old.forgotten_at)) throw new FactSuppressedError();
  }
}
export function profileSourceRef(db: Database, kind: string, field: string): string {
  const edit = db.query<{ revision: string }, [string]>('SELECT revision FROM memory_profile_revisions WHERE field = ?').get(field);
  return `profile:${kind}:${field}${edit ? `:revision:${edit.revision}` : ''}`;
}
export function profileSourceForgotten(db: Database, field: string, answer: string): boolean {
  return ['answer', 'derived'].some(kind => db.query('SELECT 1 FROM memory_forget_suppressions WHERE source_key = ? LIMIT 1')
    .get(automaticSourceKey(db, { source: 'user_profile', source_ref: profileSourceRef(db, kind, field), quote: answer })));
}
export function assertNoForgottenMemory(db: Database, ids: readonly string[]): void {
  for (const id of ids) if (db.query('SELECT 1 FROM memory_forget_receipts WHERE fact_id = ?').get(id)) {
    throw new Error('Memory was forgotten before provider handoff; refresh the context');
  }
}

export function assertNoForgottenProfileSources(db: Database, keys: Iterable<string>): void {
  for (const key of keys) if (db.query('SELECT 1 FROM memory_forget_suppressions WHERE source_key = ? LIMIT 1').get(key)) {
    throw new Error('Profile memory was forgotten before provider handoff; refresh the context');
  }
}
