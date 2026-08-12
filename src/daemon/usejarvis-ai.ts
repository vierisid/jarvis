import type { JarvisConfig, LLMConfig } from '../config/types.ts';

/**
 * Hosted "Usejarvis AI" wiring (the platform's LLM proxy).
 *
 * The `usejarvis_ai` config.yaml block (base_url + the user's per-account
 * key) is SYSTEM-owned and file-authoritative: the provisioner writes it,
 * the brain never does, and the dashboard cannot touch it. But `config.llm`
 * is rebuilt WHOLESALE from the DB by mergeLLMSettingsIntoConfig on boot,
 * on SIGHUP reload, and around every dashboard save — so the provider is
 * re-injected over every one of those merges (BEFORE the orphan prune, so
 * persisted usejarvis_ai:* refs are never treated as dangling).
 *
 * Tier defaults are NEVER written into config.llm. They exist only in the
 * binding view returned by effectiveLlmForBinding, which the provider
 * registration paths consume. This keeps runtime defaults out of every
 * persistence path by construction: saveLLMSettings can only ever write
 * back what the DB or the request body contained.
 *
 * Per-slot resolution (decision D1): a tier slot resolves
 *   explicit user ref → llm.default → plan uj-* alias.
 * There is no all-or-nothing bail on llm.default; setting a default narrows
 * the fallback for unset slots, it does not disable the other slots' explicit
 * choices.
 */

/** Reserved provider name: the map key and the tier-ref prefix. */
export const USEJARVIS_PROVIDER_NAME = 'usejarvis_ai';

/**
 * The hosted provider's `kind`. Same literal as the name today, but a
 * DISTINCT constant: gates that ask "is this entry the hosted provider"
 * compare kinds against this, never kind-vs-name — the two coinciding is an
 * implementation detail, not a contract (see pr3 review #11).
 */
export const USEJARVIS_KIND = 'usejarvis_ai';

/** Default tier wiring: identical on every plan — per-plan model resolution
 * happens at the proxy via these aliases, never in this file. */
export const USEJARVIS_TIER_DEFAULTS = {
  conversation: `${USEJARVIS_PROVIDER_NAME}:uj-chat`,
  low: `${USEJARVIS_PROVIDER_NAME}:uj-low`,
  medium: `${USEJARVIS_PROVIDER_NAME}:uj-medium`,
  high: `${USEJARVIS_PROVIDER_NAME}:uj-high`,
} as const;

/** Trailing-slash-stripped, trimmed URL (mirrors llm-settings normalizeBaseUrl;
 * duplicated here because importing llm-settings would create a cycle). */
function normalizeBlockUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * Read and validate the SYSTEM block. A malformed block (non-string values —
 * e.g. an unquoted YAML scalar parsed as number/boolean) is reported once per
 * read and treated as absent rather than throwing from inside the boot merge.
 */
function readUsejarvisAiBlock(
  config: JarvisConfig,
): { base_url: string; api_key: string } | null {
  const block = config.usejarvis_ai;
  if (!block || typeof block !== 'object') return null;
  const { base_url, api_key } = block as Record<string, unknown>;
  if (
    (base_url !== undefined && typeof base_url !== 'string')
    || (api_key !== undefined && typeof api_key !== 'string')
  ) {
    console.warn(
      '[UsejarvisAI] Ignoring malformed usejarvis_ai config block: base_url and api_key must be strings (quote them in config.yaml).',
    );
    return null;
  }
  const url = typeof base_url === 'string' ? normalizeBlockUrl(base_url) : '';
  const key = typeof api_key === 'string' ? api_key.trim() : '';
  if (!url || !key) return null;
  return { base_url: url, api_key: key };
}

/** True when this install is hosted (a complete, well-formed usejarvis_ai block exists). */
export function hasUsejarvisAi(config: JarvisConfig): boolean {
  return readUsejarvisAiBlock(config) !== null;
}

/**
 * Inject the hosted provider entry. Providers only — tier defaults live in
 * effectiveLlmForBinding and never touch the config object.
 */
export function applyUsejarvisAi(config: JarvisConfig): void {
  const block = readUsejarvisAiBlock(config);
  if (!block) return;

  config.llm.providers ??= {};
  // Unconditional: whatever the DB merge brought in, the hosted provider
  // exists afterwards. A DB row squatting on the reserved name is overwritten
  // (saveLLMSettings also refuses to persist one).
  config.llm.providers[USEJARVIS_PROVIDER_NAME] = {
    kind: USEJARVIS_PROVIDER_NAME,
    base_url: block.base_url,
    api_key: block.api_key,
  };
}

/**
 * The LLM config the provider-binding paths (boot registration, hot reload)
 * must consume instead of config.llm. On self-hosted installs it IS
 * config.llm. On hosted installs it is a copy whose tier slots are resolved
 * per-slot: explicit user ref → llm.default → plan uj-* alias.
 *
 * Never mutates config and its result must never be persisted — the fill
 * exists only for the duration of a bind.
 */
export function effectiveLlmForBinding(config: JarvisConfig): LLMConfig {
  if (!hasUsejarvisAi(config)) return config.llm;

  const tiers: Record<string, string> = { ...(config.llm.tiers ?? {}) };
  for (const [tier, alias] of Object.entries(USEJARVIS_TIER_DEFAULTS)) {
    if (!tiers[tier]) {
      tiers[tier] = config.llm.default || alias;
    }
  }
  return { ...config.llm, tiers };
}
