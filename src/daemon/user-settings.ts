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
 * Requires the vault DB (initDatabase) to be open, same as llm-settings.
 */

import { getSetting, setSetting } from '../vault/settings.ts';
import { deepMerge } from '../config/loader.ts';
import {
  DEFAULT_CONFIG,
  USER_OWNED_SECTIONS,
  WORKFLOW_SYSTEM_KEYS,
  type JarvisConfig,
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
 */
export function saveUserSection<K extends UserOwnedSection>(
  section: K,
  value: JarvisConfig[K],
): void {
  setSetting(settingKey(section), JSON.stringify(value ?? null));
  notifySectionSaved(section);
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

/** Meta row remembering the file value each section was last imported from. */
const IMPORT_STATE_KEY = 'cfg.__import_state';

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
export function importLegacyUserSettings(rawYaml: Record<string, unknown> | null): string[] {
  if (!rawYaml) return [];
  const imported: string[] = [];
  const state = loadImportState();
  let stateChanged = false;

  for (const section of USER_OWNED_SECTIONS) {
    const fileValue = rawYaml[section];
    if (fileValue === undefined || fileValue === null) continue;
    const fileJson = JSON.stringify(fileValue);
    const hasDbValue = getSetting(settingKey(section)) !== null;
    const lastImported = state[section];

    if (hasDbValue && lastImported === undefined) {
      state[section] = fileJson; // baseline only
      stateChanged = true;
      continue;
    }
    if (hasDbValue && fileJson === lastImported) continue;

    setSetting(settingKey(section), fileJson);
    state[section] = fileJson;
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
 */
export function mergeUserSettingsIntoConfig(config: JarvisConfig): void {
  for (const section of USER_OWNED_SECTIONS) {
    const stored = loadUserSection(section);
    if (stored === undefined) continue;
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
  notifySectionSaved('google');
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
