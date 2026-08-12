import type { JarvisConfig } from '../config/types.ts';

/**
 * Hosted "Usejarvis AI" wiring (the platform's LLM proxy).
 *
 * The `usejarvis_ai` config.yaml block (base_url + the user's per-account
 * key) is SYSTEM-owned and file-authoritative: the provisioner writes it,
 * the brain never does, and the dashboard cannot touch it. But `config.llm`
 * is rebuilt WHOLESALE from the DB by mergeLLMSettingsIntoConfig on boot,
 * on SIGHUP reload, and around every dashboard save — so this hook re-applies
 * the hosted provider over every one of those merges. It must be called
 * after ANY code path that replaces `config.llm`.
 *
 * Semantics (fill-if-silent):
 * - The provider itself is ALWAYS injected (users cannot delete it).
 * - Tier assignments are defaults only: each unset tier slot is pointed at
 *   the matching uj-* alias, but any tier the user chose in the dashboard
 *   wins for that slot, and a user who configured single-model mode
 *   (llm.default) keeps it untouched.
 */

/** Reserved provider name: the map key, the kind, and the tier-ref prefix. */
export const USEJARVIS_PROVIDER_NAME = 'usejarvis_ai';

/** Default tier wiring: identical on every plan — per-plan model resolution
 * happens at the proxy via these aliases, never in this file. */
const TIER_DEFAULTS = {
  conversation: `${USEJARVIS_PROVIDER_NAME}:uj-chat`,
  low: `${USEJARVIS_PROVIDER_NAME}:uj-low`,
  medium: `${USEJARVIS_PROVIDER_NAME}:uj-medium`,
  high: `${USEJARVIS_PROVIDER_NAME}:uj-high`,
} as const;

/** True when this install is hosted (a complete usejarvis_ai block exists). */
export function hasUsejarvisAi(config: JarvisConfig): boolean {
  const block = config.usejarvis_ai;
  return Boolean(block?.base_url?.trim() && block?.api_key?.trim());
}

export function applyUsejarvisAi(config: JarvisConfig): void {
  if (!hasUsejarvisAi(config)) return;
  const block = config.usejarvis_ai!;

  config.llm.providers ??= {};
  // Unconditional: whatever the DB merge brought in, the hosted provider
  // exists afterwards. A DB row squatting on the reserved name is overwritten
  // (saveLLMSettings also refuses to persist one).
  config.llm.providers[USEJARVIS_PROVIDER_NAME] = {
    kind: USEJARVIS_PROVIDER_NAME,
    base_url: block.base_url!.trim(),
    api_key: block.api_key!.trim(),
  };

  // Defaults only where the user is silent: an explicit single-model choice
  // (llm.default) disables tier-filling entirely; otherwise each unset slot
  // gets its uj-* alias while user-chosen slots stay untouched.
  if (!config.llm.default) {
    const tiers = (config.llm.tiers ??= {});
    for (const [tier, ref] of Object.entries(TIER_DEFAULTS)) {
      (tiers as Record<string, string>)[tier] ||= ref;
    }
  }
}
