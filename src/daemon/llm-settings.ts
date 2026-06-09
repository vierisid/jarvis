/**
 * LLM settings persistence + hot-reload + connection test.
 *
 * Canonical config shape (after the provider/model split):
 *   llm.providers           Record<name, { kind?, api_key?, base_url? }>
 *   llm.default             "name:model" (single-LLM mode)
 *   llm.tiers.{conversation,high,medium,low}  "name:model" (router-first)
 *
 * Non-secret settings (provider list, default, tiers) live in the SQLite
 * `settings` table as JSON. API keys live in the encrypted keychain keyed
 * by provider name (NOT by kind) so multiple instances of the same kind
 * each have their own key.
 *
 * The settings dashboard reads/writes through this module; api-routes
 * delegates to getLLMSettings / saveLLMSettings / testLLMProvider /
 * hotReloadLLMProviders.
 */

import type { JarvisConfig, LLMProviderEntry, LLMProviderKind } from '../config/types.ts';
import { getSetting, setSetting } from '../vault/settings.ts';
import { getSecret, setSecret, deleteSecret, hasSecret } from '../vault/keychain.ts';
import type { LLMManager } from '../llm/manager.ts';
import {
  instantiateProvider,
  atomicReloadProviders,
  configureLLMTiers,
} from '../llm/config-binding.ts';

// ── DB keys ──────────────────────────────────────────────────────────────
const SETTING_PROVIDERS = 'llm.providers';
const SETTING_DEFAULT = 'llm.default';
const SETTING_MODE = 'llm.mode';
const SETTING_TIER_CONVERSATION = 'llm.tiers.conversation';
const SETTING_TIER_HIGH = 'llm.tiers.high';
const SETTING_TIER_MEDIUM = 'llm.tiers.medium';
const SETTING_TIER_LOW = 'llm.tiers.low';

/** Keychain key for a provider's API key, by provider NAME (not kind). */
function keychainKey(providerName: string): string {
  return `llm.provider.${providerName}.api_key`;
}

// ── Types exposed to the dashboard ───────────────────────────────────────
export type LLMSettingsProviderView = {
  kind: LLMProviderKind;
  has_api_key: boolean;
  base_url?: string;
};

export type LLMMode = 'single' | 'multi-tier';

export type LLMSettingsResponse = {
  providers: Record<string, LLMSettingsProviderView>;
  default: string | null;
  /**
   * The user's persisted architecture choice. Stored explicitly rather than
   * inferred from tier presence, so the selection survives reloads even before
   * a tier model is picked and the user can flip back to single at any time.
   * Runtime routing still activates router-first only when tiers.conversation
   * is set (see configureLLMTiers) - this field never drives routing on its own.
   */
  mode: LLMMode;
  tiers: {
    conversation: string | null;
    high: string | null;
    medium: string | null;
    low: string | null;
  };
  /** Provider classes the system can instantiate. UI dropdowns use this. */
  available_kinds: LLMProviderKind[];
};

/** Body shape accepted by saveLLMSettings - all fields optional/partial. */
export type LLMSettingsRequest = {
  providers?: Record<string, {
    kind?: LLMProviderKind;
    api_key?: string;
    base_url?: string;
  } | null>;            // null deletes the provider
  default?: string | null;     // null clears
  mode?: LLMMode;              // persisted architecture choice
  tiers?: {
    conversation?: string | null;
    high?: string | null;
    medium?: string | null;
    low?: string | null;
  };
};

export const AVAILABLE_KINDS: LLMProviderKind[] = [
  'anthropic',
  'openai',
  'groq',
  'gemini',
  'ollama',
  'openrouter',
  'nvidia',
  'openai_compatible',
  'litellm',
];

// ── getLLMSettings ───────────────────────────────────────────────────────

export function getLLMSettings(config: JarvisConfig): LLMSettingsResponse {
  const providers: Record<string, LLMSettingsProviderView> = {};
  for (const [name, entry] of Object.entries(config.llm.providers ?? {})) {
    if (!entry) continue;
    const kind = (entry.kind ?? name) as LLMProviderKind;
    providers[name] = {
      kind,
      has_api_key: hasSecret(keychainKey(name)) || Boolean(entry.api_key),
      ...(entry.base_url ? { base_url: entry.base_url } : {}),
    };
  }

  const tiers = {
    conversation: config.llm.tiers?.conversation ?? null,
    high: config.llm.tiers?.high ?? null,
    medium: config.llm.tiers?.medium ?? null,
    low: config.llm.tiers?.low ?? null,
  };

  // Mode is read from its own setting. For installs that pre-date this field
  // (no stored value), fall back to inferring it from tier presence so the
  // upgrade is seamless.
  const storedMode = getSetting(SETTING_MODE);
  const anyTier = tiers.conversation || tiers.high || tiers.medium || tiers.low;
  const mode: LLMMode =
    storedMode === 'multi-tier' || storedMode === 'single'
      ? storedMode
      : anyTier
        ? 'multi-tier'
        : 'single';

  return {
    providers,
    default: config.llm.default ?? null,
    mode,
    tiers,
    available_kinds: AVAILABLE_KINDS,
  };
}

// ── saveLLMSettings ──────────────────────────────────────────────────────

/**
 * Apply a partial settings update. Persists non-secret state to the
 * settings table and secrets to the keychain. Mutates the in-memory
 * `config` so subsequent reads see the new values.
 */
export function saveLLMSettings(
  config: JarvisConfig,
  body: LLMSettingsRequest,
): void {
  if (!config.llm.providers) config.llm.providers = {};
  if (!config.llm.tiers) config.llm.tiers = {};

  // Apply provider updates (add / modify / remove).
  if (body.providers) {
    for (const [name, update] of Object.entries(body.providers)) {
      if (update === null) {
        delete config.llm.providers[name];
        try { deleteSecret(keychainKey(name)); } catch { /* ignore */ }
        continue;
      }
      const existing = config.llm.providers[name] ?? {};
      const merged: LLMProviderEntry = { ...existing };
      if (update.kind !== undefined) merged.kind = update.kind;
      if (update.base_url !== undefined) merged.base_url = update.base_url;
      // api_key is persisted to the keychain only - never store the plaintext
      // back into the config object that might end up on disk.
      if (update.api_key !== undefined) {
        if (update.api_key === '') {
          try { deleteSecret(keychainKey(name)); } catch { /* ignore */ }
        } else {
          try { setSecret(keychainKey(name), update.api_key); } catch (err) {
            console.warn(`[LLM] Failed to persist api_key for '${name}':`, err);
          }
        }
        delete merged.api_key;
      }
      config.llm.providers[name] = merged;
    }
  }

  // Persist the architecture choice. Kept in its own setting (not derived) so
  // the selection survives reloads and the user can flip either direction even
  // before any tier model is picked. Does NOT drive runtime routing - that
  // still keys off tiers.conversation in configureLLMTiers.
  if (body.mode === 'single' || body.mode === 'multi-tier') {
    setSetting(SETTING_MODE, body.mode);
  }

  // Apply default + tier model refs.
  if (body.default !== undefined) {
    config.llm.default = body.default ?? undefined;
  }
  if (body.tiers) {
    for (const tier of ['conversation', 'high', 'medium', 'low'] as const) {
      if (tier in body.tiers) {
        const value = body.tiers[tier];
        if (value === null || value === '') {
          delete config.llm.tiers[tier];
        } else if (typeof value === 'string') {
          config.llm.tiers[tier] = value;
        }
      }
    }
  }

  // Persist non-secret state to DB. CRITICAL: strip api_key from every
  // provider entry before serializing - the in-memory entries carry secrets
  // injected from the keychain (see mergeLLMSettingsIntoConfig), and the
  // settings table is plaintext.
  setSetting(SETTING_PROVIDERS, JSON.stringify(stripSecretsFromProviders(config.llm.providers)));
  setSetting(SETTING_DEFAULT, config.llm.default ?? '');
  setSetting(SETTING_TIER_CONVERSATION, config.llm.tiers.conversation ?? '');
  setSetting(SETTING_TIER_HIGH, config.llm.tiers.high ?? '');
  setSetting(SETTING_TIER_MEDIUM, config.llm.tiers.medium ?? '');
  setSetting(SETTING_TIER_LOW, config.llm.tiers.low ?? '');
}

/**
 * Return a copy of the providers map with api_key stripped from every entry.
 * Used by anything that persists provider entries to a non-encrypted store
 * (DB settings table, YAML file). The keychain remains the source of truth
 * for credentials.
 */
export function stripSecretsFromProviders(
  providers: Record<string, LLMProviderEntry> | undefined,
): Record<string, LLMProviderEntry> {
  const out: Record<string, LLMProviderEntry> = {};
  for (const [name, entry] of Object.entries(providers ?? {})) {
    if (!entry) continue;
    const { api_key: _omit, ...rest } = entry;
    void _omit;
    out[name] = rest;
  }
  return out;
}

// ── mergeLLMSettingsIntoConfig ───────────────────────────────────────────

/**
 * Load ALL LLM settings from the DB + encrypted keychain into the in-memory
 * config at startup. This is the SOLE source of LLM configuration: providers,
 * credentials, the single-LLM `default`, and the tier map all come from the
 * database. config.yaml and env vars contribute nothing (loadConfig discards
 * any `llm` block and the env loader no longer reads LLM vars), so this fully
 * REPLACES `config.llm` rather than merging into it - a stale value can never
 * shadow the dashboard.
 *
 * Also reads legacy DB keys (KEY_ANTHROPIC, SETTING_PRIMARY, etc.) from
 * pre-rework installs and migrates them in-memory so users upgrading don't
 * lose their saved credentials.
 */
export function mergeLLMSettingsIntoConfig(config: JarvisConfig): void {
  // Replace, don't merge: the DB is authoritative for every LLM setting.
  config.llm.providers = {};
  config.llm.tiers = {};
  config.llm.default = undefined;

  // 1. New shape: load providers JSON + default + tier strings.
  const providersJson = getSetting(SETTING_PROVIDERS);
  if (providersJson) {
    try {
      const parsed = JSON.parse(providersJson) as Record<string, LLMProviderEntry>;
      for (const [name, entry] of Object.entries(parsed)) {
        config.llm.providers[name] = entry;
      }
    } catch (err) {
      console.warn('[LLM] Failed to parse stored providers JSON:', err);
    }
  }

  const dbDefault = getSetting(SETTING_DEFAULT);
  if (dbDefault) config.llm.default = dbDefault;

  for (const [tier, key] of [
    ['conversation', SETTING_TIER_CONVERSATION],
    ['high', SETTING_TIER_HIGH],
    ['medium', SETTING_TIER_MEDIUM],
    ['low', SETTING_TIER_LOW],
  ] as const) {
    const value = getSetting(key);
    if (value) config.llm.tiers[tier] = value;
  }

  // 2. Legacy shape: migrate per-provider DB keys + KEY_* secrets if any
  // are present and no new-shape providers exist for them. This is the
  // upgrade path for installs that pre-date the provider/model split.
  migrateLegacyDBSettings(config);

  // 3. Pull API keys from the keychain into provider entries. We do NOT
  // surface them in `config.llm.providers.<name>.api_key` (that would risk
  // saving them back to disk) - instead the config-binding module reads
  // from the keychain at provider-instantiation time. So this step only
  // ensures entries exist for any name with a keychain secret.
  for (const name of Object.keys(config.llm.providers)) {
    const key = getSecret(keychainKey(name));
    if (key) {
      // Inject into the entry transiently so registerLLMProviders can
      // instantiate the provider. The whole llm block is stripped before any
      // YAML write (see saveConfig / stripLLMConfigForYAML), and saveLLMSettings
      // persists secrets only to the keychain.
      config.llm.providers[name] = { ...config.llm.providers[name], api_key: key };
    }
  }
}

/**
 * Migrate legacy DB settings (KEY_ANTHROPIC, SETTING_PRIMARY, SETTING_*_MODEL)
 * into the new providers + default/tiers shape. Read-only - we don't delete
 * the legacy keys, just synthesize the new shape from them when the new
 * shape is empty.
 */
function migrateLegacyDBSettings(config: JarvisConfig): void {
  const LEGACY_KIND_KEYS: Array<{ kind: LLMProviderKind; secretKey: string; modelKey: string; baseUrlKey?: string }> = [
    { kind: 'anthropic', secretKey: 'llm.anthropic.api_key', modelKey: 'llm.anthropic.model' },
    { kind: 'openai', secretKey: 'llm.openai.api_key', modelKey: 'llm.openai.model' },
    { kind: 'groq', secretKey: 'llm.groq.api_key', modelKey: 'llm.groq.model' },
    { kind: 'gemini', secretKey: 'llm.gemini.api_key', modelKey: 'llm.gemini.model' },
    { kind: 'openrouter', secretKey: 'llm.openrouter.api_key', modelKey: 'llm.openrouter.model' },
    { kind: 'nvidia', secretKey: 'llm.nvidia.api_key', modelKey: 'llm.nvidia.model' },
    { kind: 'ollama', secretKey: '', modelKey: 'llm.ollama.model', baseUrlKey: 'llm.ollama.base_url' },
    { kind: 'openai_compatible', secretKey: 'llm.openai_compatible.api_key', modelKey: 'llm.openai_compatible.model', baseUrlKey: 'llm.openai_compatible.base_url' },
    { kind: 'litellm', secretKey: 'llm.litellm.api_key', modelKey: 'llm.litellm.model', baseUrlKey: 'llm.litellm.base_url' },
  ];

  // Capture legacy per-kind models for building model-ref strings later.
  const legacyModels: Partial<Record<LLMProviderKind, string>> = {};

  for (const entry of LEGACY_KIND_KEYS) {
    const name = entry.kind;  // legacy: provider name == kind
    const model = getSetting(entry.modelKey);
    if (model) legacyModels[entry.kind] = model;

    // Only auto-create a provider entry if there isn't one already (don't
    // clobber new-shape config that the user has explicitly set).
    if (config.llm.providers![name]) continue;

    const hasSecretKey = entry.secretKey && hasSecret(entry.secretKey);
    const baseUrl = entry.baseUrlKey ? getSetting(entry.baseUrlKey) : null;

    if (hasSecretKey || baseUrl) {
      const merged: LLMProviderEntry = {};
      // Migrate the keychain entry: copy the secret to the new keychain key
      // (keyed by provider name, not by hard-coded slot).
      if (hasSecretKey) {
        try {
          const k = getSecret(entry.secretKey);
          if (k) setSecret(keychainKey(name), k);
        } catch { /* ignore */ }
      }
      if (baseUrl) merged.base_url = baseUrl;
      config.llm.providers![name] = merged;
    }
  }

  // If neither default nor tiers are set, derive default from legacy primary.
  const tiersAnySet =
    config.llm.tiers!.conversation ||
    config.llm.tiers!.high ||
    config.llm.tiers!.medium ||
    config.llm.tiers!.low;
  if (!config.llm.default && !tiersAnySet) {
    const legacyPrimary = getSetting('llm.primary');
    if (legacyPrimary) {
      const model = legacyModels[legacyPrimary as LLMProviderKind];
      if (model) config.llm.default = `${legacyPrimary}:${model}`;
    }
  }
}

// ── hotReloadLLMProviders ────────────────────────────────────────────────

/**
 * Rebuild provider instances + tier map from the current config and apply
 * them atomically to the manager. Safe for in-flight requests because the
 * underlying replaceProviders/setTierMap operations are atomic.
 */
export function hotReloadLLMProviders(config: JarvisConfig, llmManager: LLMManager): void {
  // Build enriched entries with keychain secrets injected so providers can
  // instantiate. The injection is transient - only the in-memory entries
  // see it; persisted forms (DB / YAML) get stripped via
  // stripSecretsFromProviders / stripLegacyLLMFields.
  const providers = config.llm.providers ?? {};
  const enrichedProviders: Record<string, LLMProviderEntry> = {};
  for (const [name, entry] of Object.entries(providers)) {
    if (!entry) continue;
    const key = entry.api_key ?? getSecret(keychainKey(name)) ?? undefined;
    enrichedProviders[name] = { ...entry, ...(key ? { api_key: key } : {}) };
  }

  // Atomic single-step swap: build the new provider list, then replaceProviders
  // does the map swap in one assignment. In-flight requests see EITHER the
  // old map or the new one, never an empty/partial map.
  const built = atomicReloadProviders(llmManager, enrichedProviders);
  if (built.length === 0) {
    console.warn('[LLM] Hot-reload: no providers registered (all entries missing credentials).');
  }
  configureLLMTiers(llmManager, config.llm);

  console.log(`[LLM] Providers active after hot-reload: ${built.map((p) => p.name).join(', ') || 'none'}`);
}

// ── testLLMProvider ──────────────────────────────────────────────────────

/**
 * Test a provider's credentials by instantiating it and sending a one-token
 * chat. Uses the supplied credentials if given, otherwise the current config.
 *
 * Accepts the new shape: { name, kind?, api_key?, base_url?, model? }. The
 * `kind` defaults to `name` (canonical provider classes). The `model` is
 * the one to use for the test call.
 */
export async function testLLMProvider(
  opts: {
    name?: string;
    kind?: LLMProviderKind;
    /** Legacy alias accepted from older dashboard builds. */
    provider?: string;
    api_key?: string;
    base_url?: string;
    model?: string;
  },
  config: JarvisConfig,
): Promise<{ ok: boolean; model?: string; error?: string }> {
  // Resolve effective name + kind. Legacy `provider` is treated as `name`.
  const name = opts.name ?? opts.provider ?? opts.kind;
  if (!name) return { ok: false, error: 'provider name required' };

  // Look up config entry to inherit settings the caller didn't override.
  const configured = config.llm.providers?.[name];
  const kind: LLMProviderKind = (opts.kind ?? configured?.kind ?? name) as LLMProviderKind;

  // Resolve credentials: explicit > keychain > config inline.
  const apiKey = opts.api_key ?? getSecret(keychainKey(name)) ?? configured?.api_key ?? '';
  const baseUrl = opts.base_url ?? configured?.base_url ?? '';

  const entry: LLMProviderEntry = {
    kind,
    ...(apiKey ? { api_key: apiKey } : {}),
    ...(baseUrl ? { base_url: baseUrl } : {}),
  };

  const instance = instantiateProvider(name, entry);
  if (!instance) {
    return { ok: false, error: 'Missing credentials (api_key or base_url) for this provider kind' };
  }

  try {
    const resp = await instance.chat(
      [{ role: 'user', content: 'Say OK' }],
      { max_tokens: 5, ...(opts.model ? { model: opts.model } : {}) },
    );
    return { ok: true, model: resp.model };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
