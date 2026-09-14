import { createHash } from 'node:crypto';
import { getDb, generateId } from './schema.ts';
import { findEntities } from './entities.ts';
import { reconcileFacts } from './fact-schema.ts';
import { syncUserProfileFactCorrection } from './user-profile.ts';
import { appliesAt, isSingleValued, predicateKey, valueKey, samePeriod, type FactRow, type FactBasis } from './fact-policy.ts';

export interface FactEvidence {
  id: string; fact_id: string; source: string | null; source_ref: string | null;
  quote: string | null; basis: FactBasis; confidence: number; recorded_at: number;
}
export type Fact = FactRow & { evidence: FactEvidence[]; basis: FactBasis; binding_eligible: boolean };
export type FactOptions = {
  confidence?: number; source?: string; sourceRef?: string; quote?: string;
  basis?: Exclude<FactBasis, 'confirmed'>; confirmed?: boolean;
  scope?: string; validFrom?: number | null; validTo?: number | null;
};
export class FactInputError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function factText(value: unknown, name: string, limit = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new FactInputError(`${name} must be nonempty text up to ${limit} characters`);
  return value.trim();
}
function validate(options: FactOptions): void {
  if (options.confidence !== undefined && (!Number.isFinite(options.confidence) || options.confidence < 0 || options.confidence > 1)) throw new FactInputError('confidence must be between 0 and 1');
  for (const key of ['validFrom', 'validTo'] as const) {
    const value = options[key];
    if (value != null && (!Number.isSafeInteger(value) || Math.abs(value) > 8.64e15)) throw new FactInputError(`${key} must be a timestamp in milliseconds`);
  }
  if (options.validFrom != null && options.validTo != null && options.validTo <= options.validFrom) throw new FactInputError('validTo must be later than validFrom');
  if (options.scope !== undefined && (typeof options.scope !== 'string' || options.scope.length > 200)) throw new FactInputError('scope must be text up to 200 characters');
  for (const key of ['source', 'sourceRef', 'quote'] as const) if (options[key] !== undefined) factText(options[key], key);
  if (options.basis !== undefined && !['inferred', 'reported', 'observed', 'unspecified'].includes(options.basis)) throw new FactInputError('Invalid evidence basis');
}
function addEvidence(id: string, options: FactOptions, now: number): void {
  const basis = options.confirmed ? 'confirmed' : options.basis ?? (options.source === 'llm_extraction' ? 'inferred' : 'unspecified');
  const fields = [options.source ?? null, options.sourceRef ?? null, options.quote ?? null, basis, options.confidence ?? 1];
  const key = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  getDb().run(`INSERT OR IGNORE INTO fact_evidence
    (id, fact_id, source, source_ref, quote, basis, confidence, recorded_at, evidence_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [generateId(), id, ...fields, now, key]);
}
function decorate(row: FactRow): Fact {
  const evidence = getDb().query<FactEvidence, [string]>('SELECT * FROM fact_evidence WHERE fact_id = ? ORDER BY recorded_at DESC, id').all(row.id);
  const basis: FactBasis = row.verified_at !== null ? 'confirmed' : evidence.some(e => e.basis === 'reported') ? 'reported'
    : row.source === 'llm_extraction' ? 'inferred' : evidence[0]?.basis ?? 'unspecified';
  const otherValues = !isSingleValued(row.predicate) && getDb().query<FactRow, [string, string, string, string]>(
    "SELECT * FROM facts WHERE subject_id = ? AND predicate_key = ? AND scope = ? AND value_key != ? AND status != 'superseded'"
  ).all(row.subject_id, row.predicate_key, row.scope, row.value_key).some(peer => appliesAt(peer));
  return { ...row, evidence, basis, binding_eligible: row.verified_at !== null && row.status === 'active' && appliesAt(row) && !otherValues };
}
function resolveConfirmed(row: FactRow): void {
  if (!isSingleValued(row.predicate)) return;
  const peers = getDb().query<FactRow, [string, string, string]>(
    "SELECT * FROM facts WHERE subject_id = ? AND predicate_key = ? AND scope = ? AND status != 'superseded'"
  ).all(row.subject_id, row.predicate_key, row.scope);
  for (const peer of peers) if (peer.id !== row.id && samePeriod(row, peer)) getDb().run(
    "UPDATE facts SET status = 'superseded', superseded_by = ? WHERE id = ?", [row.id, peer.id]);
}

/** Equivalent assertions share an ID. Model confidence never establishes verification. */
export function createFact(subject_id: string, predicate: string, object: string, options: FactOptions = {}): Fact {
  subject_id = factText(subject_id, 'subject_id', 200);
  predicate = factText(predicate, 'predicate', 200); object = factText(object, 'object'); validate(options);
  return getDb().transaction(() => {
    const key = predicateKey(predicate), value = valueKey(predicate, object), scope = options.scope?.trim() ?? '';
    const from = options.validFrom ?? null, to = options.validTo ?? null, now = Date.now();
    const existing = getDb().query<FactRow, [string, string, string, string, number | null, number | null]>(`SELECT * FROM facts
      WHERE subject_id = ? AND predicate_key = ? AND scope = ? AND value_key = ?
        AND valid_from IS ? AND valid_to IS ? AND status != 'superseded' ORDER BY created_at, id LIMIT 1`
    ).get(subject_id, key, scope, value, from, to);
    const id = existing?.id ?? generateId();
    if (!existing) {
      getDb().run(`INSERT INTO facts (id, subject_id, predicate, predicate_key, object, value_key, scope,
        confidence, source, created_at, verified_at, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, subject_id, predicate, key, object, value, scope, options.confidence ?? 1, options.source ?? null,
        now, options.confirmed ? now : null, from, to]);
    } else if (options.confirmed) {
      getDb().run('UPDATE facts SET verified_at = ?, confidence = ?, source = ? WHERE id = ?', [now, options.confidence ?? 1, options.source ?? null, id]);
    }
    addEvidence(id, options, now);
    const row = getDb().query<FactRow, [string]>('SELECT * FROM facts WHERE id = ?').get(id)!;
    if (options.confirmed) resolveConfirmed(row);
    reconcileFacts(getDb(), subject_id, key, scope);
    return getFact(id)!;
  }).immediate();
}
export function getFact(id: string): Fact | null {
  const row = getDb().query<FactRow, [string]>('SELECT * FROM facts WHERE id = ?').get(id);
  return row ? decorate(row) : null;
}
export function findFacts(query: { subject_id?: string; predicate?: string; object?: string; includeSuperseded?: boolean; scope?: string }): Fact[] {
  const conditions: string[] = [], params: string[] = [];
  if (!query.includeSuperseded) conditions.push("status != 'superseded'");
  if (query.subject_id) { conditions.push('subject_id = ?'); params.push(query.subject_id); }
  if (query.predicate) { conditions.push('predicate_key = ?'); params.push(predicateKey(query.predicate)); }
  if (query.object) { conditions.push('object = ?'); params.push(query.object); }
  if (query.scope !== undefined) { conditions.push('scope = ?'); params.push(query.scope.trim()); }
  const rows = getDb().query<FactRow, string[]>(`SELECT * FROM facts ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY (verified_at IS NOT NULL) DESC, created_at DESC, id`).all(...params);
  return rows.map(decorate);
}

/** Fail closed when a single-value consumer encounters unconfirmed or ambiguous memory. */
export function queryFact(subjectName: string, predicate: string, scope = ''): Fact | null {
  const entities = findEntities({ name: subjectName }); if (entities.length !== 1) return null;
  const facts = findFacts({ subject_id: entities[0]!.id, predicate, scope }).filter(f => appliesAt(f));
  const confirmed = facts.filter(f => f.binding_eligible);
  if (confirmed.length !== 1) return null;
  if (!isSingleValued(predicate) && facts.some(f => f.value_key !== confirmed[0]!.value_key)) return null;
  return confirmed[0]!;
}
export function correctFact(id: string, object: string, reason: string): Fact {
  object = factText(object, 'object'); reason = factText(reason, 'reason', 1000);
  return getDb().transaction(() => {
    const old = getFact(id); if (!old) throw new FactInputError('Fact not found', 404);
    if (old.status === 'superseded') {
      const replacement = old.superseded_by ? getFact(old.superseded_by) : null;
      if (replacement && replacement.status !== 'superseded' && replacement.value_key === valueKey(old.predicate, object)) return replacement;
      throw new FactInputError('Fact was already superseded; review its current replacement', 409);
    }
    const replacement = createFact(old.subject_id, old.predicate, object, {
      confirmed: true, source: 'user_correction', sourceRef: `fact:${old.id}`, quote: reason,
      scope: old.scope, validFrom: old.valid_from, validTo: old.valid_to,
    });
    if (replacement.id !== old.id) getDb().run("UPDATE facts SET status = 'superseded', superseded_by = ? WHERE id = ?", [replacement.id, old.id]);
    reconcileFacts(getDb(), old.subject_id, old.predicate_key, old.scope);
    syncUserProfileFactCorrection(old, replacement.object);
    return getFact(replacement.id)!;
  }).immediate();
}
/** Legacy revisions retain history and cannot overwrite confirmed values. */
export function updateFact(id: string, updates: Partial<Pick<Fact, 'predicate' | 'object' | 'confidence' | 'source'>>): Fact | null {
  return getDb().transaction(() => {
    const old = getFact(id); if (!old) return null;
    if (old.verified_at !== null || old.status === 'superseded') throw new FactInputError('Use an explicit correction for a confirmed or superseded fact', 409);
    const next = createFact(old.subject_id, updates.predicate ?? old.predicate, updates.object ?? old.object, {
      confidence: updates.confidence ?? old.confidence, source: updates.source ?? old.source ?? undefined,
      sourceRef: `revision:${old.id}`, scope: old.scope, validFrom: old.valid_from, validTo: old.valid_to,
    });
    if (next.id !== old.id) getDb().run("UPDATE facts SET status = 'superseded', superseded_by = ? WHERE id = ?", [next.id, old.id]);
    reconcileFacts(getDb(), old.subject_id, old.predicate_key, old.scope);
    reconcileFacts(getDb(), next.subject_id, next.predicate_key, next.scope);
    return getFact(next.id);
  }).immediate();
}
export function deleteFact(id: string): boolean {
  return getDb().transaction(() => {
    const fact = getFact(id); if (!fact) return false;
    getDb().run('DELETE FROM facts WHERE id = ?', [id]);
    reconcileFacts(getDb(), fact.subject_id, fact.predicate_key, fact.scope); return true;
  }).immediate();
}
export function verifyFact(id: string, reason = 'Explicit fact confirmation'): Fact {
  return getDb().transaction(() => {
    const fact = getFact(id); if (!fact) throw new FactInputError('Fact not found', 404);
    if (fact.status === 'superseded') throw new FactInputError('Cannot confirm a superseded fact', 409);
    const confirmed = createFact(fact.subject_id, fact.predicate, fact.object, {
      confirmed: true, source: 'user_confirmation', sourceRef: `fact:${id}`, quote: factText(reason, 'reason', 1000),
      scope: fact.scope, validFrom: fact.valid_from, validTo: fact.valid_to,
    });
    syncUserProfileFactCorrection(fact, confirmed.object);
    return getFact(confirmed.id)!;
  }).immediate();
}
