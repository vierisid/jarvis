/**
 * LLM Tier system - foundation for the router-first architecture.
 *
 * Four tiers, each maps to a (provider, model) pair via the runtime tier map.
 * Call sites request work by tier + subsystem label; the manager resolves the
 * tier to a concrete provider, falling up if the tier is unconfigured.
 *
 * - `conversation`: thin shell that owns user-facing dialogue. When unset, the
 *   system runs in classic single-orchestrator mode (no router split).
 * - `high`: deep reasoning, planning, complex code.
 * - `medium`: tool execution, workflow orchestration, structured extraction.
 * - `low`: classification, summarization, formatting.
 *
 * Conversation tier never falls up - its presence/absence is a mode switch.
 * Task tiers (low/medium/high) all fall up to medium (and then high) so a
 * single-LLM config keeps working without any tier wiring at the call site.
 */

export type Tier = 'conversation' | 'high' | 'medium' | 'low';

export const TIERS: readonly Tier[] = ['conversation', 'high', 'medium', 'low'] as const;

export type TierAssignment = {
  /** Registered provider name (anthropic, openai, groq, etc.) */
  provider: string;
  /** Optional per-tier model override. Falls back to the provider's default model. */
  model?: string;
};

export type TierMap = Partial<Record<Tier, TierAssignment>>;

/**
 * When a requested tier is unassigned, walk this fallback chain in order.
 * Task tiers all eventually land on `medium` or `high`. Conversation never
 * falls up - if it's not configured, the system uses classic orchestrator mode.
 */
export const TIER_FALLBACK: Record<Tier, Tier[]> = {
  conversation: [],
  high: ['medium'],
  medium: ['high'],
  low: ['medium', 'high'],
};

export type TierResolution = {
  /** The tier that actually resolved (may differ from requested if fell up). */
  tier: Tier;
  assignment: TierAssignment;
};

export function resolveTier(requested: Tier, tiers: TierMap): TierResolution | null {
  const candidates: Tier[] = [requested, ...TIER_FALLBACK[requested]];
  for (const t of candidates) {
    const a = tiers[t];
    if (a) return { tier: t, assignment: a };
  }
  return null;
}

/**
 * Validates that at least one of `medium` or `high` is configured so that
 * `low` and unconfigured tiers always have somewhere to fall up to.
 * Returns null if valid, or an error message describing what's missing.
 */
export function validateTierMap(tiers: TierMap): string | null {
  if (!tiers.medium && !tiers.high) {
    return 'LLM config invalid: at least one of `medium` or `high` tier must be configured.';
  }
  return null;
}

/**
 * Parse a model reference string of the form "<provider-name>:<model-id>" into
 * a TierAssignment. The split is on the FIRST colon - model ids may contain
 * additional colons (rare but real, e.g. some OpenRouter slugs).
 *
 * Returns null when the input is empty or doesn't contain a colon - callers
 * should treat that as "no model configured" for the tier.
 */
export function parseModelRef(ref: string | undefined | null): TierAssignment | null {
  if (!ref || typeof ref !== 'string') return null;
  const idx = ref.indexOf(':');
  if (idx <= 0 || idx === ref.length - 1) return null;
  const provider = ref.slice(0, idx);
  const model = ref.slice(idx + 1);
  return { provider, model };
}

/** Inverse of parseModelRef. */
export function formatModelRef(assignment: TierAssignment): string {
  return assignment.model ? `${assignment.provider}:${assignment.model}` : assignment.provider;
}
