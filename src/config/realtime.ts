import type { JarvisConfig, RealtimeReasoningEffort, RealtimeVoiceConfig } from './types.ts';
import type { RealtimeEnablement } from '../daemon/usejarvis-ai.ts';
import { IMPACT_MAP, type ActionCategory } from '../roles/authority.ts';

/**
 * Safe-by-default backstop for the realtime auto-approve bridge: every action
 * whose impact is `destructive` (irreversible or costly — payments, deletes,
 * shell exec, software installs, settings changes, agent termination) stays
 * BLOCKED unless the user explicitly opts it back in via
 * `voice.realtime.blocked_categories`. Without this, an open mic + auto-approve
 * could execute a payment or `rm`-class tool with no human confirmation. See
 * docs/GPT_REALTIME_2_INTEGRATION.md §4 Phase 3.
 */
export const DEFAULT_BLOCKED_CATEGORIES: ActionCategory[] = (Object.keys(IMPACT_MAP) as ActionCategory[])
  .filter((cat) => IMPACT_MAP[cat] === 'destructive');

/**
 * Resolved, ready-to-use realtime voice settings. Produced by
 * `resolveRealtimeVoice` once gating + key resolution have passed.
 */
/** OpenAI's realtime websocket endpoint (the BYO-key path). */
export const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';

export type ResolvedRealtimeVoice = {
  apiKey: string;
  /** Which backend serves the session — drives usage attribution and whether
   * the LOCAL estimate-based budget applies (hosted spend is metered and
   * enforced by the platform proxy, not the $/minute guess). */
  provider: 'openai' | 'usejarvis_ai';
  /** Websocket endpoint (model appended as a query param at connect). */
  url: string;
  /** Hosted only: the key-scoped catalog endpoint — the session starter
   * pre-checks that uj-realtime is included in the plan before dialing. */
  modelsUrl?: string;
  model: string;
  voice?: string;
  reasoningEffort: RealtimeReasoningEffort;
  maxSessionMinutes: number;
  monthlyBudgetUsd?: number;
  blockedCategories: string[];
};

export type RealtimeVoiceResolution =
  | { ok: true; resolved: ResolvedRealtimeVoice }
  | { ok: false; reason: string };

const DEFAULT_MODEL = 'gpt-realtime-2';
const DEFAULT_EFFORT: RealtimeReasoningEffort = 'low';
const DEFAULT_MAX_SESSION_MINUTES = 10;
const VALID_EFFORTS: RealtimeReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];

/**
 * Would a realtime session run on the PLAN rather than on a user's own key?
 *
 * The twin of `readUsejarvisAiBlock` (daemon/usejarvis-ai.ts) and required to
 * agree with it on every input — `realtime-enablement.test.ts` pins that over a
 * table of block shapes. They are separate functions rather than one because
 * this module must not take a runtime dependency on the daemon layer; the test
 * is what keeps the duplication honest.
 *
 * The single predicate behind the money rule, exported so the settings route
 * cannot drift from it. Deliberately a function of the hosted block ALONE —
 * not of whether realtime is currently switched on, and not of whether the
 * plan actually includes the alias:
 *
 *  - Independent of enablement, because the settings tab's billing copy renders
 *    next to the toggle, i.e. to someone deciding whether to switch it ON.
 *    Deriving it from the current resolution made it false for a hosted tenant
 *    who had realtime off, so they were told they would be "billed by OpenAI,
 *    ~$0.30/min" for something their plan would serve for nothing — the same
 *    false-billing statement this rule exists to prevent, pointed the other way.
 *  - Independent of the plan's contents, because "who would serve it" and "may
 *    you have it" are different questions. The catalog gate answers the second,
 *    and a tenant whose plan excludes realtime still is not billed personally —
 *    they simply do not get it.
 */
export function realtimeServedByPlan(config: JarvisConfig): boolean {
  const block = config.usejarvis_ai;
  if (!block || typeof block !== 'object') return false;
  const { base_url, api_key } = block as Record<string, unknown>;
  // Typed, not just present. The block is YAML the provisioner wrote, so a
  // value can be any shape at runtime whatever the TS type says — an unquoted
  // scalar parses as a number or a boolean, which is the exact case
  // readUsejarvisAiBlock guards against and warns about. Reaching straight for
  // `.trim()` threw a TypeError there, and this predicate is called from the
  // settings route OUTSIDE its try/catch, so one mistyped line in config.yaml
  // took the whole Voice tab down with a 500.
  if (typeof base_url !== 'string' || typeof api_key !== 'string') return false;
  // Trailing slashes stripped before the emptiness test, matching
  // normalizeBlockUrl — otherwise a base_url of "///" reads as present here
  // and as absent to hasUsejarvisAi, and the two must never disagree about
  // whether this install is hosted.
  return base_url.trim().replace(/\/+$/, '') !== '' && api_key.trim() !== '';
}

/**
 * Find the first OpenAI provider key in `llm.providers`. A provider entry's
 * effective kind is `entry.kind ?? name` (matches `instantiateProvider`), so a
 * user-named instance like `"openai-personal"` with `kind: 'openai'` is
 * accepted - as is the default-named `"openai"` entry without an explicit kind.
 */
function findOpenAIProviderKey(config: JarvisConfig): string {
  const providers = config.llm?.providers;
  if (!providers) return '';
  for (const [name, entry] of Object.entries(providers)) {
    if (!entry) continue;
    const kind = entry.kind ?? name;
    if (kind !== 'openai') continue;
    const key = (entry.api_key ?? '').trim();
    if (key) return key;
  }
  return '';
}

/**
 * Gate + resolve the premium realtime voice mode.
 *
 * Entitlement is no longer "the user has an OpenAI provider configured", which
 * is what docs/GPT_REALTIME_2_INTEGRATION.md still describes. There are two
 * answers now, and which applies is decided by the install:
 *
 *  - HOSTED (a complete `usejarvis_ai` block): the plan serves it through the
 *    proxy's `uj-realtime` alias, and the user's own OpenAI key is never read —
 *    see realtimeServedByPlan above for why that holds whoever asked for the
 *    session. Whether the plan actually includes the alias is a separate
 *    question, answered per session by daemon/realtime-gate.ts.
 *  - SELF-HOSTED: unchanged. Scan `llm.providers` for a `kind: 'openai'` entry
 *    and reuse its key (injected from the keychain at startup); LLM credentials
 *    live only in the DB + keychain, with no config.yaml or env fallback. There
 *    is no separate realtime credential.
 *
 * NEVER throws — when realtime is unavailable it returns `{ ok: false, reason }`
 * so the caller can log a warning and fall back to the standard STT -> LLM ->
 * TTS pipeline.
 */
export function resolveRealtimeVoice(
  config: JarvisConfig,
  /**
   * Whether realtime is switched on, and on WHOSE authority
   * (daemon/usejarvis-ai.ts realtimeEnablement).
   *
   * Only `off` is read here now — a hosted install resolves to the plan's alias
   * whether the tenant asked or not (see the key selection below), because
   * scoping that rule to `hosted-default` left the same billing harm reachable
   * by toggling realtime off and on again.
   *
   * Passed IN rather than read here so this stays a pure function of config —
   * the binding view needs the vault DB to tell an explicit "off" from the
   * default false, and this module is imported by paths that have no DB.
   * Defaults to the raw config value, which is what a caller without the DB
   * (and every existing test) should see.
   */
  enablement: RealtimeEnablement = config.voice?.realtime?.enabled === true ? 'user-on' : 'off',
): RealtimeVoiceResolution {
  // Every read below is defaulted, because the block can be legitimately
  // ABSENT now: a hosted tenant who never opened the Voice tab has no stored
  // `voice` section at all, and that is precisely the tenant this path exists
  // to serve. Previously `!rt?.enabled` returned first and narrowed it away.
  const rt: Partial<RealtimeVoiceConfig> = config.voice?.realtime ?? {};

  if (enablement === 'off') {
    return { ok: false, reason: 'Realtime voice disabled (voice.realtime.enabled is false)' };
  }

  // On a HOSTED install the plan serves realtime, whoever asked for it.
  //
  // Gating this on `hosted-default` alone was not enough: a hosted tenant with
  // a personal OpenAI key (allowed — hosted installs permit BYO providers for
  // chat) who merely toggled realtime off and on again became `user-on`, at
  // which point their own key won and every turn was billed to them at
  // ~$0.30/min, ungated and unbudgeted — the same harm, one innocent click
  // away, while the settings tab told them it was included in their plan.
  //
  // So BYO is read only where there is no hosted block to serve the session.
  // The cost is a niche capability: a hosted tenant whose plan EXCLUDES
  // realtime can no longer spend their own key on it. That is the right trade
  // — losing a rare feature beats silently charging someone's personal card —
  // and it makes one rule true everywhere: on a hosted install, realtime is
  // either included in your plan or it does not run.
  const servedByPlan = realtimeServedByPlan(config);
  // Read only where the plan cannot serve it. On a hosted install this stays
  // '' and is never consulted — the branch below returns first — which is the
  // whole money rule in one line.
  const apiKey = servedByPlan ? '' : findOpenAIProviderKey(config).trim();

  if (servedByPlan) {
    // The platform block is live (realtimeServedByPlan checked both fields are
    // non-empty strings, which is what the assertions below rest on), so the
    // proxy serves realtime under the plan-gated uj-realtime alias and the
    // user's own key is never read.
    const hosted = config.usejarvis_ai;
    // Normalize through URL parsing rather than string surgery: the block is
    // provisioner-written, and each of these typo classes previously derailed
    // the ws(s) derivation into an undialable URL — an uppercase scheme
    // (`HTTPS://…` → prefix rewrite misses), a missing scheme
    // (`llm.usejarvis.host` → `llm.usejarvis.host/v1/realtime`, no ws://),
    // trailing slashes, and an uppercase `/V1` suffix (`…/V1/v1/realtime`).
    // A missing scheme reads as https — the only transport the proxy serves.
    const raw = hosted!.base_url!.trim();
    let httpBase: string;
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, reason: `usejarvis_ai.base_url has unsupported scheme: ${url.protocol}` };
      }
      const path = url.pathname.replace(/\/+$/, '');
      const origin = `${url.protocol}//${url.host}${path}`;
      httpBase = /\/v1$/i.test(origin) ? origin : `${origin}/v1`;
    } catch {
      return { ok: false, reason: `usejarvis_ai.base_url is not a valid URL: ${raw}` };
    }
    return {
      ok: true,
      resolved: {
        apiKey: hosted!.api_key!.trim(),
        provider: 'usejarvis_ai',
        url: `${httpBase.replace(/^http/, 'ws')}/realtime`,
        modelsUrl: `${httpBase}/models`,
        // The proxy resolves the actual model per plan; the alias is fixed.
        model: 'uj-realtime',
        voice: rt.voice,
        reasoningEffort: VALID_EFFORTS.includes(rt.reasoning_effort as RealtimeReasoningEffort)
          ? (rt.reasoning_effort as RealtimeReasoningEffort)
          : DEFAULT_EFFORT,
        maxSessionMinutes:
          typeof rt.max_session_minutes === 'number' && rt.max_session_minutes > 0
            ? rt.max_session_minutes
            : DEFAULT_MAX_SESSION_MINUTES,
        // Deliberately unset: the local $/minute ESTIMATE guard must not
        // double-block hosted sessions — the proxy meters real spend and
        // enforces the plan windows itself.
        monthlyBudgetUsd: undefined,
        blockedCategories: Array.isArray(rt.blocked_categories)
          ? rt.blocked_categories
          : DEFAULT_BLOCKED_CATEGORIES,
      },
    };
  }

  if (!apiKey) {
    return {
      ok: false,
      reason:
        'Realtime voice enabled but no OpenAI key resolved ' +
        '(add an OpenAI provider under Settings > LLM)',
    };
  }

  const reasoningEffort = VALID_EFFORTS.includes(rt.reasoning_effort as RealtimeReasoningEffort)
    ? (rt.reasoning_effort as RealtimeReasoningEffort)
    : DEFAULT_EFFORT;

  const maxSessionMinutes =
    typeof rt.max_session_minutes === 'number' && rt.max_session_minutes > 0
      ? rt.max_session_minutes
      : DEFAULT_MAX_SESSION_MINUTES;

  return {
    ok: true,
    resolved: {
      apiKey,
      provider: 'openai',
      url: OPENAI_REALTIME_URL,
      model: rt.model?.trim() || DEFAULT_MODEL,
      voice: rt.voice,
      reasoningEffort,
      maxSessionMinutes,
      monthlyBudgetUsd:
        typeof rt.monthly_budget_usd === 'number' && rt.monthly_budget_usd > 0
          ? rt.monthly_budget_usd
          : undefined,
      // Unconfigured -> safe destructive-category backstop. An explicit array
      // (even empty) is the user's deliberate choice and is honored as-is.
      blockedCategories: Array.isArray(rt.blocked_categories)
        ? rt.blocked_categories
        : DEFAULT_BLOCKED_CATEGORIES,
    },
  };
}
