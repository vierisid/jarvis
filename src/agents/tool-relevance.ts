/**
 * Tool relevance filtering.
 *
 * The audit found ~35 tool schemas (~3.4k tokens) shipped on every request
 * with no filtering: a "open Notepad" task still carried all the browser,
 * workflow, goals, vault, and delegation schemas — token cost plus a pile of
 * mis-selection distractors for small models.
 *
 * This selects a focused subset per turn. It is deliberately FAIL-OPEN: an
 * always-available core set is never dropped, and if the message gives no
 * confident signal the full set is returned. Trimming happens only when the
 * message clearly implicates specific optional groups — so a wrong guess costs
 * tokens, never a missing capability.
 */

import type { LLMTool } from '../llm/provider.ts';

/** Tools always sent, regardless of message — the safe floor. */
const ALWAYS: ReadonlySet<string> = new Set([
  'run_command', 'read_file', 'write_file', 'list_directory',
  'get_clipboard', 'set_clipboard', 'get_system_info', 'list_sidecars',
  'ask_for_clarification', 'request_approval',
]);

type Group = {
  /** Tool names (exact) or name prefixes (endswith '_'). */
  match: string[];
  /** Keywords that, if present in the message, include this group. */
  keywords: RegExp;
};

/**
 * Optional groups. A group is included when its keywords hit the message.
 * The computer-control group intentionally spans desktop + browser + ui so we
 * never ship a partial control surface (e.g. desktop tools without ui_act).
 */
const GROUPS: Record<string, Group> = {
  control: {
    match: ['desktop_', 'browser_', 'ui_', 'run_skill', 'manage_skills', 'record_skill', 'capture_screen'],
    keywords: /\b(open|launch|click|type|scroll|screenshot|window|app|application|notepad|chrome|browser|navigate|website|url|web ?page|tab|button|form|login|desktop|snapshot|menu|dialog|calc|excel|word|slack|gmail|outlook|notion)\b/i,
  },
  workflow: {
    match: ['manage_workflow'],
    keywords: /\b(workflow|automat|flow|trigger|schedule|pipeline|recurring)\b/i,
  },
  goals: {
    match: ['manage_goals'],
    keywords: /\b(goal|okr|objective|key result|morning plan|evening review|milestone)\b/i,
  },
  knowledge: {
    match: ['commitments', 'research_queue', 'create_document', 'content_pipeline'],
    keywords: /\b(remember|commitment|promis|research|document|note|draft|write up|content|article|post)\b/i,
  },
  delegation: {
    match: ['delegate_task', 'manage_agents'],
    keywords: /\b(delegate|specialist|agent|team|assign|hand ?off)\b/i,
  },
};

function inGroup(toolName: string, group: Group): boolean {
  return group.match.some((m) => (m.endsWith('_') ? toolName.startsWith(m) : toolName === m));
}

/** True if the tool belongs to any optional group (i.e. is filterable). */
function isOptional(toolName: string): boolean {
  return Object.values(GROUPS).some((g) => inGroup(toolName, g));
}

/**
 * Select the relevant subset of `tools` for `message`.
 *
 * Returns the full list unchanged when: filtering is disabled, the message is
 * empty, or no optional group matched (fail-open — an ambiguous request keeps
 * everything). Otherwise returns ALWAYS ∪ matched-groups ∪ any tool that
 * belongs to no group (unknown tools are never dropped).
 */
export function selectRelevantTools(
  tools: LLMTool[],
  message: string,
  opts: { enabled?: boolean } = {},
): LLMTool[] {
  if (opts.enabled === false) return tools;
  const msg = (message ?? '').trim();
  if (!msg) return tools;

  const activeGroups = Object.values(GROUPS).filter((g) => g.keywords.test(msg));
  if (activeGroups.length === 0) return tools; // no confident signal → keep all

  const keep = (name: string): boolean => {
    if (ALWAYS.has(name)) return true;
    if (!isOptional(name)) return true; // unknown/ungrouped tool → keep
    return activeGroups.some((g) => inGroup(name, g));
  };

  const filtered = tools.filter((t) => keep(t.name));
  // Guard: never return a suspiciously tiny set — if we somehow filtered below
  // the always-set size, fall back to everything.
  return filtered.length >= ALWAYS.size ? filtered : tools;
}
