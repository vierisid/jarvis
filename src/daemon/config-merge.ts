/**
 * Shared merge helpers for STT/TTS config patches.
 *
 * Used by /api/config/stt, /api/config/tts, and /api/onboarding/setup so the
 * preserved-key + sub-block shape lives in one place. Without this, the
 * onboarding endpoint was a near-verbatim copy of /api/config/stt POST and
 * any future change to the preserved-provider list had to be made in
 * lockstep or the omitted endpoint would silently drop keys.
 *
 * Both helpers:
 *  - Deep-merge known sub-blocks so a partial patch (e.g. just `model`)
 *    doesn't wipe sibling fields (e.g. `api_key`).
 *  - Preserve `api_key` on cloud sub-blocks when the incoming patch omits it
 *    or sends an empty string — required because the GET endpoints redact
 *    keys, so a UI round-trip never sees the real value.
 *  - Shallow-merge remaining top-level fields (provider, enabled, voice…).
 */
import type { STTConfig, TTSConfig, VoiceConfig } from '../config/types.ts';
import { IMPACT_MAP } from '../roles/authority.ts';

type AnyRec = Record<string, unknown>;

const VALID_WAKE_ENGINES = ['openwakeword', 'webspeech', 'auto'];
const VALID_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
/** Known action categories — a blocked-category typo silently blocks nothing. */
const VALID_ACTION_CATEGORIES = Object.keys(IMPACT_MAP);
/** Upper bound on a single realtime session (minutes) accepted from the API. */
const MAX_SESSION_MINUTES_LIMIT = 1440;

export type VoicePatchValidation =
  | { ok: true; patch: AnyRec }
  | { ok: false; error: string };

/**
 * Validate an untrusted `/api/config/voice` POST body before it is merged and
 * persisted. Only fields that are present are checked; unknown top-level keys
 * are rejected so garbage can't be written to disk. Mirrors the validation
 * rigor of the other config POST routes (which the original handler lacked).
 */
export function validateVoicePatch(body: unknown): VoicePatchValidation {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const patch = body as AnyRec;

  for (const key of Object.keys(patch)) {
    if (key !== 'wake_engine' && key !== 'realtime') {
      return { ok: false, error: `Unknown voice config field: ${key}` };
    }
  }

  if ('wake_engine' in patch) {
    if (typeof patch.wake_engine !== 'string' || !VALID_WAKE_ENGINES.includes(patch.wake_engine)) {
      return { ok: false, error: `wake_engine must be one of: ${VALID_WAKE_ENGINES.join(', ')}` };
    }
  }

  if ('realtime' in patch) {
    const rt = patch.realtime;
    if (typeof rt !== 'object' || rt === null || Array.isArray(rt)) {
      return { ok: false, error: 'realtime must be an object' };
    }
    const r = rt as AnyRec;

    if ('enabled' in r && typeof r.enabled !== 'boolean') {
      return { ok: false, error: 'realtime.enabled must be a boolean' };
    }
    for (const strField of ['model', 'voice'] as const) {
      if (strField in r && typeof r[strField] !== 'string') {
        return { ok: false, error: `realtime.${strField} must be a string` };
      }
    }
    if ('reasoning_effort' in r &&
        (typeof r.reasoning_effort !== 'string' || !VALID_REASONING_EFFORTS.includes(r.reasoning_effort))) {
      return { ok: false, error: `realtime.reasoning_effort must be one of: ${VALID_REASONING_EFFORTS.join(', ')}` };
    }
    if ('max_session_minutes' in r) {
      const n = r.max_session_minutes;
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > MAX_SESSION_MINUTES_LIMIT) {
        return { ok: false, error: `realtime.max_session_minutes must be a number between 1 and ${MAX_SESSION_MINUTES_LIMIT}` };
      }
    }
    if ('monthly_budget_usd' in r) {
      const n = r.monthly_budget_usd;
      if (n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n < 0)) {
        return { ok: false, error: 'realtime.monthly_budget_usd must be a non-negative number or null' };
      }
    }
    if ('blocked_categories' in r) {
      if (!Array.isArray(r.blocked_categories) || r.blocked_categories.some((c) => typeof c !== 'string')) {
        return { ok: false, error: 'realtime.blocked_categories must be an array of strings' };
      }
      const unknown = r.blocked_categories.filter((c) => !VALID_ACTION_CATEGORIES.includes(c as string));
      if (unknown.length > 0) {
        return { ok: false, error: `realtime.blocked_categories has unknown categories: ${unknown.join(', ')}` };
      }
    }
  }

  return { ok: true, patch };
}

function mergeCloudSubBlock(
  existing: AnyRec | undefined,
  incoming: AnyRec,
): AnyRec {
  return {
    ...existing,
    ...incoming,
    api_key: (incoming.api_key as string) || (existing?.api_key as string) || '',
  };
}

/**
 * Merge a partial STT patch into the existing config. Cloud providers
 * (openai/groq/sarvam) preserve their api_key when the patch omits it.
 * Local block is deep-merged so a partial update (e.g. just `endpoint`)
 * doesn't wipe `model` or `server_type`.
 */
export function mergeSTTConfig(
  existing: STTConfig | undefined,
  incoming: AnyRec,
): STTConfig {
  const base: STTConfig = existing ?? { provider: 'openai' };
  const patch = { ...incoming };
  const merged: AnyRec = { ...base };

  for (const p of ['openai', 'groq', 'sarvam'] as const) {
    const inc = patch[p] as AnyRec | undefined;
    if (inc) {
      merged[p] = mergeCloudSubBlock((base as AnyRec)[p] as AnyRec | undefined, inc);
      delete patch[p];
    }
  }

  const incLocal = patch.local as AnyRec | undefined;
  if (incLocal) {
    const existingLocal = (base as AnyRec).local as AnyRec | undefined;
    merged.local = { ...existingLocal, ...incLocal };
    delete patch.local;
  }

  return { ...merged, ...patch } as STTConfig;
}

/**
 * Merge a partial TTS patch into the existing config. ElevenLabs and Sarvam
 * sub-blocks preserve their api_key when the patch omits it.
 */
export function mergeTTSConfig(
  existing: TTSConfig | undefined,
  incoming: AnyRec,
): TTSConfig {
  const base: TTSConfig = existing ?? { enabled: false };
  const patch = { ...incoming };
  const merged: AnyRec = { ...base };

  for (const p of ['elevenlabs', 'sarvam'] as const) {
    const inc = patch[p] as AnyRec | undefined;
    if (inc) {
      merged[p] = mergeCloudSubBlock((base as AnyRec)[p] as AnyRec | undefined, inc);
      delete patch[p];
    }
  }

  return { ...merged, ...patch } as TTSConfig;
}

/**
 * Merge a partial voice patch into the existing config. The `realtime`
 * sub-block (premium gpt-realtime-2) is deep-merged so a partial update (e.g.
 * just `reasoning_effort`) doesn't wipe siblings. It holds no secret of its
 * own - the realtime session reuses the OpenAI provider key from llm.providers
 * (see resolveRealtimeVoice) - so a plain shallow object merge is enough.
 */
export function mergeVoiceConfig(
  existing: VoiceConfig | undefined,
  incoming: AnyRec,
): VoiceConfig {
  const base: VoiceConfig = existing ?? { wake_engine: 'openwakeword' };
  const patch = { ...incoming };
  const merged: AnyRec = { ...base };

  const incRealtime = patch.realtime as AnyRec | undefined;
  if (incRealtime) {
    const baseRealtime = (base as AnyRec).realtime as AnyRec | undefined;
    merged.realtime = { ...baseRealtime, ...incRealtime };
    delete patch.realtime;
  }

  return { ...merged, ...patch } as VoiceConfig;
}
