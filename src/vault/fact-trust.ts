import type { FactRow } from './fact-policy.ts';

/**
 * Who wrote a fact. Only text the owner typed or decided on themselves is
 * trusted: a dashboard or typed entry, a correction or confirmation they
 * made, and their own profile answers. Everything else (model extraction,
 * imports, workflows, agents, connectors, files, goal summaries, a missing or
 * unknown label) is outside content that an attacker may have shaped, so
 * recall frames it as data and the turn it reaches is tainted.
 *
 * An allowlist, not a denylist: a new source label is outside by default.
 */
export const OWNER_FACT_SOURCES: ReadonlySet<string> = new Set([
  'dashboard', 'user', 'user_correction', 'user_confirmation', 'user_profile',
]);

export function isOwnerSource(source: string | null | undefined): boolean {
  return typeof source === 'string' && OWNER_FACT_SOURCES.has(source);
}

/**
 * The fact is the owner's: an owner source label, a confirmation (only an
 * owner decision sets `verified_at`), or the same value also entered by the
 * owner (an owner-sourced evidence row on it). The same line the Memory room
 * draws between "purely extracted, unverified" facts and a fact a person
 * entered or confirmed, widened so every non-owner source counts as outside.
 */
export function isOwnerEnteredFact(fact: Pick<FactRow, 'source'> & { verified_at?: number | null;
  evidence?: ReadonlyArray<{ source: string | null }> }): boolean {
  if (isOwnerSource(fact.source)) return true;
  if (fact.verified_at !== null && fact.verified_at !== undefined) return true;
  return !!fact.evidence?.some(e => isOwnerSource(e.source));
}

/** An entity the owner created (its name is their words). Extracted and other entities are outside. */
export function isOwnerEnteredEntity(entity: { source?: string | null }): boolean {
  return isOwnerSource(entity.source);
}

/** The taint source name a turn carries once outside memory reached it. It
 *  reads in the approval reason: "outside content read this turn (memory)". */
export const MEMORY_TAINT_SOURCE = 'memory';
