/**
 * Taint gating for the main (chat) agent.
 *
 * The chat agent keeps its full authority level: the owner chose it, and an
 * autonomous assistant is the product. What changes is one specific case:
 * within a turn in which the agent has READ outside content (a web page,
 * the clipboard, a local file, screen text, or a sub-agent's report; see
 * isTaintSourceTool in roles/untrusted.ts for the list), the actions that
 * change the machine, contact someone or
 * delegate stop for approval. Nothing an attacker wrote on a page can then
 * turn straight into a shell command; the user sees exactly what the agent
 * wants to do and clicks once.
 *
 * Taint is per user turn: a fresh message from the user clears it. That is
 * a deliberate trade-off between safety and friction, and it leaves one
 * known residual: a page can say "ask the user first, then run it"; the
 * user's "yes" is a new turn, so the command runs clean. Task resumes are
 * covered (the taint is rebuilt from the history); plain chat is not.
 * Taint-gated approvals are not fed to the approval learner, because an
 * override cannot lift a profile gate and the suggestion would be dead.
 *
 * Configured under `authority.taint_gating`. The categories below form a
 * safety floor: configuration may add categories, but cannot remove these
 * controls or disable gating.
 */

import type { ActionCategory } from '../roles/authority.ts';
import type { AuthorityProfile } from './engine.ts';
import type { TaintGatingConfig } from '../config/types.ts';

export const TAINT_PROFILE_LABEL = 'outside content read this turn';

/** Applied when `authority.taint_gating.governed_categories` is absent. */
export const REQUIRED_TAINT_GOVERNED: readonly ActionCategory[] = [
  'execute_command',
  'write_data',
  'control_app',
  'delete_data',
  'install_software',
  'modify_settings',
  'send_email',
  'send_message',
  'make_payment',
  // Delegation hands the task to a sub-agent with its own tools; a tainted
  // parent must not be able to route around the gate that way.
  'spawn_agent',
];

export const DEFAULT_TAINT_GOVERNED = REQUIRED_TAINT_GOVERNED;

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set<ActionCategory>([
  'read_data', 'write_data', 'delete_data',
  'send_message', 'send_email',
  'execute_command', 'install_software',
  'make_payment', 'modify_settings',
  'spawn_agent', 'terminate_agent',
  'access_browser', 'control_app',
]);

export type TaintGating = {
  enabled: boolean;
  governed_categories: ActionCategory[];
};

/**
 * Build the gating from its config section. User configuration can add
 * categories, but the security-sensitive defaults are always retained.
 * Malformed input falls back to the defaults and is logged.
 */
export function buildTaintGating(section?: TaintGatingConfig | null): TaintGating {
  const raw = section?.governed_categories;
  let governed: ActionCategory[];
  if (raw === undefined || raw === null) {
    governed = [...DEFAULT_TAINT_GOVERNED];
  } else if (!Array.isArray(raw)) {
    console.warn('[Authority] authority.taint_gating.governed_categories is not a list; using defaults');
    governed = [...DEFAULT_TAINT_GOVERNED];
  } else {
    governed = [...REQUIRED_TAINT_GOVERNED];
    for (const cat of raw) {
      if (typeof cat === 'string' && KNOWN_CATEGORIES.has(cat)) {
        if (!governed.includes(cat as ActionCategory)) governed.push(cat as ActionCategory);
      } else {
        console.warn(`[Authority] authority.taint_gating.governed_categories: unknown category "${String(cat)}" ignored`);
      }
    }
  }
  if (section?.enabled === false) {
    console.warn('[Authority] authority.taint_gating.enabled=false is no longer accepted; gating remains enabled');
  }
  return {
    enabled: true,
    governed_categories: governed,
  };
}

/**
 * The profile to apply for a turn that read from the given sources. Returns
 * null when gating is off or nothing was read, so the caller can fall back
 * to its static profile untouched.
 */
export function taintProfile(gating: TaintGating | null, sources: ReadonlySet<string>): AuthorityProfile | null {
  if (!gating || !gating.enabled || sources.size === 0 || gating.governed_categories.length === 0) return null;
  return {
    label: `${TAINT_PROFILE_LABEL} (${[...sources].join(', ')})`,
    governed_categories: [...gating.governed_categories],
  };
}

/**
 * Merge two tighten-only profiles: the union of governed categories and the
 * lower level cap. Either may be null.
 */
export function mergeProfiles(a: AuthorityProfile | null, b: AuthorityProfile | null): AuthorityProfile | null {
  if (!a) return b;
  if (!b) return a;
  const governed = new Set<ActionCategory>([...(a.governed_categories ?? []), ...(b.governed_categories ?? [])]);
  const caps = [a.level_cap, b.level_cap].filter((c): c is number => typeof c === 'number');
  const merged: AuthorityProfile = {
    label: [a.label, b.label].filter(Boolean).join('; '),
    governed_categories: [...governed],
  };
  if (caps.length > 0) merged.level_cap = Math.min(...caps);
  return merged;
}
