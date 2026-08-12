/**
 * Keychain-backed credentials for the user-owned config sections that carry
 * one: `stt`, `tts` (API keys) and `channels` (bot tokens).
 *
 * Same contract llm-settings.ts established for LLM provider credentials: the
 * vault `settings` table is PLAINTEXT, so a credential must never be
 * serialized into the `cfg.<section>` row. They live in the encrypted keychain
 * (~/.jarvis/.secrets.enc, AES-256-GCM) under `<section>.<block>.<field>`, and
 * are injected back into the in-memory config at hydration time so every
 * consumer (createSTTProvider, the Telegram/Discord adapters, the workflow
 * credential sources, the GET redaction checks…) keeps reading
 * `config.channels.telegram.bot_token` exactly as before.
 *
 * user-settings.ts is the sole caller: routing strip/persist/inject through
 * saveUserSection + mergeUserSettingsIntoConfig + importLegacyUserSettings
 * means every writer (config routes, onboarding, voice intents) is covered
 * without touching each call site.
 */

import { getSecret, setSecrets } from '../vault/keychain.ts';

/**
 * A credential could not be written to the keychain, so the section was not
 * saved. Distinct from a bad request: HTTP handlers must report it as a
 * server-side storage failure, not as "invalid body".
 */
export class SecretStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretStorageError';
  }
}

/**
 * Per section: the sub-blocks that hold a credential, and the field it lives
 * in. Every secret-bearing field of ChannelConfig/STTConfig/TTSConfig must be
 * listed here — one missed entry is a key written to the DB in the clear.
 */
const SECRET_BLOCKS = {
  stt: { field: 'api_key', blocks: ['openai', 'groq', 'sarvam'] },
  tts: { field: 'api_key', blocks: ['elevenlabs', 'sarvam'] },
  channels: { field: 'bot_token', blocks: ['telegram', 'discord'] },
} as const;

export type SecretSection = keyof typeof SECRET_BLOCKS;

export const SECRET_SECTIONS = Object.keys(SECRET_BLOCKS) as SecretSection[];

type AnyRec = Record<string, unknown>;

export function isSecretSection(section: string): section is SecretSection {
  return section in SECRET_BLOCKS;
}

/** Keychain key for one block, e.g. `channels.telegram.bot_token`. */
function keychainKey(section: SecretSection, block: string): string {
  return `${section}.${block}.${SECRET_BLOCKS[section].field}`;
}

function asRecord(value: unknown): AnyRec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRec : null;
}

/** The credential of one sub-block, or undefined when absent/blank. */
function readSecret(sectionValue: AnyRec | null, section: SecretSection, block: string): string | undefined {
  const sub = asRecord(sectionValue?.[block]);
  const value = sub?.[SECRET_BLOCKS[section].field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** True when the value still carries an inline credential (pre-keychain row). */
export function hasInlineSecret(section: SecretSection, value: unknown): boolean {
  const rec = asRecord(value);
  if (!rec) return false;
  return SECRET_BLOCKS[section].blocks.some((block) => readSecret(rec, section, block) !== undefined);
}

/**
 * Copy of the section value with every credential removed - what gets
 * persisted to the settings table. Empty sub-blocks are KEPT (`{}` instead of
 * dropped) so a block that held nothing else still signals "configured", and
 * injectSectionSecrets can fill it back in.
 */
export function stripSectionSecrets<T>(section: SecretSection, value: T): T {
  const rec = asRecord(value);
  if (!rec) return value;
  const { field, blocks } = SECRET_BLOCKS[section];
  const out: AnyRec = { ...rec };
  for (const block of blocks) {
    const sub = asRecord(out[block]);
    if (!sub) continue;
    const { [field]: _omit, ...rest } = sub;
    void _omit;
    out[block] = rest;
  }
  return out as T;
}

/**
 * Write the section's credentials to the keychain. The caller always passes
 * the WHOLE section (saveUserSection semantics), so the value is
 * authoritative: a sub-block that is gone - or whose credential was cleared to
 * '' - has its stored secret deleted rather than left behind as a stale
 * credential.
 *
 * Returns false when the keychain could not be written (unwritable home dir,
 * full disk…). Callers MUST NOT persist the stripped section in that case:
 * the credential would be gone from the settings row AND absent from the
 * keychain, i.e. destroyed. Errors are reported, not thrown, so the caller
 * decides.
 */
export function persistSectionSecrets(section: SecretSection, value: unknown): boolean {
  const rec = asRecord(value);
  const entries: Record<string, string | null> = {};
  for (const block of SECRET_BLOCKS[section].blocks) {
    entries[keychainKey(section, block)] = readSecret(rec, section, block) ?? null;
  }
  try {
    setSecrets(entries);
    return true;
  } catch (err) {
    console.error(`[SectionSecrets] Failed to persist ${section} credential(s) to the keychain:`, err);
    return false;
  }
}

/**
 * Merge the stored credentials back into a hydrated section value. Returns the
 * same reference when there is nothing to inject. The caller decides WHICH
 * sections to hydrate (mergeUserSettingsIntoConfig gates on the section having
 * a settings row) - the object check here is only a shape guard, since
 * DEFAULT_CONFIG always defines these sections.
 */
export function injectSectionSecrets<T>(section: SecretSection, value: T): T {
  const rec = asRecord(value);
  if (!rec) return value;
  const { field, blocks } = SECRET_BLOCKS[section];
  let out: AnyRec | null = null;
  for (const block of blocks) {
    let secret: string | null = null;
    try {
      secret = getSecret(keychainKey(section, block));
    } catch (err) {
      console.warn(`[SectionSecrets] Failed to read ${keychainKey(section, block)}:`, err);
    }
    if (!secret) continue;
    out ??= { ...rec };
    out[block] = { ...asRecord(out[block]), [field]: secret };
  }
  return (out ?? rec) as T;
}
