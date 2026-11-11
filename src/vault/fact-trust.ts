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

export function isOwnerEnteredFact(fact: Pick<FactRow, 'source'>): boolean {
  return fact.source !== null && fact.source !== undefined && OWNER_FACT_SOURCES.has(fact.source);
}

/** The taint source name a turn carries once outside memory reached it. It
 *  reads in the approval reason: "outside content read this turn (memory)". */
export const MEMORY_TAINT_SOURCE = 'memory';
