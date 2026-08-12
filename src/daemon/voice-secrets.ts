/**
 * Keychain-backed API keys for the `stt` and `tts` config sections.
 *
 * Same contract llm-settings.ts established for LLM provider credentials: the
 * vault `settings` table is PLAINTEXT, so an api_key must never be serialized
 * into the `cfg.stt` / `cfg.tts` rows. The keys live in the encrypted keychain
 * (~/.jarvis/.secrets.enc, AES-256-GCM) under `stt.<block>.api_key` /
 * `tts.<block>.api_key`, and are injected back into the in-memory config at
 * hydration time so every consumer (createSTTProvider, createTTSProvider,
 * /api/tts/voices, the GET redaction checks…) keeps reading
 * `config.stt.openai.api_key` exactly as before.
 *
 * user-settings.ts is the sole caller: routing strip/persist/inject through
 * saveUserSection + mergeUserSettingsIntoConfig + importLegacyUserSettings
 * means every writer (config routes, onboarding, voice intents) is covered
 * without touching each call site.
 */

import { getSecret, setSecrets } from '../vault/keychain.ts';

/** Sub-blocks of each section that carry an `api_key`. */
const VOICE_SECRET_BLOCKS = {
  stt: ['openai', 'groq', 'sarvam'],
  tts: ['elevenlabs', 'sarvam'],
} as const;

export const VOICE_SECRET_SECTIONS = Object.keys(VOICE_SECRET_BLOCKS) as VoiceSecretSection[];

export type VoiceSecretSection = keyof typeof VOICE_SECRET_BLOCKS;

type AnyRec = Record<string, unknown>;

export function isVoiceSecretSection(section: string): section is VoiceSecretSection {
  return section in VOICE_SECRET_BLOCKS;
}

/** Keychain key for one section/sub-block pair, e.g. `tts.elevenlabs.api_key`. */
function keychainKey(section: VoiceSecretSection, block: string): string {
  return `${section}.${block}.api_key`;
}

function asRecord(value: unknown): AnyRec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRec : null;
}

/** The api_key of one sub-block, or undefined when absent/blank/not a string. */
function readKey(sectionValue: AnyRec | null, block: string): string | undefined {
  const sub = asRecord(sectionValue?.[block]);
  const key = sub?.['api_key'];
  return typeof key === 'string' && key !== '' ? key : undefined;
}

/** True when the value still carries an inline api_key (pre-keychain row). */
export function hasInlineVoiceSecret(section: VoiceSecretSection, value: unknown): boolean {
  const rec = asRecord(value);
  if (!rec) return false;
  return VOICE_SECRET_BLOCKS[section].some((block) => readKey(rec, block) !== undefined);
}

/**
 * Copy of the section value with every api_key removed - what gets persisted
 * to the settings table. Empty sub-blocks are KEPT (`{}` instead of dropped)
 * so a block that held nothing but a key still signals "configured", and
 * injectVoiceSecrets can fill it back in.
 */
export function stripVoiceSecrets<T>(section: VoiceSecretSection, value: T): T {
  const rec = asRecord(value);
  if (!rec) return value;
  const out: AnyRec = { ...rec };
  for (const block of VOICE_SECRET_BLOCKS[section]) {
    const sub = asRecord(out[block]);
    if (!sub) continue;
    const { api_key: _omit, ...rest } = sub;
    void _omit;
    out[block] = rest;
  }
  return out as T;
}

/**
 * Write the section's api_keys to the keychain. The caller always passes the
 * WHOLE section (saveUserSection semantics), so the value is authoritative:
 * a sub-block that is gone - or whose key was cleared to '' - has its stored
 * secret deleted rather than left behind as a stale credential.
 *
 * Returns false when the keychain could not be written (unwritable home dir,
 * full disk…). Callers MUST NOT persist the stripped section in that case:
 * the key would be gone from the settings row AND absent from the keychain,
 * i.e. destroyed. Errors are reported, not thrown, so the caller decides.
 */
export function persistVoiceSecrets(section: VoiceSecretSection, value: unknown): boolean {
  const rec = asRecord(value);
  const entries: Record<string, string | null> = {};
  for (const block of VOICE_SECRET_BLOCKS[section]) {
    entries[keychainKey(section, block)] = readKey(rec, block) ?? null;
  }
  try {
    setSecrets(entries);
    return true;
  } catch (err) {
    console.error(`[VoiceSecrets] Failed to persist ${section} API key(s) to the keychain:`, err);
    return false;
  }
}

/**
 * Merge the stored secrets back into a hydrated section value. Returns the
 * same reference when there is nothing to inject. The caller decides WHICH
 * sections to hydrate (mergeUserSettingsIntoConfig gates on the section having
 * a settings row) - the object check here is only a shape guard, since
 * DEFAULT_CONFIG always defines `stt`/`tts`.
 */
export function injectVoiceSecrets<T>(section: VoiceSecretSection, value: T): T {
  const rec = asRecord(value);
  if (!rec) return value;
  let out: AnyRec | null = null;
  for (const block of VOICE_SECRET_BLOCKS[section]) {
    let key: string | null = null;
    try {
      key = getSecret(keychainKey(section, block));
    } catch (err) {
      console.warn(`[VoiceSecrets] Failed to read ${keychainKey(section, block)}:`, err);
    }
    if (!key) continue;
    out ??= { ...rec };
    out[block] = { ...asRecord(out[block]), api_key: key };
  }
  return (out ?? rec) as T;
}
