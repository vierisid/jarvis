/**
 * Authority profile for the background agent.
 *
 * The background agent reacts to observer events, screen struggles and
 * commitment deadlines with no user turn, and its prompts embed ambient
 * input (OCR text, email snippets, clipboard content). It therefore runs
 * under the shared authority config plus the restrictions built here: any
 * action that changes the machine needs the user's approval, while reading
 * and browsing stay autonomous so error research keeps working.
 *
 * The user tunes this under `authority.background`, read and written through
 * GET/POST /api/authority/config alongside the shared authority settings.
 */

import type { ActionCategory } from '../roles/authority.ts';
import type { AuthorityProfile } from './engine.ts';
import type { BackgroundAuthorityConfig } from '../config/types.ts';

export const BACKGROUND_PROFILE_LABEL = 'background agent';

/**
 * Applied when `authority.background.governed_categories` is absent.
 *
 * Includes the outbound categories (email, messages, payments) on purpose
 * even though the shared default governs them too: the owner may drop them
 * from the shared list for the chat agent, and the background agent, which
 * acts on ambient input with no intent gate, must keep stopping for them.
 */
export const DEFAULT_BACKGROUND_GOVERNED: readonly ActionCategory[] = [
  'execute_command',
  'write_data',
  'control_app',
  'delete_data',
  'install_software',
  'modify_settings',
  'send_email',
  'send_message',
  'make_payment',
];

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set<ActionCategory>([
  'read_data', 'write_data', 'delete_data',
  'send_message', 'send_email',
  'execute_command', 'install_software',
  'make_payment', 'modify_settings',
  'spawn_agent', 'terminate_agent',
  'access_browser', 'control_app',
]);

/**
 * Build the profile from the config section.
 *
 * Only an explicit empty array opts the background agent out of the extra
 * gating. Anything malformed falls back to the defaults and is logged: a
 * non-array value (the section is a schemaless JSON row), or a list whose
 * entries are all unknown (a typo must not silently turn the gating off).
 */
export function buildBackgroundProfile(section?: BackgroundAuthorityConfig | null): AuthorityProfile {
  const raw = section?.governed_categories;
  let governed: ActionCategory[];
  if (raw === undefined || raw === null) {
    governed = [...DEFAULT_BACKGROUND_GOVERNED];
  } else if (!Array.isArray(raw)) {
    console.warn('[Authority] authority.background.governed_categories is not a list; using defaults');
    governed = [...DEFAULT_BACKGROUND_GOVERNED];
  } else {
    governed = [];
    for (const cat of raw) {
      if (typeof cat === 'string' && KNOWN_CATEGORIES.has(cat)) {
        governed.push(cat as ActionCategory);
      } else {
        console.warn(`[Authority] authority.background.governed_categories: unknown category "${String(cat)}" ignored`);
      }
    }
    if (raw.length > 0 && governed.length === 0) {
      console.warn('[Authority] authority.background.governed_categories had no valid entries; using defaults');
      governed = [...DEFAULT_BACKGROUND_GOVERNED];
    }
  }

  const profile: AuthorityProfile = {
    label: BACKGROUND_PROFILE_LABEL,
    governed_categories: governed,
  };
  const cap = section?.level_cap;
  if (typeof cap === 'number' && Number.isFinite(cap)) {
    profile.level_cap = Math.max(1, Math.min(10, Math.floor(cap)));
  }
  return profile;
}
