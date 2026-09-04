/**
 * User-owned settings: DB persistence for every config section the user (not
 * the host) controls — personality, voice, authority, channels, onboarding
 * state, and the rest of `USER_OWNED_SECTIONS`.
 *
 * This generalizes the pattern llm-settings.ts established for the `llm`
 * block: the vault DB settings store is the sole authority, config.yaml
 * contributes nothing (loadConfig discards user sections), and the daemon
 * merges the stored values into the in-memory config at boot. File-provided
 * sections import on first boot and re-import whenever the FILE value changes
 * (change-tracked; see importLegacyUserSettings). config.yaml is
 * thereby reduced to a read-only SYSTEM config (daemon.*, auth, google) that
 * the brain never writes — in hosted mode it is root-owned and the server
 * manages it.
 *
 * Layout: one settings row per section, key `cfg.<section>`, value JSON.
 *
 * Secrets are the one exception to "the row holds the section": the settings
 * table is plaintext, so the `stt`/`tts` API keys and the `channels` bot
 * tokens are split out to the encrypted keychain on the way in and injected
 * back on the way out (see section-secrets.ts) — the same treatment
 * llm-settings.ts gives provider keys.
 *
 * Requires the vault DB (initDatabase) to be open, same as llm-settings.
 */

import { createHash } from 'node:crypto';
import { getSetting, setSetting } from '../vault/settings.ts';
import { deepMerge } from '../config/loader.ts';
import { mergeSTTConfig, mergeTTSConfig, mergeVoiceConfig } from './config-merge.ts';
import {
  SECRET_SECTIONS,
  SecretStorageError,
  hasInlineSecret,
  injectSectionSecrets,
  isSecretSection,
  persistSectionSecrets,
  stripSectionSecrets,
} from './section-secrets.ts';
import {
  DEFAULT_CONFIG,
  USER_OWNED_SECTIONS,
  WORKFLOW_SYSTEM_KEYS,
  type JarvisConfig,
  type STTConfig,
  type VoiceConfig,
  type TTSConfig,
  type UserOwnedSection,
} from '../config/types.ts';

const CFG_PREFIX = 'cfg.';

function settingKey(section: UserOwnedSection): string {
  return `${CFG_PREFIX}${section}`;
}

/**
 * Write choke point for hot reload: every saveUserSection/saveGoogleSettings
 * notifies this listener AFTER the DB write, so the daemon's
 * SettingsReloadCoordinator can run the section's appliers regardless of who
 * saved (HTTP route, voice intent, pebble toggle). The daemon injects it at
 * boot; tests and CLI tools leave it null. Listener errors never fail the
 * save.
 */
let sectionSavedListener: ((section: UserOwnedSection | 'google') => void) | null = null;

export function setSectionSavedListener(
  fn: ((section: UserOwnedSection | 'google') => void) | null,
): void {
  sectionSavedListener = fn;
}

function notifySectionSaved(section: UserOwnedSection | 'google'): void {
  try {
    sectionSavedListener?.(section);
  } catch (err) {
    console.error(`[UserSettings] Section-saved listener failed for '${section}':`, err);
  }
}

/**
 * Persist one section to the DB. Callers mutate the in-memory config first,
 * then persist that section — the write is per-section, so there is no
 * load-modify-save race across unrelated sections (which is what the old
 * `loadConfig -> mutate -> saveConfig` dance existed to avoid).
 *
 * `stt`/`tts`/`channels` carry credentials. The settings table is plaintext,
 * so those go to the encrypted keychain and the row is written stripped —
 * same split llm-settings.ts uses for provider credentials. Callers always
 * pass the live in-memory section (which mergeUserSettingsIntoConfig hydrated
 * with the stored credentials), so nothing is lost by the round-trip.
 *
 * THROWS when the keychain write fails. Writing the stripped row anyway would
 * destroy the credential — absent from the keychain, erased from the row — and
 * report success while doing it. Failing leaves both stores as they were.
 */
export function saveUserSection<K extends UserOwnedSection>(
  section: K,
  value: JarvisConfig[K],
): void {
  let stored: unknown = value;
  if (isSecretSection(section)) {
    if (!persistSectionSecrets(section, value)) {
      throw new SecretStorageError(`Could not store the ${section} credential(s) in the encrypted keychain; ${section} settings were NOT saved`);
    }
    stored = stripSectionSecrets(section, value);
  }
  setSetting(settingKey(section), JSON.stringify(stored ?? null));
  notifySectionSaved(section);
}

/**
 * Persist a partial STT/TTS patch by merging it over the STORED row — never
 * over the in-memory merged section. The in-memory value carries
 * DEFAULT_CONFIG fills (stt provider 'openai'; tts provider 'edge', voice,
 * rate, ...), and persisting those would stamp a provider choice the user
 * never made into the DB row — the exact signal effectiveSttForBinding /
 * effectiveTtsForBinding read to decide whether the user is "silent" (hosted
 * installs default silent users to the included Usejarvis AI voice stack).
 *
 * EVERY save path for these two sections must go through here (dashboard
 * routes, onboarding setup, voice commands): one path calling
 * saveUserSection with the merged in-memory section re-introduces the stamp.
 * Callers update the in-memory config separately for runtime use.
 *
 * The stored row is STRIPPED (credentials live in the encrypted keychain), so
 * the merge base is hydrated via injectSectionSecrets first — saveUserSection
 * re-runs the secret split on the way out, and persistSectionSecrets treats an
 * absent credential as "delete it". Merging over the bare stripped row would
 * therefore destroy every stored key the patch does not carry (it did, once).
 */
export function persistUserPatch(section: 'stt' | 'tts' | 'voice', patch: Record<string, unknown>): void {
  const stored = loadUserSection(section);
  // Cast, don't default: the merge helpers substitute a provider-carrying
  // default for an UNDEFINED base, which would stamp silence into the row.
  // A `{}` base merges cleanly and stays provider-free unless the patch
  // itself carries a choice.
  const usable = typeof stored === 'object' && stored !== null && !Array.isArray(stored);
  // An unusable row is about to be REPLACED, and for `voice` that erases an
  // explicit realtime decline and reverts the tenant to the hosted default.
  // The read path fails closed on corruption (loadUserSectionStrict); the write
  // path cannot, without locking someone out of their own settings — so it is
  // loud instead. Keyed on "exists but unusable" to catch both damage classes:
  // JSON that will not parse, and JSON that parses to the wrong shape. A row
  // legitimately holding `null` is not damage — saveUserSection writes that for
  // an absent section — so it is excluded rather than warned about every save.
  if (!usable && getSetting(settingKey(section)) !== null && getSetting(settingKey(section)) !== 'null') {
    console.warn(`[UserSettings] cfg.${section} is unreadable and is being REPLACED by this save; any stored choice in it is lost`);
  }
  // Secrets are injected only when a row exists (same orphan rule as
  // mergeUserSettingsIntoConfig), and only for the sections that HAVE any:
  // `voice` carries no credentials and would not even type-check here.
  const base = usable
    ? (isSecretSection(section) ? injectSectionSecrets(section, stored) : stored)
    : {};
  if (section === 'stt') {
    saveUserSection('stt', mergeSTTConfig(base as STTConfig, patch));
  } else if (section === 'tts') {
    saveUserSection('tts', mergeTTSConfig(base as TTSConfig, patch));
  } else {
    // `voice` joined this rule when hosted installs started defaulting
    // realtime ON for a silent user (usejarvis-ai.ts realtimeEnablement).
    // Merging a patch over the in-memory section stamps DEFAULT_CONFIG's
    // `realtime.enabled: false` into the row, which then reads as an explicit
    // decline — so changing the wake engine, or picking a realtime VOICE from
    // the dropdown, silently switched realtime off while the user was in the
    // middle of configuring it.
    saveUserSection('voice', mergeVoiceConfig(base as VoiceConfig, patch));
  }
}

/**
 * Sections with no credentials whose saves go through persistPlainUserPatch.
 * Deliberately narrow — add one only after checking it holds no secrets and
 * that a shallow merge is the right shape for it.
 */
type PlainPatchSection = 'awareness' | 'desktop';

/**
 * Persist a partial patch for a credential-free section, merged over the
 * STORED row rather than over the in-memory section.
 *
 * Same rule as persistUserPatch above, for a different consequence. The
 * in-memory section is DEFAULT_CONFIG deep-merged with whatever the row holds,
 * so handing it back to saveUserSection stamps today's defaults into the row as
 * though the user had chosen every one of them. From then on the row out-ranks
 * DEFAULT_CONFIG and changing a default can never reach that install — the same
 * way a fully-materialised sidecar.yaml used to pin its own defaults.
 *
 * A one-key toggle must therefore persist that one key, not the whole section
 * it happens to live in.
 */
export function persistPlainUserPatch<K extends PlainPatchSection>(
  section: K,
  patch: Partial<NonNullable<JarvisConfig[K]>>,
): void {
  const stored = loadUserSection(section);
  const usable = typeof stored === 'object' && stored !== null && !Array.isArray(stored);
  const base = usable ? (stored as Record<string, unknown>) : {};
  saveUserSection(section, { ...base, ...patch } as JarvisConfig[K]);
}

/**
 * Drop the user's explicit provider choice for a voice section, restoring
 * SILENCE — which is what the hosted defaults key off (effectiveSttForBinding
 * / effectiveTtsForBinding fill a provider-free row with the included uj
 * stack). Deliberately a delete rather than a write of 'usejarvis': recording
 * that as a choice would pin the account, so "reset to the plan default" has
 * to leave no choice at all.
 *
 * Same hydration rule as persistUserPatch: the stored row is STRIPPED, and
 * saveUserSection re-runs the secret split treating an absent credential as
 * "delete it" — forwarding the bare row would destroy every stored key on
 * the one click sold as harmless (it did, once: review pr7#1).
 *
 * Returns false when there was no stored row to clear, so the routes can say
 * "nothing to reset" instead of toasting a success that changed nothing.
 */
export function clearProviderChoice(section: 'stt' | 'tts'): boolean {
  const stored = loadUserSection(section);
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return false;
  const hydrated = injectSectionSecrets(section, stored as Record<string, unknown>);
  // `provider: ''` is the explicit "cleared" sentinel, not a deletion: a row
  // that ever held a credential keeps its sub-block (dropping it would drop
  // the keychain key on the way out), and a bare sub-block reads as intent
  // (storedProviderChoice's import heuristic) — the sentinel is what makes
  // the reset stick anyway.
  // The stored row is user intent, not a complete config — it legitimately
  // lacks fields the runtime type requires (that is the whole point of
  // silence), so the cast is the honest shape here.
  saveUserSection(section, { ...hydrated, provider: '' } as unknown as STTConfig | TTSConfig);
  return true;
}

/** Read one stored section; undefined when absent or unparseable. */
export function loadUserSection(section: UserOwnedSection): unknown {
  const raw = getSetting(settingKey(section));
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed === null ? undefined : parsed;
  } catch {
    console.warn(`[UserSettings] Corrupt JSON for ${settingKey(section)}; ignoring stored value`);
    return undefined;
  }
}

/**
 * Like `loadUserSection`, but THROWS on a row that will not parse.
 *
 * The distinction matters wherever "absent" and "damaged" lead to different
 * answers. `loadUserSection` maps both to `undefined`, which is right for a
 * merge (there is nothing to merge either way) and wrong for a decision: the
 * hosted realtime default reads an absent row as "never asked" and switches
 * realtime ON, so a declining tenant whose row corrupted would have been opted
 * back into billed audio sessions. Callers that must not make that mistake use
 * this and fail closed on the throw.
 *
 * Lives HERE, beside settingKey, rather than at the call site: a copy of the
 * `cfg.` prefix in another module reads the wrong key the day the prefix
 * changes — silently, and in the direction that turns a feature on.
 */
export function loadUserSectionStrict(section: UserOwnedSection): unknown {
  const raw = getSetting(settingKey(section));
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`corrupt JSON in ${settingKey(section)}`);
  }
  return parsed === null ? undefined : parsed;
}

/** Meta row remembering the file value each section was last imported from. */
const IMPORT_STATE_KEY = 'cfg.__import_state';

const DIGEST_PREFIX = 'sha256:';

/**
 * Change-tracking marker for a section's file value. For the credential-bearing
 * sections it is a digest rather than the JSON itself: the import-state row
 * lives in the same plaintext settings table, and mirroring a config.yaml
 * credential there would undo the keychain split. Rows written before this
 * hold the raw JSON; importLegacyUserSettings upgrades them in place, which
 * keeps change detection intact (same input, same digest). A stored JSON value
 * always starts with `{`, so it can never collide with the digest prefix.
 */
function importMarker(section: UserOwnedSection, fileJson: string): string {
  if (!isSecretSection(section)) return fileJson;
  return `${DIGEST_PREFIX}${createHash('sha256').update(fileJson).digest('hex')}`;
}

function loadImportState(): Record<string, string> {
  const raw = getSetting(IMPORT_STATE_KEY);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Import user sections that a config.yaml still carries. Change-tracked, not
 * write-once (review finding: 10 of 17 sections have no dashboard editor, so
 * a pure first-boot import silently ignored every later file edit):
 *
 * - DB has no value        -> import, remember the file value.
 * - file EDITED since the last import -> import (the edit is intent: for
 *   editor-less sections the file is the user's only knob), remember it.
 * - file unchanged          -> keep the DB value (dashboard edits persist).
 * - DB value exists but no import record (pre-tracking upgrade) -> baseline
 *   the current file value WITHOUT importing, so a dashboard edit made under
 *   the old behavior is never clobbered; subsequent file edits then apply.
 *
 * Returns the imported section names (for boot logging).
 */
/**
 * For the provider-choice sections (stt/tts): if the imported file value has
 * sub-blocks but no `provider` line, stamp the DEFAULT_CONFIG provider that
 * the merge layer would have supplied anyway — so the stored row records the
 * effective choice instead of a shape that reads as "user never chose".
 */
function stampImplicitProvider(section: string, fileValue: unknown): unknown {
  if (section !== 'stt' && section !== 'tts') return fileValue;
  if (typeof fileValue !== 'object' || fileValue === null || Array.isArray(fileValue)) return fileValue;
  const rec = fileValue as Record<string, unknown>;
  if (typeof rec.provider === 'string' && rec.provider.trim() !== '') return fileValue;
  const fallback = (DEFAULT_CONFIG[section] as { provider?: string } | undefined)?.provider;
  if (!fallback) return fileValue;
  return { ...rec, provider: fallback };
}

export function importLegacyUserSettings(rawYaml: Record<string, unknown> | null): string[] {
  const imported: string[] = [];
  const state = loadImportState();
  let stateChanged = false;

  // Normalize pre-digest baselines for the credential-bearing sections FIRST:
  // their raw JSON may itself be a config.yaml credential, and the section may
  // no longer be in the file — deleted from it, or the file gone/unparseable
  // (index.ts turns a read failure into null) — so neither the loop below nor
  // the no-file early return may skip this scrub.
  for (const section of SECRET_SECTIONS) {
    const raw = state[section];
    // Values are written as strings; anything else is a hand-edited row and
    // must not take a `.startsWith` on a non-string down with it.
    if (typeof raw !== 'string' || raw.startsWith(DIGEST_PREFIX)) continue;
    state[section] = importMarker(section, raw);
    stateChanged = true;
  }

  if (!rawYaml) {
    if (stateChanged) setSetting(IMPORT_STATE_KEY, JSON.stringify(state));
    return imported;
  }

  for (const section of USER_OWNED_SECTIONS) {
    const fileValue = rawYaml[section];
    if (fileValue === undefined || fileValue === null) continue;
    const fileJson = JSON.stringify(fileValue);
    const marker = importMarker(section, fileJson);
    const hasDbValue = getSetting(settingKey(section)) !== null;
    const lastImported = state[section];

    if (hasDbValue && lastImported === undefined) {
      state[section] = marker; // baseline only
      stateChanged = true;
      continue;
    }
    if (hasDbValue && lastImported === marker) continue;

    if (isSecretSection(section)) {
      // The file value is authoritative for the whole section, exactly as the
      // raw setSetting below: keys move to the keychain, the row is stripped.
      // A failed keychain write skips the section entirely (no marker either),
      // so the next boot retries instead of importing a key-less section.
      if (!persistSectionSecrets(section, fileValue)) {
        console.error(`[UserSettings] Keychain write failed — skipping the ${section} import from config.yaml (will retry on the next boot)`);
        continue;
      }
      // Stamp the provider the file relied on DEFAULT_CONFIG for: a row
      // holding `{ openai: {...} }` with no `provider` line reads as user
      // silence downstream (effectiveSttForBinding), and on a hosted plan
      // silence re-routes audio to the platform proxy — past the key this
      // very import just moved to the keychain. The file's implicit choice
      // becomes explicit at the moment it is recorded.
      const stamped = stampImplicitProvider(section, fileValue);
      setSetting(settingKey(section), JSON.stringify(stripSectionSecrets(section, stamped)));
      if (hasInlineSecret(section, fileValue)) {
        console.log(`[UserSettings] Imported ${section} credential(s) from config.yaml into the encrypted keychain — the plaintext value can be removed from the file`);
      }
    } else {
      setSetting(settingKey(section), fileJson);
    }
    state[section] = marker;
    stateChanged = true;
    imported.push(section);
  }

  if (stateChanged) setSetting(IMPORT_STATE_KEY, JSON.stringify(state));
  return imported;
}

/**
 * Load every stored user section into the in-memory config. Object sections
 * are merged over their defaults so a settings row written by an older build
 * never strips fields a newer build added; scalars replace directly.
 *
 * Call AFTER loadConfig (which discarded any file-provided user sections)
 * and re-apply env overrides afterwards if env must win (the daemon does).
 *
 * Credentials (STT/TTS API keys, channel bot tokens) are pulled from the
 * encrypted keychain and injected back into their sub-blocks, so consumers keep
 * reading `config.stt.openai.api_key` without knowing where it is stored.
 */
export function mergeUserSettingsIntoConfig(config: JarvisConfig): void {
  migratePlaintextSectionSecrets();
  const hasStoredRow = new Set<string>();
  for (const section of USER_OWNED_SECTIONS) {
    const stored = loadUserSection(section);
    if (stored === undefined) continue;
    hasStoredRow.add(section);
    const def = (DEFAULT_CONFIG as Record<string, unknown>)[section];
    const target = config as Record<string, unknown>;
    // `workflows` system path keys are FILE-owned (loadConfig preserved them
    // through the user-section discard): re-apply them over whatever the DB
    // row carries, so a dashboard save of the user-tunable workflow fields
    // can never strip the deployment-written artifact paths.
    let filePaths: Record<string, unknown> | null = null;
    if (section === 'workflows') {
      const current = target[section];
      if (current && typeof current === 'object') {
        for (const key of WORKFLOW_SYSTEM_KEYS) {
          const v = (current as Record<string, unknown>)[key];
          if (typeof v === 'string' && v.trim()) (filePaths ??= {})[key] = v;
        }
      }
    }
    if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
      target[section] = deepMerge(def !== undefined ? structuredClone(def) : {}, stored);
    } else {
      target[section] = stored;
    }
    if (filePaths) {
      target[section] = { ...(target[section] as object), ...filePaths };
    }
  }
  // Inject stored credentials only into sections that actually have a settings
  // row. Every path that stores one writes a row (save, import, migration), so a
  // secret without a row is an orphan - e.g. a default backup (DB only, no
  // keychain) restored onto a machine whose keychain holds another install's
  // keys. Grafting those onto the restored config would silently hand the
  // user a credential their settings never referenced.
  const target = config as Record<string, unknown>;
  for (const section of SECRET_SECTIONS) {
    if (!hasStoredRow.has(section)) continue;
    target[section] = injectSectionSecrets(section, target[section]);
  }
  mergeGoogleSettingsIntoConfig(config);
}

/**
 * Upgrade path for installs written before the keychain split: move any
 * credential still sitting in a plaintext `cfg.stt` / `cfg.tts` / `cfg.channels`
 * row into the keychain and rewrite the row stripped. Idempotent and cheap, so
 * it runs on every hydration — including SettingsReloadCoordinator.reloadAll,
 * which is what a restore-from-backup of an older DB goes through.
 */
function migratePlaintextSectionSecrets(): void {
  for (const section of SECRET_SECTIONS) {
    const stored = loadUserSection(section);
    if (!hasInlineSecret(section, stored)) continue;
    // The row predates the split, so it is the authority for the whole
    // section: persist every key it carries, drop stale ones.
    if (!persistSectionSecrets(section, stored)) {
      // Keep the plaintext row rather than strip a credential the keychain
      // never took: a working (if unencrypted) one beats a destroyed one.
      // The next hydration retries.
      console.error(`[UserSettings] Keychain write failed — leaving the plaintext ${section} credential(s) in the settings table for now`);
      continue;
    }
    setSetting(settingKey(section), JSON.stringify(stripSectionSecrets(section, stored)));
    console.log(`[UserSettings] Moved plaintext ${section} credential(s) from the settings table into the encrypted keychain`);
  }
}

// ── google: system-owned when the FILE provides it ─────────────────────────
//
// `google` is the one section with dual ownership. When the system config
// provides it, the file must win: on a hosted instance that section carries the
// control-plane wiring (refresh_url, instance_id, notify_secret, connect_url)
// and letting a stored row replace it would silently revert the instance to
// self-hosted behaviour. Self-hosters without a file entry configure their own
// client from the dashboard, which persists here in the DB as a fallback.

const GOOGLE_KEY = `${CFG_PREFIX}google`;

export function saveGoogleSettings(value: JarvisConfig['google']): void {
  setSetting(GOOGLE_KEY, JSON.stringify(value ?? null));
  notifySectionSaved('google');
}

/** Did the FILE provide a google section? Any server-written key counts. */
function googleIsFileProvided(google: JarvisConfig['google']): boolean {
  // NOT `client_id` alone: a managed instance has no client credentials at all
  // — that is the entire point of hosted mode — so keying on them let the stored
  // row replace refresh_url, instance_id and the two derived keys, breaking
  // refresh and the push doorbell and turning the managed UI back into the
  // credentials form.
  //
  // Every key the SERVER writes counts, including the push-only ones: the
  // renderer emits them together, so any of them present means this section came
  // from the file, and a stored row must not win over it.
  return !!(
    google?.client_id ||
    google?.refresh_url ||
    google?.refresh_secret ||
    google?.notify_secret ||
    google?.connect_url ||
    google?.pubsub_topic ||
    google?.push_callback ||
    google?.channel_token
  );
}

function mergeGoogleSettingsIntoConfig(config: JarvisConfig): void {
  if (googleIsFileProvided(config.google)) return; // system-owned, file wins
  const raw = getSetting(GOOGLE_KEY);
  if (raw === null) return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') config.google = parsed;
  } catch {
    console.warn(`[UserSettings] Corrupt JSON for ${GOOGLE_KEY}; ignoring stored value`);
  }
}
