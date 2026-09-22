/**
 * Tool authority classification for relevance filtering.
 *
 * See docs/tool-relevance-filtering.md. This module owns the two axes the
 * filter reasons about and NOTHING else: no selection, no policy, no call
 * sites. Keeping it separate is what lets the invariant tests in
 * `invariant.test.ts` walk BUILTIN_TOOLS and assert properties of the
 * classification itself, independent of any heuristic.
 *
 * The filter exists to cut tool-schema tokens for small models. It is an
 * optimisation, never a control: the authority engine (src/authority) still
 * gates every call, and the ceiling of what the filter can offer is the full
 * registered set. What the filter CAN do wrong is steer the model away from
 * a framed tool and toward an unframed one, which is why this file exists.
 */

import type { ToolDefinition } from '../registry.ts';
import { TOOL_ACTION_MAP, getActionForTool, severityRank } from '../../../authority/tool-action-map.ts';
import { isUntrustedSourceTool } from '../../../roles/untrusted.ts';

/**
 * How a tool's result enters the context, and whether the model can aim the
 * tool at something outside the conversation.
 *
 *   framed  Result is delimiter-wrapped, defanged and (mostly) taint-marking
 *           -- `isUntrustedSourceTool` is true. Fully DERIVED, never declared,
 *           so it cannot drift from the real framing set.
 *   fetch   The model can direct it at content outside the conversation and
 *           the result is NOT framed. This is the laundering class: retaining
 *           one of these forces the framed readers to stay (see `INVARIANT`).
 *   replay  Returns stored text of mixed provenance, but the model cannot aim
 *           it outside -- it only reads back records this system already
 *           holds. See the long note below; this is a load-bearing judgement.
 *   inert   Returns a status, or facts generated locally. Cannot carry
 *           outside-authored text at all.
 */
export type OutsideReach = 'framed' | 'fetch' | 'replay' | 'inert';

/**
 * Why `replay` is on the safe side of the framing invariant.
 *
 * The hazard this filter must not create is SUBSTITUTION: the model wants to
 * read something from outside, the framed route has been filtered away, so it
 * takes an unframed route instead and the content arrives unwrapped. That is
 * what #475 did by dropping every browser tool while keeping `run_command`.
 *
 * The test is therefore NOT "can this tool's output contain outside-authored
 * bytes" -- almost everything can, once a web page has been summarised into a
 * note. The test is "can the model aim this tool at content of its own
 * choosing from outside the conversation". No model asked to summarise a URL
 * calls `commitments` instead; it cannot point `commitments` at a URL.
 *
 * Two consequences, both enforced below:
 *   1. replay tools are never floor-eligible. An earlier draft of this design
 *      put them in the always-set, which is strictly worse than the status
 *      quo: it pins a tool that echoes stored outside text into every turn.
 *   2. replay tools do not trigger the framing union, so a "remind me" turn
 *      does not have to carry 9.7 kB of browser schema it cannot use.
 */
const REPLAY_TOOLS: ReadonlySet<string> = new Set([
  // Reads back the local skill catalogue. Parameter names in the listing come
  // from accessible names on recorded surfaces, so the text is of outside
  // origin -- but `manage_skills` cannot record or run anything (that is
  // record_skill / run_skill, both framed), so it cannot fetch.
  'manage_skills',
  // Vault documents. `get` returns a stored body; nothing takes a URL.
  'create_document',
  // Pipeline items. `get` returns `item.body`, which may hold research output.
  'content_pipeline',
  // Extracted commitments; `what`/`context` are LLM-written from conversation.
  'commitments',
  'manage_goals',
  // `list` returns a truncated stored `result` field.
  'research_queue',
]);

/**
 * Tools whose result cannot carry outside-authored text at all.
 *
 * Only these are floor-eligible, and only if they also clear the rank and
 * explicit-mapping tests in `isFloorEligible`. Getting an entry wrong here is
 * the worst error possible in this design, because no input can remove a
 * floor tool -- so each entry names what it actually returns.
 */
const INERT_TOOLS: ReadonlySet<string> = new Set([
  'write_file',           // status string only; no source-path or URL parameter
  'set_clipboard',        // status string only
  'get_system_info',      // hostname/platform/arch/cpu/version, generated locally
  'list_sidecars',        // our own pairing records
  'request_approval',     // the intent-gate tool; returns the person's decision
  // Desktop actuators: they act and return a status, they cannot read. They
  // are NOT floor-eligible -- at rank 505 they fail `isFloorEligible` -- but
  // they are correctly `inert` because they bring nothing in.
  'desktop_click',
  'desktop_type',
  'desktop_press_keys',
  'desktop_launch_app',
  'desktop_focus_window',
]);

/**
 * The classification. Note the polarity of the default: anything not declared
 * is `fetch`, the most conservative class. A newly registered tool is
 * therefore never floor-eligible and always forces the framed readers to
 * stay. Mis-declaring a new tool can cost tokens; it cannot open the
 * laundering door. `coverage.test.ts` still forces an explicit decision for
 * every builtin so the default is a safety net, not a way of avoiding review.
 */
export function outsideReach(tool: ToolDefinition): OutsideReach {
  if (isUntrustedSourceTool(tool.name, tool.category)) return 'framed';
  if (REPLAY_TOOLS.has(tool.name)) return 'replay';
  if (INERT_TOOLS.has(tool.name)) return 'inert';
  return 'fetch';
}

/** True when the tool has an EXPLICIT entry in TOOL_ACTION_MAP. */
export function hasExplicitAction(tool: ToolDefinition): boolean {
  return Object.hasOwn(TOOL_ACTION_MAP, tool.name);
}

/**
 * Authority rank, with the one correction this filter needs.
 *
 * `getActionForTool` falls through to `read_data` (rank 100) for a tool in
 * neither action map. That default is tolerable where it is consumed today,
 * but here it would score an UNMAPPED SHELL as a level-1 read: both
 * `manage_workflow` (category "automation") and `site_run_command` (category
 * "site-builder", a real `Bun.spawn(['sh','-c',cmd])`) are unmapped on main.
 * `builtin-tool-coverage.test.ts` exists to prevent exactly that and would
 * have caught it, but it walks BUILTIN_TOOLS and neither tool is in it.
 *
 * So an unmapped tool gets rank Infinity here: never floor-eligible, always
 * an invariant trigger. Fixing the action map itself is a separate change
 * (it raises live gating for an existing feature); this filter is built to be
 * safe in spite of the gap rather than to depend on it being closed.
 */
export function authorityRank(tool: ToolDefinition): number {
  if (!hasExplicitAction(tool)) return Number.POSITIVE_INFINITY;
  return severityRank(getActionForTool(tool.name, tool.category));
}

/** Rank of `write_data` (302): the ceiling for floor eligibility. */
export const FLOOR_RANK_CEILING = severityRank('write_data');
/** Rank of `access_browser` (504): the ceiling for a framed *reader*. */
export const PERCEPTION_RANK_CEILING = severityRank('access_browser');

/**
 * The always-offered set: low authority, explicitly gated, and incapable of
 * carrying outside text. #483 requirement 4 asks that the always-set be the
 * LOW-authority tools and that the privileged ones be what gets filtered;
 * this predicate is that requirement.
 */
export function isFloorEligible(tool: ToolDefinition): boolean {
  return outsideReach(tool) === 'inert'
    && hasExplicitAction(tool)
    && authorityRank(tool) <= FLOOR_RANK_CEILING;
}

/**
 * A framed *reader*: the tools that give the model a wrapped, defanged,
 * taint-marking way to see something. These are what the invariant restores.
 * Framed ACTORS (ui_act, run_skill, record_skill at 505, browser_evaluate at
 * 506) are excluded -- dropping them while keeping a shell is not a
 * reading-framing bypass, and re-admitting `record_skill` (which installs
 * system-wide input hooks) next to `run_command` on a "run this script" turn
 * is a bad distractor for exactly the small models this feature targets.
 */
export function isFramedPerception(tool: ToolDefinition): boolean {
  return outsideReach(tool) === 'framed' && authorityRank(tool) <= PERCEPTION_RANK_CEILING;
}

/**
 * Retaining any of these obliges the filter to retain every framed reader.
 *
 * Two clauses, and the second is not redundant:
 *   reach === 'fetch'   the laundering class proper (run_command, the
 *                       screenshots, delegation, list_directory, unmapped).
 *   rank > 504          everything above access_browser. Without this,
 *                       `S = FLOOR ∪ {desktop_click, desktop_type, ...}` with
 *                       no perception tool at all would be invariant-clean,
 *                       and that is the same substitution family one step
 *                       sideways (browser_click at 504 -> desktop_click at
 *                       505). It fails safe today only because `rawUiGate`
 *                       forces a review card on raw desktop mutations, which
 *                       is luck, not an invariant.
 */
export function isInvariantTrigger(tool: ToolDefinition): boolean {
  return outsideReach(tool) === 'fetch' || authorityRank(tool) > PERCEPTION_RANK_CEILING;
}
