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
import type { STTConfig, TTSConfig } from '../config/types.ts';

type AnyRec = Record<string, unknown>;

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
