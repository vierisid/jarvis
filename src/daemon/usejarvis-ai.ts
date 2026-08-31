import type { JarvisConfig, LLMConfig, STTConfig, TTSConfig } from '../config/types.ts';
import type { HostedVoiceCredentials } from '../comms/voice.ts';
import { loadUserSection, loadUserSectionStrict } from './user-settings.ts';

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
let malformedBlockWarned = false;
function warnMalformedBlockOnce(): void {
  if (malformedBlockWarned) return;
  malformedBlockWarned = true;
  console.warn(
    '[UsejarvisAI] Ignoring malformed usejarvis_ai config block: base_url and api_key must be strings (quote them in config.yaml).',
  );
}

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
    // ONCE. This used to be reached rarely; now a hosted dashboard polls
    // GET /api/config/voice every ~15s and each read runs hasUsejarvisAi, so a
    // single mistyped line would print four times a minute for the life of the
    // daemon and bury everything else. Same latch as warnVaultOnce below.
    warnMalformedBlockOnce();
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
    // Strict === true: this is the provisioner's opt-in (default OFF — see
    // the block comment in config/types.ts), and YAML-typed junk must read
    // as "not opted in", never as enabled. Read off the raw block: the
    // validated read narrows to base_url/api_key only.
    prompt_cache: config.usejarvis_ai?.prompt_cache === true,
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

// ── Hosted model allowlist (server-side gate) ────────────────────────────
//
// The dashboard's picker restrictions are advisory; THIS is the gate. Refs
// under the reserved provider are validated against the plan catalog when we
// have seen one recently, and against a conservative static rule otherwise.
// The cache is fed by the catalog route (the UI hits it whenever a hosted
// tier picker renders), because saveLLMSettings is synchronous and must not
// fetch. A degraded catalog (proxy unreachable → fallback aliases) never
// enters the cache: it would shrink the allowlist to four entries and reject
// plan-specific aliases the user legitimately holds.

const CATALOG_TTL_MS = 5 * 60_000;
let hostedCatalog: { models: ReadonlySet<string>; at: number } | null = null;

/** Feed the allowlist cache from a live (non-degraded) catalog response. */
export function noteHostedCatalog(models: string[], degraded: boolean): void {
  if (degraded) return;
  hostedCatalog = { models: new Set(models), at: Date.now() };
}

export function clearHostedCatalogForTest(): void {
  hostedCatalog = null;
}

/** Aliases that resolve to non-chat endpoints; never valid as a tier/default
 * ref even when the live catalog is unavailable. */
const NON_CHAT_ALIAS = /^uj-(stt|tts|realtime)\b/;

/**
 * Validate the model half of a `usejarvis_ai:<model>` ref. Returns an error
 * message for the 400, or null when the ref is acceptable.
 */
export function validateHostedModelRef(model: string): string | null {
  const fresh = hostedCatalog && Date.now() - hostedCatalog.at < CATALOG_TTL_MS
    ? hostedCatalog.models
    : null;
  if (fresh) {
    return fresh.has(model)
      ? null
      : `Model '${model}' is not in your plan's catalog`;
  }
  if (!model.startsWith('uj-') || NON_CHAT_ALIAS.test(model)) {
    return `Model '${model}' is not a chat alias of your plan`;
  }
  return null;
}

// ── Hosted voice (STT + TTS) ────────────────────────────────────────────────

/**
 * The proxy credentials for the voice provider factories, as a value SEPARATE
 * from cfg.stt/cfg.tts: those sections persist as plaintext JSON rows in the
 * DB settings store and round-trip through the /api/config routes, so the
 * per-account key must never be written into them. Null when self-hosted.
 */
export function usejarvisVoiceCredentials(config: JarvisConfig): HostedVoiceCredentials | null {
  if (!hasUsejarvisAi(config)) return null;
  const block = config.usejarvis_ai!;
  return { baseUrl: block.base_url!.trim(), apiKey: block.api_key!.trim() };
}

/** Provider-specific sub-blocks a stored stt row can carry. */
// Sub-blocks that mark a row as provider intent. Shared by the stt AND tts
// rows: openai/groq/local are STT-only, elevenlabs is TTS-only, sarvam is
// both — a section can't contain the other section's blocks, so the union
// has no false positives.
const PROVIDER_INTENT_BLOCKS = ['openai', 'groq', 'local', 'sarvam', 'elevenlabs'] as const;

/**
 * True when a stored user section records provider intent. An explicit
 * `provider` string is intent — but so is a row that carries any
 * provider-specific sub-block without one: importLegacyUserSettings writes
 * exactly that shape for a config.yaml that had `stt: { openai: {...} }` and
 * relied on DEFAULT_CONFIG for the provider line. Treating it as silence
 * silently re-routed that user's audio to the hosted proxy past the key they
 * configured. (New imports also stamp `provider` explicitly; this keeps rows
 * imported before that fix honest.)
 *
 * The one shape that beats the sub-block heuristic: `provider: ''` — the
 * explicit "cleared" sentinel clearProviderChoice writes. A reset click is a
 * newer, stronger signal than a leftover sub-block, and without the sentinel
 * the reset could never restore the plan default on a row that ever held a
 * key (the sub-block survives the reset by design — deleting it would delete
 * the keychain credential with it).
 */
function storedProviderChoice(stored: unknown): boolean {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return false;
  const rec = stored as Record<string, unknown>;
  if (typeof rec.provider === 'string') return rec.provider.trim() !== '';
  return PROVIDER_INTENT_BLOCKS.some(
    (block) => typeof rec[block] === 'object' && rec[block] !== null,
  );
}

/**
 * The BINDING view of cfg.stt: hosted installs where the user never chose an
 * STT provider default to the included Usejarvis AI transcription.
 *
 * Same persistence-purity rule as effectiveLlmForBinding: the default is
 * never assigned back onto config.stt, because that object is persisted
 * verbatim by every /api/config/stt save (mergeSTTConfig merges the patch
 * over the IN-MEMORY section) and by the voice-command provider switch — a
 * mutated fill would be recorded as user intent on the next unrelated save.
 * Consume this at provider-construction time only.
 *
 * "User is silent" is judged by the DB row, not by the in-memory value:
 * after mergeUserSettingsIntoConfig, config.stt.provider === 'openai' could
 * be either the DEFAULT_CONFIG value or an explicit dashboard choice — only
 * the presence of a `provider` in the stored `cfg.stt` row distinguishes the
 * two. `loadStored` is injectable for tests; the default reads the vault DB
 * (open in every runtime caller: boot, reload appliers, API routes).
 */
/**
 * The BINDING view of `voice.realtime.enabled`.
 *
 * Realtime is a paid slot on a hosted plan (`llm_profile_slots.slot =
 * 'realtime'` — the one slot REQUIRED_LLM_SLOTS leaves optional). A tenant
 * whose plan includes it should get it; today they never do, because
 * `voice.realtime.enabled` defaults to false, the only thing that flips it is
 * the JARVIS_REALTIME_VOICE env var, and the provisioner sets neither. The
 * hosted branch of resolveRealtimeVoice — which derives the wss:// endpoint and
 * dials the uj-realtime alias — has therefore never run in production.
 *
 * Same three rules as effectiveSttForBinding above, and for the same reasons:
 *  - not hosted → untouched. A BYO-key user keeps the explicit opt-in; realtime
 *    spends THEIR OpenAI money and must never switch itself on.
 *  - the user recorded a choice → it wins, in both directions.
 *  - otherwise → on, and the PLAN decides per session.
 *
 * ## Why the plan is not read here
 *
 * It cannot be, and it should not be. The `usejarvis_ai` block is
 * plan-INDEPENDENT by design (see the renderer in the control plane): per-plan
 * resolution happens at the proxy via aliases, so a plan change never rewrites
 * an instance's config. Encoding the entitlement in the file would break that
 * and require new machinery to re-render and push a config on every upgrade and
 * downgrade — with an instance left silently wrong whenever that push failed.
 *
 * The authority is `hostedRealtimeIncluded` (daemon/realtime-gate.ts), which
 * asks the key-scoped catalog whether the plan includes uj-realtime. It is
 * already written, cached, and deliberately conservative about its own
 * failures. This function only decides whether to ASK.
 *
 * ## Why a binding view rather than a mutation
 *
 * Writing the default into `config.voice` would let a dashboard voice save
 * read-modify-write it back as an explicit user choice — pinning realtime on
 * for a tenant who later loses it. Same hazard the tier defaults are kept out
 * of `config.llm` to avoid: runtime defaults stay out of every persistence path
 * by construction.
 */
export type RealtimeEnablement =
  /** The user (or JARVIS_REALTIME_VOICE) said yes. On a SELF-HOSTED install
   *  their own OpenAI key serves it; on a hosted one the plan does, whoever
   *  asked — see realtimeServedByPlan in config/realtime.ts. */
  | 'user-on'
  /** Nobody asked for it; it is on because the hosted plan may include it. A
   *  session from this state MUST resolve to the hosted alias — see below. */
  | 'hosted-default'
  | 'off';

export function realtimeEnablement(
  config: JarvisConfig,
  loadStored: (section: 'voice') => unknown = loadUserSectionStrict,
): RealtimeEnablement {
  const configured = config.voice?.realtime?.enabled === true;
  if (!hasUsejarvisAi(config)) return configured ? 'user-on' : 'off';
  // An explicit TRUE needs no disambiguation, and must not cost a vault read:
  // DEFAULT_CONFIG says false, so a true in the merged config can only have
  // come from the user or from JARVIS_REALTIME_VOICE. Only FALSE is ambiguous.
  if (configured) return 'user-on';
  // ...except when the env var is SET, where false is not ambiguous at all.
  //
  // Read it as: applyEnvOverrides runs LAST over every merge (boot and reload),
  // so if the var were a truthy value `configured` would be true and we would
  // have returned above. Reaching here with it set therefore means the loader
  // turned it into an explicit false — "0" / "false" / "no" / "" per loader.ts.
  // That is the operator's kill switch on exactly the fleet where realtime just
  // became default-on, so it has to outrank the default. (The truthiness table
  // is deliberately NOT duplicated here; the loader owns it.)
  if (process.env.JARVIS_REALTIME_VOICE !== undefined) return 'off';
  let choice: boolean | null = null;
  try {
    choice = storedRealtimeChoice(loadStored('voice'));
  } catch (err) {
    // The vault is the only place the user's answer lives, so an unreadable
    // one means we cannot tell "declined" from "never asked". Fall back to the
    // merged config rather than the hosted default: turning realtime ON for
    // someone who may have switched it off is the worse of the two mistakes,
    // and it opens a billed audio session to do it. Corrupt JSON reaches here
    // too (loadUserSectionStrict throws rather than reading as silence), because a
    // damaged row is not an answer either.
    warnVaultOnce(err);
    return configured ? 'user-on' : 'off';
  }
  if (choice === true) return 'user-on';
  if (choice === false) return 'off';
  return 'hosted-default';
}


/** Once, not per call: GET /api/config/voice is polled every 15s per dashboard
 *  and every voice_start reads this, so a broken vault would flood the log. */
let vaultWarned = false;
function warnVaultOnce(err: unknown): void {
  if (vaultWarned) return;
  vaultWarned = true;
  console.warn('[UsejarvisAI] could not read the stored voice section; leaving realtime as configured:', err);
}

/** Test seam for the warn-once latches. */
export function resetRealtimeVaultWarningForTest(): void {
  vaultWarned = false;
  malformedBlockWarned = false;
}

/**
 * The user's own answer, or null if they never gave one.
 *
 * Read from the STORED `cfg.voice` row, not the merged config: DEFAULT_CONFIG
 * sets `enabled: false`, so the in-memory value cannot tell "turned it off"
 * from "never touched" — the same trap effectiveTtsForBinding documents for
 * Edge being the default TTS provider. Only a boolean actually persisted under
 * `realtime.enabled` counts as an answer.
 */
function storedRealtimeChoice(stored: unknown): boolean | null {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return null;
  const rt = (stored as Record<string, unknown>).realtime;
  if (typeof rt !== 'object' || rt === null || Array.isArray(rt)) return null;
  const enabled = (rt as Record<string, unknown>).enabled;
  return typeof enabled === 'boolean' ? enabled : null;
}

export function effectiveSttForBinding(
  config: JarvisConfig,
  loadStored: (section: 'stt' | 'tts') => unknown = loadUserSection,
): STTConfig | undefined {
  if (!hasUsejarvisAi(config)) return config.stt;
  if (storedProviderChoice(loadStored('stt'))) return config.stt;
  return { ...config.stt, provider: 'usejarvis' };
}

/**
 * The BINDING view of cfg.tts, same rules as effectiveSttForBinding. The one
 * extra wrinkle: 'edge' is DEFAULT_CONFIG's provider value, so the in-memory
 * section reading 'edge' cannot distinguish "explicitly chose Edge" from
 * "never chose" — only a `provider` recorded in the stored `cfg.tts` DB row
 * counts as choice (any dashboard TTS save writes one, so an explicit Edge
 * selection sticks). `enabled` is passed through untouched — the hosted
 * default never switches speech on, it only picks who speaks once the user
 * turns it on.
 */
export function effectiveTtsForBinding(
  config: JarvisConfig,
  loadStored: (section: 'stt' | 'tts') => unknown = loadUserSection,
): TTSConfig | undefined {
  if (!hasUsejarvisAi(config)) return config.tts;
  if (storedProviderChoice(loadStored('tts'))) return config.tts;
  return { ...(config.tts ?? { enabled: false }), provider: 'usejarvis' };
}
