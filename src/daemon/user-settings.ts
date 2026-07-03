/**
 * User-owned settings: DB persistence for every config section the user (not
 * the host) controls — personality, voice, authority, channels, onboarding
 * state, and the rest of `USER_OWNED_SECTIONS`.
 *
 * This generalizes the pattern llm-settings.ts established for the `llm`
 * block: the vault DB settings store is the sole authority, config.yaml
 * contributes nothing (loadConfig discards user sections), and the daemon
 * merges the stored values into the in-memory config at boot. config.yaml is
 * thereby reduced to a read-only SYSTEM config (daemon.*, auth, google) that
 * the brain never writes — in hosted mode it is root-owned and the server
 * manages it.
 *
 * Layout: one settings row per section, key `cfg.<section>`, value JSON.
 *
 * Requires the vault DB (initDatabase) to be open, same as llm-settings.
 */

import { getSetting, setSetting } from '../vault/settings.ts';
import { deepMerge } from '../config/loader.ts';
import {
  DEFAULT_CONFIG,
  USER_OWNED_SECTIONS,
  type JarvisConfig,
  type UserOwnedSection,
} from '../config/types.ts';

const CFG_PREFIX = 'cfg.';

function settingKey(section: UserOwnedSection): string {
  return `${CFG_PREFIX}${section}`;
}

/**
 * Persist one section to the DB. Callers mutate the in-memory config first,
 * then persist that section — the write is per-section, so there is no
 * load-modify-save race across unrelated sections (which is what the old
 * `loadConfig -> mutate -> saveConfig` dance existed to avoid).
 */
export function saveUserSection<K extends UserOwnedSection>(
  section: K,
  value: JarvisConfig[K],
): void {
  setSetting(settingKey(section), JSON.stringify(value ?? null));
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
 * One-time import of user sections that a legacy config.yaml still carries.
 * A section is imported only when the DB has no value for it yet, so a
 * dashboard edit is never clobbered by a stale file on later boots. Returns
 * the imported section names (for boot logging).
 */
export function importLegacyUserSettings(rawYaml: Record<string, unknown> | null): string[] {
  if (!rawYaml) return [];
  const imported: string[] = [];
  for (const section of USER_OWNED_SECTIONS) {
    const fileValue = rawYaml[section];
    if (fileValue === undefined || fileValue === null) continue;
    if (getSetting(settingKey(section)) !== null) continue;
    setSetting(settingKey(section), JSON.stringify(fileValue));
    imported.push(section);
  }
  return imported;
}

/**
 * Load every stored user section into the in-memory config. Object sections
 * are merged over their defaults so a settings row written by an older build
 * never strips fields a newer build added; scalars replace directly.
 *
 * Call AFTER loadConfig (which discarded any file-provided user sections)
 * and re-apply env overrides afterwards if env must win (the daemon does).
 */
export function mergeUserSettingsIntoConfig(config: JarvisConfig): void {
  for (const section of USER_OWNED_SECTIONS) {
    const stored = loadUserSection(section);
    if (stored === undefined) continue;
    const def = (DEFAULT_CONFIG as Record<string, unknown>)[section];
    const target = config as Record<string, unknown>;
    if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
      target[section] = deepMerge(def !== undefined ? structuredClone(def) : {}, stored);
    } else {
      target[section] = stored;
    }
  }
  mergeGoogleSettingsIntoConfig(config);
}

// ── google: system-owned when the FILE provides it ─────────────────────────
//
// `google` is the one section with dual ownership. In hosted mode the system
// config carries the shared company OAuth client (server-written), so the
// file must win. Self-hosters without a file entry configure their own
// client from the dashboard, which persists here in the DB as a fallback.

const GOOGLE_KEY = `${CFG_PREFIX}google`;

export function saveGoogleSettings(value: JarvisConfig['google']): void {
  setSetting(GOOGLE_KEY, JSON.stringify(value ?? null));
}

function mergeGoogleSettingsIntoConfig(config: JarvisConfig): void {
  if (config.google?.client_id) return; // file-provided: system-owned, file wins
  const raw = getSetting(GOOGLE_KEY);
  if (raw === null) return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') config.google = parsed;
  } catch {
    console.warn(`[UserSettings] Corrupt JSON for ${GOOGLE_KEY}; ignoring stored value`);
  }
}
