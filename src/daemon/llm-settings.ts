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
import {
  applyUsejarvisAi,
  effectiveLlmForBinding,
  hasUsejarvisAi,
  USEJARVIS_PROVIDER_NAME,
  validateHostedModelRef,
} from './usejarvis-ai.ts';
import { getSetting, setSetting } from '../vault/settings.ts';
import { getSecret, setSecret, deleteSecret, hasSecret } from '../vault/keychain.ts';
import type { LLMManager } from '../llm/manager.ts';
import type { LLMProvider } from '../llm/provider.ts';
import {
  instantiateProvider,
  atomicReloadProviders,
  configureLLMTiers,
} from '../llm/config-binding.ts';
import { isAnthropicCustomBaseUrl } from '../llm/anthropic.ts';
import { GROQ_DEPRECATED_MODEL_REPLACEMENTS } from '../llm/groq-models.ts';
import { TIERS, type Tier, parseModelRef } from '../llm/tiers.ts';

// ── DB keys ──────────────────────────────────────────────────────────────
const SETTING_PROVIDERS = 'llm.providers';
const SETTING_DEFAULT = 'llm.default';
const SETTING_MODE = 'llm.mode';
const SETTING_TIER_CONVERSATION = 'llm.tiers.conversation';
const SETTING_TIER_HIGH = 'llm.tiers.high';
const SETTING_TIER_MEDIUM = 'llm.tiers.medium';
const SETTING_TIER_LOW = 'llm.tiers.low';
const SETTING_PROMPT_CACHE = 'llm.prompt_cache';

/** Settings key per tier. Single source so the read/write paths can't drift. */
const SETTING_TIER_KEYS: Record<Tier, string> = {
  conversation: SETTING_TIER_CONVERSATION,
  high: SETTING_TIER_HIGH,
  medium: SETTING_TIER_MEDIUM,
  low: SETTING_TIER_LOW,
};

/** Keychain key for a provider's API key, by provider NAME (not kind). */
function keychainKey(providerName: string): string {
  return `llm.provider.${providerName}.api_key`;
}

function normalizeBaseUrl(value: string | undefined): string {
  return value?.trim().replace(/\/+$/, '') ?? '';
}

/** RFC 7230 `token` - the only characters legal in an HTTP header name. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Normalize a caller-supplied auth header name, or throw if it isn't a legal
 * header name. Both the save and the test path go through here so the two
 * boundaries can't disagree about what they accept - a rejected name must
 * produce the same message whether you clicked Save or Test.
 *
 * Returns undefined for a blank value, which clears the field and hands the
 * provider back its own default.
 */
function validateAuthHeader(value: string, providerName: string): string | undefined {
  const header = value.trim();
  if (!header) return undefined;
  if (!HEADER_NAME_RE.test(header)) {
    throw new Error(`Provider '${providerName}' has an invalid auth header name`);
  }
  return header;
}

// ── Types exposed to the dashboard ───────────────────────────────────────
export type LLMSettingsProviderView = {
  kind: LLMProviderKind;
  has_api_key: boolean;
  base_url?: string;
  auth_header?: string;
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
  /** True on hosted installs (the system-owned usejarvis_ai block is live). */
  hosted_llm?: boolean;
  /** Provider-side prompt caching. Defaults to true; only explicit false disables. */
  prompt_cache: boolean;
  /**
   * What the daemon is ACTUALLY routing with, computed from the same
   * effectiveLlmForBinding view the provider-binding paths consume. The
   * `tiers`/`mode`/`default` fields above are persisted user intent; this is
   * the resolved result after hosted per-slot filling. The dashboard renders
   * hints and fallback labels from HERE, never by re-deriving the fill —
   * re-derivation is how the UI and the daemon ended up contradicting each
   * other (pr2 review #3B, pr7 review #2).
   */
  effective: LLMSettingsEffectiveView;
};

/** Where an effective tier ref came from. */
export type EffectiveTierSource =
  | 'choice'   // the user's explicit tier ref
  | 'default'  // filled from llm.default (per-slot, hosted installs)
  | 'plan';    // filled from the plan's uj-* alias

export type LLMSettingsEffectiveView = {
  /** Architecture actually bound: router-first iff the effective view has a
   * conversation tier (the same rule configureLLMTiers applies). */
  mode: 'single' | 'router-first';
  tiers: Record<Tier, {
    ref: string | null;
    source: EffectiveTierSource | null;
  }>;
};

/** Body shape accepted by saveLLMSettings - all fields optional/partial. */
export type LLMSettingsRequest = {
  providers?: Record<string, {
    kind?: LLMProviderKind;
    api_key?: string;
    base_url?: string;
    auth_header?: string;
  } | null>;            // null deletes the provider
  default?: string | null;     // null clears
  mode?: LLMMode;              // persisted architecture choice
  tiers?: {
    conversation?: string | null;
    high?: string | null;
    medium?: string | null;
    low?: string | null;
  };
  prompt_cache?: boolean;
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
  'omniroute',
];

// ── getLLMSettings ───────────────────────────────────────────────────────

export function getLLMSettings(config: JarvisConfig): LLMSettingsResponse {
  const providers: Record<string, LLMSettingsProviderView> = {};
  for (const [name, entry] of Object.entries(config.llm.providers ?? {})) {
    if (!entry) continue;
    // The injected hosted provider is SYSTEM-owned: not editable, and its
    // base_url/key presence are none of the dashboard's business. It is
    // surfaced separately as a managed flag below. Hosted-gated: a
    // self-hosted install whose user happened to name a provider
    // `usejarvis_ai` before the reservation existed still owns that entry.
    if (name === USEJARVIS_PROVIDER_NAME && hasUsejarvisAi(config)) continue;
    const kind = (entry.kind ?? name) as LLMProviderKind;
    providers[name] = {
      kind,
      has_api_key: hasSecret(keychainKey(name)) || Boolean(entry.api_key),
      ...(entry.base_url ? { base_url: entry.base_url } : {}),
      ...(entry.auth_header ? { auth_header: entry.auth_header } : {}),
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

  // The resolved routing view, from the same function the binding paths use.
  const bound = effectiveLlmForBinding(config);
  const effectiveTiers = {} as LLMSettingsEffectiveView['tiers'];
  for (const tier of TIERS) {
    const chosen = config.llm.tiers?.[tier];
    if (chosen) {
      effectiveTiers[tier] = { ref: chosen, source: 'choice' };
      continue;
    }
    const resolved = bound.tiers?.[tier] ?? null;
    effectiveTiers[tier] = resolved
      ? { ref: resolved, source: config.llm.default ? 'default' : 'plan' }
      : { ref: null, source: null };
  }
  const effective: LLMSettingsEffectiveView = {
    // Same rule configureLLMTiers applies: a conversation tier in the BOUND
    // view activates router-first, whatever the stored mode label says.
    mode: effectiveTiers.conversation.ref ? 'router-first' : 'single',
    tiers: effectiveTiers,
  };

  return {
    providers,
    default: config.llm.default ?? null,
    mode,
    tiers,
    available_kinds: AVAILABLE_KINDS,
    prompt_cache: config.llm.prompt_cache !== false,
    effective,
    // Hosted installs: tells the dashboard to render the read-only
    // "included with your plan" card (no base_url, no key material), and
    // gates the onboarding steps the platform already answers.
    // Derived from the config.yaml block — the single source of hostedness —
    // never from provider-map key presence, which a legacy row can fake.
    hosted_llm: hasUsejarvisAi(config),
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

  // Server-side allowlist for hosted refs (validate-before-mutate: this runs
  // before ANY provider/tier/default application). The UI hides free-text
  // model entry for the managed provider, but the UI is not the gate — a
  // hand-crafted POST carrying `usejarvis_ai:gpt-5.5` or `usejarvis_ai:uj-stt`
  // must not reach the proxy under the account key (review pr3#1, pr1#9).
  if (hasUsejarvisAi(config)) {
    const candidateRefs: string[] = [];
    if (typeof body.default === 'string' && body.default) candidateRefs.push(body.default);
    if (body.tiers) {
      for (const value of Object.values(body.tiers)) {
        if (typeof value === 'string' && value) candidateRefs.push(value);
      }
    }
    for (const ref of candidateRefs) {
      const parsed = parseModelRef(ref);
      if (parsed?.provider === USEJARVIS_PROVIDER_NAME) {
        const problem = validateHostedModelRef(parsed.model ?? '');
        if (problem) throw new Error(problem);
      }
    }
  }

  // Apply provider updates (add / modify / remove).
  if (body.providers) {
    const updates = Object.entries(body.providers);
    // Validate every update before mutating anything: a rejection mid-loop
    // would otherwise leave earlier entries applied in memory but never
    // persisted by the setSetting() block at the end of this function.
    for (const [name, update] of updates) {
      // SYSTEM-owned: on hosted installs an edit/delete of the reserved name
      // is refused loudly (a silent skip reported "saved" for a no-op). The
      // throw lives HERE in the validation loop so a rejected batch mutates
      // nothing. On self-hosted installs there is no reservation: a legacy
      // provider that happens to carry the name falls through to the normal
      // validation and save path like any other entry.
      if (name === USEJARVIS_PROVIDER_NAME && hasUsejarvisAi(config)) {
        throw new Error(
          `Provider '${USEJARVIS_PROVIDER_NAME}' is managed by your hosting plan and cannot be edited or deleted`,
        );
      }
      if (update === null) continue;
      const existing = config.llm.providers[name] ?? {};
      const nextBaseUrl = normalizeBaseUrl(update.base_url);
      const existingBaseUrl = normalizeBaseUrl(existing.base_url);
      const retainsStoredCredential = update.api_key === undefined
        && (Boolean(existing.api_key) || hasSecret(keychainKey(name)));
      // A stored credential is scoped to its saved endpoint in BOTH
      // directions: it must not follow the provider to a new gateway, and a
      // gateway token must not be replayed against the official endpoint
      // after the URL is cleared. Any base_url move requires the credential
      // again in the same request.
      if (
        update.base_url !== undefined
        && nextBaseUrl !== existingBaseUrl
        && retainsStoredCredential
      ) {
        throw new Error(`Provider '${name}' requires the API key or auth token again when changing base_url`);
      }
      // `kind` selects an endpoint just like base_url does — switching it
      // would replay the stored credential against another provider's API.
      // (Legacy entries without an explicit kind are keyed by their name.)
      if (
        update.kind !== undefined
        && update.kind !== (existing.kind ?? name)
        && retainsStoredCredential
      ) {
        throw new Error(`Provider '${name}' requires the API key or auth token again when changing kind`);
      }
    }
    for (const [name, update] of updates) {
      // Hosted installs never reach here with the reserved name — the
      // validation loop above already threw. Defensive skip in case the two
      // loops ever drift apart; on self-hosted the entry is a normal provider.
      if (name === USEJARVIS_PROVIDER_NAME && hasUsejarvisAi(config)) continue;
      if (update === null) {
        delete config.llm.providers[name];
        // Drop every model ref the provider owned. The manager prunes its own
        // tier map on replaceProviders, but the settings table is a separate
        // store - leaving the refs there resurrects the dead routes on the
        // next cold start.
        if (parseModelRef(config.llm.default)?.provider === name) {
          config.llm.default = undefined;
        }
        for (const tier of TIERS) {
          if (parseModelRef(config.llm.tiers[tier])?.provider === name) {
            delete config.llm.tiers[tier];
          }
        }
        try { deleteSecret(keychainKey(name)); } catch { /* ignore */ }
        continue;
      }
      const existing = config.llm.providers[name] ?? {};
      const merged: LLMProviderEntry = { ...existing };
      if (update.kind !== undefined) merged.kind = update.kind;
      if (update.base_url !== undefined) merged.base_url = update.base_url;
      if (update.auth_header !== undefined) {
        merged.auth_header = validateAuthHeader(update.auth_header, name);
      }
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

  // Repair old Groq references before the updated providers are reloaded.
  // No persist: the block below writes default + tiers to the DB anyway.
  migrateDeprecatedGroqModels(config, false);

  // Persist non-secret state to DB. CRITICAL: strip api_key from every
  // provider entry before serializing - the in-memory entries carry secrets
  // injected from the keychain (see mergeLLMSettingsIntoConfig), and the
  // settings table is plaintext.
  setSetting(SETTING_PROVIDERS, JSON.stringify(
    stripSecretsFromProviders(config.llm.providers, { hosted: hasUsejarvisAi(config) }),
  ));
  setSetting(SETTING_DEFAULT, config.llm.default ?? '');
  setSetting(SETTING_TIER_CONVERSATION, config.llm.tiers.conversation ?? '');
  setSetting(SETTING_TIER_HIGH, config.llm.tiers.high ?? '');
  setSetting(SETTING_TIER_MEDIUM, config.llm.tiers.medium ?? '');
  setSetting(SETTING_TIER_LOW, config.llm.tiers.low ?? '');

  if (body.prompt_cache !== undefined) {
    config.llm.prompt_cache = body.prompt_cache;
    setSetting(SETTING_PROMPT_CACHE, body.prompt_cache ? 'true' : 'false');
  }
}

/**
 * Return a copy of the providers map with api_key stripped from every entry.
 * Used by anything that persists provider entries to a non-encrypted store
 * (DB settings table, YAML file). The keychain remains the source of truth
 * for credentials.
 */
export function stripSecretsFromProviders(
  providers: Record<string, LLMProviderEntry> | undefined,
  options: { hosted?: boolean } = {},
): Record<string, LLMProviderEntry> {
  const out: Record<string, LLMProviderEntry> = {};
  for (const [name, entry] of Object.entries(providers ?? {})) {
    if (!entry) continue;
    // On hosted installs the reserved provider is INJECTED from config.yaml
    // on every merge — it must never round-trip into the persisted DB shape
    // (it would survive un-hosting and shadow the file as a stale copy). On
    // self-hosted installs a legacy provider carrying the name is user
    // property and persists like any other (dropping it silently destroyed
    // the entry plus its refs on the next boot).
    if (name === USEJARVIS_PROVIDER_NAME && options.hosted !== false) continue;
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
export function mergeLLMSettingsIntoConfig(
  config: JarvisConfig,
  options: { persistMigrations?: boolean } = {},
): void {
  // Replace, don't merge: the DB is authoritative for every LLM setting.
  config.llm.providers = {};
  config.llm.tiers = {};
  config.llm.default = undefined;

  // 1. New shape: load providers JSON + default + tier strings.
  const providersJson = getSetting(SETTING_PROVIDERS);
  // A parse failure means we don't actually know which providers exist, so the
  // orphan prune below must not run - every ref would look dangling and we'd
  // wipe a working config over one corrupt row.
  let providersReadable = true;
  if (providersJson) {
    try {
      const parsed = JSON.parse(providersJson) as Record<string, LLMProviderEntry>;
      for (const [name, entry] of Object.entries(parsed)) {
        // Hosted installs: a DB row squatting on the reserved name never
        // loads (applyUsejarvisAi would overwrite it anyway; skipping keeps
        // the invariant visible). Self-hosted legacy rows load normally.
        if (name === USEJARVIS_PROVIDER_NAME && hasUsejarvisAi(config)) continue;
        config.llm.providers[name] = entry;
      }
    } catch (err) {
      providersReadable = false;
      console.warn('[LLM] Failed to parse stored providers JSON:', err);
    }
  }

  const dbDefault = getSetting(SETTING_DEFAULT);
  if (dbDefault) config.llm.default = dbDefault;

  for (const tier of TIERS) {
    const value = getSetting(SETTING_TIER_KEYS[tier]);
    if (value) config.llm.tiers[tier] = value;
  }

  // Prompt caching: only override when a DB setting exists, so a value
  // already present on the config object (e.g. from config.yaml) survives
  // until the user touches the dashboard setting. Absent everywhere =
  // enabled (every consumer checks `prompt_cache !== false`).
  const storedPromptCache = getSetting(SETTING_PROMPT_CACHE);
  if (storedPromptCache !== null) {
    config.llm.prompt_cache = storedPromptCache !== 'false';
  }

  // 2. Hosted installs: inject the usejarvis_ai provider from the config.yaml
  // block BEFORE the legacy migration and the orphan prune below. The prune
  // decides "orphan" by looking the ref's provider up in config.llm.providers;
  // injecting afterwards made every persisted usejarvis_ai:* ref look dangling
  // and PERSISTED its deletion — a hosted user's explicit tier/default choices
  // were erased on every boot.
  applyUsejarvisAi(config);

  // 3. Legacy shape: migrate per-provider DB keys + KEY_* secrets if any
  // are present and no new-shape providers exist for them. This is the
  // upgrade path for installs that pre-date the provider/model split.
  migrateLegacyDBSettings(config);
  migrateDeprecatedGroqModels(config, options.persistMigrations !== false);

  // Repair installs dirtied before provider deletion cleaned up after itself.
  // Runs after the legacy migration so refs it just revived still count.
  if (providersReadable) {
    pruneOrphanedModelRefs(config, options.persistMigrations !== false);
  }

  // 4. Pull API keys from the keychain into provider entries. We do NOT
  // surface them in `config.llm.providers.<name>.api_key` (that would risk
  // saving them back to disk) - instead the config-binding module reads
  // from the keychain at provider-instantiation time. So this step only
  // ensures entries exist for any name with a keychain secret. (There is no
  // YAML write path: loader.ts deliberately has no saveConfig.)
  for (const name of Object.keys(config.llm.providers)) {
    // The hosted provider's credential comes from the config.yaml block only;
    // a keychain entry squatting on the reserved name must not shadow it.
    // Self-hosted legacy providers hydrate from the keychain like any other.
    if (name === USEJARVIS_PROVIDER_NAME && hasUsejarvisAi(config)) continue;
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
 * Drop `default` / tier refs pointing at providers that are no longer
 * configured. saveLLMSettings clears these when a provider is deleted, but
 * installs dirtied before that landed still carry the dead refs: they load
 * back in on every start, configureLLMTiers warns and skips them, and the
 * affected tier silently falls up. Repairing on load makes those installs
 * self-heal instead of needing the user to re-pick every tier.
 *
 * A provider that is configured but not instantiable (e.g. its API key is
 * missing) is NOT an orphan - the entry still exists, so its refs stay put
 * until the user removes the provider outright.
 */
function pruneOrphanedModelRefs(config: JarvisConfig, persist = true): void {
  const orphanedOwner = (ref: string | undefined): string | null => {
    const parsed = parseModelRef(ref);
    if (!parsed || config.llm.providers?.[parsed.provider]) return null;
    return parsed.provider;
  };

  const dropped: string[] = [];

  const defaultOwner = orphanedOwner(config.llm.default);
  if (defaultOwner) {
    dropped.push(`default (${defaultOwner})`);
    config.llm.default = undefined;
    if (persist) setSetting(SETTING_DEFAULT, '');
  }

  for (const tier of TIERS) {
    const owner = orphanedOwner(config.llm.tiers?.[tier]);
    if (!owner) continue;
    dropped.push(`${tier} (${owner})`);
    delete config.llm.tiers?.[tier];
    if (persist) setSetting(SETTING_TIER_KEYS[tier], '');
  }

  if (dropped.length > 0) {
    console.warn(
      `[LLM] Dropped model refs for providers that no longer exist: ${dropped.join(', ')}.`,
    );
  }
}

/** Replace known retired Groq IDs before runtime starts. */
function migrateDeprecatedGroqModels(config: JarvisConfig, persist = true): void {
  const migrateRef = (ref: string | undefined): string | undefined => {
    if (!ref) return ref;
    const separator = ref.indexOf(':');
    if (separator <= 0) return ref;
    const providerName = ref.slice(0, separator);
    const entry = config.llm.providers?.[providerName];
    if ((entry?.kind ?? providerName) !== 'groq') return ref;
    const replacement = GROQ_DEPRECATED_MODEL_REPLACEMENTS[ref.slice(separator + 1)];
    return replacement ? `${providerName}:${replacement}` : ref;
  };

  let changed = false;
  const nextDefault = migrateRef(config.llm.default);
  if (nextDefault !== config.llm.default) {
    config.llm.default = nextDefault;
    changed = true;
  }
  for (const tier of ['conversation', 'high', 'medium', 'low'] as const) {
    const current = config.llm.tiers?.[tier];
    const next = migrateRef(current);
    if (next !== current) {
      if (next) config.llm.tiers![tier] = next;
      changed = true;
    }
  }
  if (!changed) return;

  if (!persist) return;

  setSetting(SETTING_DEFAULT, config.llm.default ?? '');
  setSetting(SETTING_TIER_CONVERSATION, config.llm.tiers?.conversation ?? '');
  setSetting(SETTING_TIER_HIGH, config.llm.tiers?.high ?? '');
  setSetting(SETTING_TIER_MEDIUM, config.llm.tiers?.medium ?? '');
  setSetting(SETTING_TIER_LOW, config.llm.tiers?.low ?? '');
  console.log('[LLM] Migrated deprecated Groq model references to supported replacements.');
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
  // Idempotent: a dashboard save rebuilds config.llm from the request before
  // calling this — the hosted provider must survive that too.
  applyUsejarvisAi(config);
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
  const built = atomicReloadProviders(llmManager, enrichedProviders, {
    promptCache: config.llm.prompt_cache !== false,
  });
  if (built.length === 0) {
    console.warn('[LLM] Hot-reload: no providers registered (all entries missing credentials).');
  }
  // Bind through the effective view: hosted tier defaults exist ONLY here,
  // never in config.llm, so no save path can accidentally persist them.
  configureLLMTiers(llmManager, effectiveLlmForBinding(config));

  console.log(`[LLM] Providers active after hot-reload: ${built.map((p) => p.name).join(', ') || 'none'}`);
}

// ── testLLMProvider ──────────────────────────────────────────────────────

/**
 * How many catalog models one connection test may probe before giving up.
 *
 * Each probe is a real, billable chat request and gateways fronting many
 * upstreams routinely advertise catalogs in the hundreds, so the walk has to
 * stop somewhere. Note this bounds MODELS, not HTTP requests: a provider that
 * resolves among several roots may spend more than one request per probe.
 */
const MAX_TEST_MODEL_PROBES = 10;

/**
 * Longest error text worth pattern-matching. The classifiers below use
 * `[\s\S]*`, which is quadratic on a non-matching subject, and an upstream
 * error body can be arbitrarily long — a gateway returning a megabyte of HTML
 * would otherwise stall the daemon's single event loop for seconds.
 */
const MAX_CLASSIFIED_ERROR_CHARS = 2000;

/**
 * A rejection that names a model is worth stepping past: gateway catalogs are
 * commonly a superset of what one credential may actually use. Matches both
 * spaced and underscored wordings (`not found`, `not_found_error`,
 * `model_not_found`) since each gateway phrases it differently.
 */
const MODEL_SCOPED_FAILURE =
  /model[\s\S]*(not[ _]?allowed|not[ _]?found|unavailable|denied)|not[ _]?allowed[\s\S]*model/i;

/**
 * On a routed gateway a single upstream can be down for one model only.
 *
 * Deliberately excludes 404: a 404 that is genuinely about the model says so
 * in words and is caught above, whereas a bare 404 means the ROUTE is wrong —
 * and walking ten models against a wrong route just multiplies the failure.
 */
const TRANSIENT_UPSTREAM_FAILURE = /HTTP (502|503|504)\b/i;

/**
 * Send the test prompt to each candidate model until one answers.
 *
 * Stops immediately on anything that isn't model-scoped — a bad key, a
 * network failure, or a malformed request must surface as itself rather than
 * being buried under N retries against other models.
 */
async function probeUsableModel(
  instance: LLMProvider,
  models: string[],
  allowTransientUpstream: boolean,
): Promise<{ model: string } | { lastError: string; probed: number }> {
  const candidates = models.slice(0, MAX_TEST_MODEL_PROBES);
  let lastError = '';
  let probed = 0;

  for (const candidate of candidates) {
    probed++;
    try {
      await instance.chat([{ role: 'user', content: 'Say OK' }], { max_tokens: 5, model: candidate });
      return { model: candidate };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = message;
      const classified = message.slice(0, MAX_CLASSIFIED_ERROR_CHARS);
      const recoverable = MODEL_SCOPED_FAILURE.test(classified)
        || (allowTransientUpstream && TRANSIENT_UPSTREAM_FAILURE.test(classified));
      if (!recoverable) throw err;
    }
  }

  return { lastError, probed };
}

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
    auth_header?: string;
    model?: string;
  },
  config: JarvisConfig,
): Promise<{ ok: boolean; model?: string; models?: string[]; error?: string }> {
  // Resolve effective name + kind. Legacy `provider` is treated as `name`.
  const name = opts.name ?? opts.provider ?? opts.kind;
  if (!name) return { ok: false, error: 'provider name required' };
  // The hosted provider's key must never pass through user hands: a caller
  // could combine the inherited credential with a kind/base_url OVERRIDE and
  // exfiltrate it to an arbitrary endpoint. It is system-tested, not
  // user-tested. (Self-hosted installs have no platform key to protect; a
  // legacy provider carrying the name is testable like any other.)
  if (name === USEJARVIS_PROVIDER_NAME && hasUsejarvisAi(config)) {
    return { ok: false, error: 'usejarvis_ai is system-managed and cannot be tested here' };
  }

  // Look up config entry to inherit settings the caller didn't override.
  const configured = config.llm.providers?.[name];
  const kind: LLMProviderKind = (opts.kind ?? configured?.kind ?? name) as LLMProviderKind;

  const hasExplicitBaseUrl = Object.hasOwn(opts, 'base_url');
  const requestedBaseUrl = opts.base_url?.trim() ?? '';
  const configuredBaseUrl = configured?.base_url?.trim() ?? '';
  const storedApiKey = getSecret(keychainKey(name)) ?? configured?.api_key ?? '';
  const normalizedRequestedBaseUrl = normalizeBaseUrl(requestedBaseUrl);
  const normalizedConfiguredBaseUrl = normalizeBaseUrl(configuredBaseUrl);

  // A stored credential is scoped to its saved endpoint, in both directions:
  // never attach it to a caller-supplied URL, and never replay a gateway
  // token against the official endpoint after the URL is cleared. Moving the
  // endpoint anywhere requires the credential again in the same request.
  if (
    hasExplicitBaseUrl
    && normalizedRequestedBaseUrl !== normalizedConfiguredBaseUrl
    && storedApiKey
    && !opts.api_key
  ) {
    return { ok: false, error: 'Changing base_url requires an explicit api_key or auth token' };
  }

  // `kind` selects an endpoint just like base_url does — an overridden kind
  // would replay the stored credential against another provider's API (some
  // kinds don't even need a base_url to reach one, e.g. their default
  // origin). Legacy entries without an explicit kind are keyed by name.
  if (
    opts.kind !== undefined
    && opts.kind !== (configured?.kind ?? name)
    && storedApiKey
    && !opts.api_key
  ) {
    return { ok: false, error: 'Changing the provider kind requires an explicit api_key or auth token' };
  }

  // Resolve credentials: explicit > keychain > config inline. Preserve an
  // explicit empty base_url instead of falling back to the stored gateway.
  const apiKey = opts.api_key ?? storedApiKey;
  const baseUrl = hasExplicitBaseUrl ? requestedBaseUrl : configuredBaseUrl;

  // Same validation as the save path - a test must not be able to smuggle in
  // a header name that Save would have rejected. Report it as a failed test
  // rather than letting it escape as a 'malformed body' from the route.
  let authHeader: string | undefined;
  try {
    authHeader = opts.auth_header !== undefined
      ? validateAuthHeader(opts.auth_header, name)
      : configured?.auth_header;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const entry: LLMProviderEntry = {
    kind,
    ...(apiKey ? { api_key: apiKey } : {}),
    ...(baseUrl ? { base_url: baseUrl } : {}),
    ...(authHeader ? { auth_header: authHeader } : {}),
  };

  const instance = instantiateProvider(name, entry);
  if (!instance) {
    return { ok: false, error: 'Missing credentials (api_key or base_url) for this provider kind' };
  }

  try {
    let models: string[] | undefined;
    let testModel = opts.model;
    if (kind === 'anthropic' && isAnthropicCustomBaseUrl(baseUrl) && !testModel) {
      models = await instance.listModels().catch(() => []);
      if (!models.length) {
        return { ok: false, error: 'Could not discover any models from the custom Anthropic endpoint' };
      }
      const probe = await probeUsableModel(instance, models, false);
      if ('model' in probe) return { ok: true, model: probe.model, models };
      return {
        ok: false,
        error: `The custom Anthropic endpoint listed ${models.length} models, but this credential could not use any of the ${probe.probed} tried${probe.lastError ? `: ${probe.lastError}` : ''}`,
        models,
      };
    }
    if (kind === 'openai_compatible' && !testModel) {
      models = await instance.listModels();
      if (!models.length) {
        return { ok: false, error: 'The OpenAI-compatible endpoint did not return any models from /v1/models' };
      }
      const probe = await probeUsableModel(instance, models, true);
      if ('model' in probe) return { ok: true, model: probe.model, models };
      return {
        ok: false,
        error: `The OpenAI-compatible endpoint listed models, but none of the first ${probe.probed} accepted a test request${probe.lastError ? `: ${probe.lastError}` : ''}`,
        models,
      };
    }
    const resp = await instance.chat(
      [{ role: 'user', content: 'Say OK' }],
      { max_tokens: 5, ...(testModel ? { model: testModel } : {}) },
    );
    return { ok: true, model: testModel ?? resp.model, ...(models ? { models } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
