import type { JarvisConfig, RealtimeReasoningEffort } from './types.ts';
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
export type ResolvedRealtimeVoice = {
  apiKey: string;
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
 * Decision (see docs/GPT_REALTIME_2_INTEGRATION.md): entitlement is simply
 * "user has an OpenAI provider configured under llm.providers". The realtime
 * session reuses that key - there is no separate realtime credential. This
 * NEVER throws - when realtime is unavailable it returns `{ ok: false, reason }`
 * so the caller can log a warning and fall back to the standard STT -> LLM ->
 * TTS pipeline.
 *
 * Key resolution: scan `llm.providers` for a `kind: 'openai'` entry, then
 * legacy `llm.openai.api_key` (loader migrates this into providers but keeps
 * the raw block around until YAML write), then env (JARVIS_OPENAI_KEY /
 * OPENAI_API_KEY).
 */
export function resolveRealtimeVoice(
  config: JarvisConfig,
  env: Record<string, string | undefined> = process.env,
): RealtimeVoiceResolution {
  const rt = config.voice?.realtime;

  if (!rt?.enabled) {
    return { ok: false, reason: 'Realtime voice disabled (voice.realtime.enabled is false)' };
  }

  const apiKey = (
    findOpenAIProviderKey(config) ||
    config.llm?.openai?.api_key ||
    env.JARVIS_OPENAI_KEY ||
    env.OPENAI_API_KEY ||
    ''
  ).trim();

  if (!apiKey) {
    return {
      ok: false,
      reason:
        'Realtime voice enabled but no OpenAI key resolved ' +
        '(add an OpenAI provider under Settings > LLM, or set JARVIS_OPENAI_KEY)',
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
