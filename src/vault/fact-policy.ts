/** Conservative predicate semantics. Unknown predicates remain multi-valued. */
const ALIASES: Record<string, string> = {
  birthday_is: 'birthday', date_of_birth: 'birthday', name_is: 'name',
  location_is: 'location', email_is: 'email', prefers_editor: 'preferred_editor',
};
const SINGLE = new Set(['birthday', 'name', 'preferred_name', 'preferred_editor',
  'preferred_language', 'preferred_contact_method', 'current_preference',
  'current_location', 'primary_email', 'timezone']);
const CASE_INSENSITIVE_VALUES = new Set(['birthday', 'name', 'preferred_name', 'preferred_editor',
  'preferred_language', 'preferred_contact_method', 'current_location', 'location', 'alias']);

export function predicateKey(predicate: string): string {
  const key = predicate.trim().toLowerCase().replace(/\s+/g, '_');
  // Unknown predicates must not resolve to inherited properties such as constructor.
  return Object.hasOwn(ALIASES, key) ? ALIASES[key]! : key;
}
export function valueKey(predicate: string, value: string): string {
  const trimmed = value.trim();
  return CASE_INSENSITIVE_VALUES.has(predicateKey(predicate)) ? trimmed.toLowerCase() : trimmed;
}
export function isSingleValued(predicate: string): boolean { return SINGLE.has(predicateKey(predicate)); }

export type FactState = 'active' | 'contested' | 'superseded';
export type FactBasis = 'inferred' | 'reported' | 'confirmed' | 'observed' | 'unspecified';
export interface FactRow {
  id: string; subject_id: string; predicate: string; object: string;
  confidence: number; source: string | null; created_at: number; verified_at: number | null;
  predicate_key: string; value_key: string; scope: string;
  valid_from: number | null; valid_to: number | null;
  status: FactState; superseded_by: string | null;
}
export function samePeriod(a: FactRow, b: FactRow): boolean {
  return a.valid_from === b.valid_from && a.valid_to === b.valid_to;
}
export function overlaps(a: FactRow, b: FactRow): boolean {
  return (a.valid_from ?? -Infinity) < (b.valid_to ?? Infinity)
    && (b.valid_from ?? -Infinity) < (a.valid_to ?? Infinity);
}
export function appliesAt(fact: FactRow, at = Date.now()): boolean {
  return (fact.valid_from === null || fact.valid_from <= at) && (fact.valid_to === null || at < fact.valid_to);
}
export function currentState(fact: FactRow, peers: FactRow[]): FactState {
  if (fact.status === 'superseded') return 'superseded';
  if (!isSingleValued(fact.predicate)) return 'active';
  const conflict = peers.some(other => other.id !== fact.id && other.status !== 'superseded'
    && other.scope === fact.scope && other.predicate_key === fact.predicate_key
    && other.value_key !== fact.value_key && overlaps(fact, other)
    && (fact.verified_at === null || other.verified_at !== null));
  return conflict ? 'contested' : 'active';
}
