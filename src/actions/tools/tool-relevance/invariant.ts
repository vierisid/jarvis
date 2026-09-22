/**
 * The coupling invariant, as enforceable code.
 *
 * See docs/tool-relevance-filtering.md section 3. This module takes a
 * candidate tool set and either returns a set that provably satisfies the
 * invariants, or refuses and hands back the full input.
 *
 * It knows nothing about how the candidate was chosen. That is deliberate:
 * the selection heuristic can be replaced wholesale -- by embeddings, by a
 * learned router -- without re-reviewing the security properties, because
 * they are checked on the OUTPUT against the input list.
 *
 * Nothing here reads the conversation. A filter whose repair step could be
 * steered by the message would be the same bug in a new place.
 */

import type { ToolDefinition } from '../registry.ts';
import {
  isFloorEligible,
  isFramedPerception,
  isInvariantTrigger,
} from './authority-classes.ts';

/** Why a returned set is the full input rather than a filtered one. */
export type InvariantFailure = {
  invariant: 'I1' | 'I3-subset' | 'I3-floor' | 'I4';
  detail: string;
};

export type NormalizeResult = {
  /** The tools to offer. Order follows the input list exactly. */
  tools: ToolDefinition[];
  /** True when `tools` is the untouched input because a check failed. */
  failedOpen: boolean;
  /** Populated when `failedOpen` is true. */
  failures: InvariantFailure[];
  /** Names the union repair had to add back. Empty when it did not fire. */
  repaired: string[];
};

const names = (ts: Iterable<ToolDefinition>) => [...ts].map((t) => t.name);

/**
 * I1 -- framing non-regression.
 *
 *   TRIGGER(S) != {}  =>  PERCEPTION(A) subset of S
 *
 * Contrapositive, which is #483 requirement 4 verbatim: if any framed
 * perception tool is dropped, every unframed-fetch tool and every
 * above-access_browser tool is dropped with it.
 */
export function checkFramingInvariant(
  all: readonly ToolDefinition[],
  selected: readonly ToolDefinition[],
  synthetic: readonly string[] = [],
): InvariantFailure | null {
  // Synthetic tools are inert by fiat: `ask_for_clarification` asks the
  // person a question, `discover_tools` lists names, the realtime nav tools
  // drive the dashboard. None can reach outside content, and none is in the
  // registry -- so `outsideReach` would default them to `fetch` and they
  // would drag the whole perception union into every filtered turn.
  const synth = new Set(synthetic);
  const triggers = selected.filter((t) => !synth.has(t.name) && isInvariantTrigger(t));
  if (triggers.length === 0) return null;
  const have = new Set(selected.map((t) => t.name));
  const missing = all.filter((t) => isFramedPerception(t) && !have.has(t.name));
  if (missing.length === 0) return null;
  return {
    invariant: 'I1',
    detail:
      `retains ${names(triggers).join(', ')} but drops framed perception `
      + `${names(missing).join(', ')}`,
  };
}

/**
 * Apply the union repair: restore every framed reader the input had.
 *
 * Union, never subtraction. Both restore I1, but union only ever moves the
 * set toward the full list, so it cannot remove a capability the task needs.
 * Subtraction would let a crafted message delete `run_command` from a turn
 * where the person genuinely asked to run a command -- a steerable
 * denial-of-capability, which is a new bug of the same family.
 */
function repair(
  all: readonly ToolDefinition[],
  selected: readonly ToolDefinition[],
): { tools: ToolDefinition[]; added: string[] } {
  const have = new Set(selected.map((t) => t.name));
  const added = all.filter((t) => isFramedPerception(t) && !have.has(t.name));
  if (added.length === 0) return { tools: [...selected], added: [] };
  const keep = new Set([...have, ...added.map((t) => t.name)]);
  const registered = new Set(all.map((t) => t.name));
  // Rebuild from `all` so the input's order is preserved exactly: a recompute
  // that reshuffles the list would invalidate the provider's cached prefix
  // for no reason. Synthetic entries are not in `all`, so they are carried
  // over separately -- rebuilding from `all` alone would silently delete the
  // escape hatch on exactly the turns that need it most.
  const rebuilt = all.filter((t) => keep.has(t.name));
  const carried = selected.filter((t) => !registered.has(t.name));
  return { tools: [...rebuilt, ...carried], added: names(added) };
}

/**
 * Normalise a candidate set and verify every invariant on the result.
 *
 * `synthetic` names tools the call site appends that are not registry tools
 * (`ask_for_clarification`, `discover_tools`, the realtime nav tools). The
 * subset check runs against `A+ = all + synthetic`; stating it over `all`
 * alone would make I3 fail on every filtered turn, since `discover_tools` is
 * by construction not in the registry -- which would send this function
 * fail-open forever and silently disable the feature.
 */
export function normalizeToolSet(
  all: readonly ToolDefinition[],
  candidate: readonly ToolDefinition[],
  synthetic: readonly string[] = [],
): NormalizeResult {
  const failures: InvariantFailure[] = [];
  const allNames = new Set([...all.map((t) => t.name), ...synthetic]);

  // I3 (subset). Checked on the CANDIDATE, before any repair: a candidate
  // carrying a tool the call site never offered is a caller bug, and the
  // repair would otherwise launder it into the result.
  const foreign = candidate.filter((t) => !allNames.has(t.name));
  if (foreign.length > 0) {
    failures.push({ invariant: 'I3-subset', detail: `not in the input list: ${names(foreign).join(', ')}` });
    return { tools: [...all], failedOpen: true, failures, repaired: [] };
  }

  const violation = checkFramingInvariant(all, candidate, synthetic);
  const { tools, added } = violation
    ? repair(all, candidate)
    : { tools: [...candidate], added: [] as string[] };

  // Re-verify on the REPAIRED set. The repair is not trusted to be correct;
  // it is checked like anything else.
  const after = checkFramingInvariant(all, tools, synthetic);
  if (after) failures.push(after);

  // I3 (floor). A set containment test against the tools the call site
  // actually passed -- not a length comparison against a hard-coded name
  // list, which is the off-by-one that made #475's guard unreachable
  // (`ask_for_clarification` is appended after filtering and can never be
  // counted; `request_approval` is only conditionally registered).
  const have = new Set(tools.map((t) => t.name));
  const missingFloor = all.filter((t) => isFloorEligible(t) && !have.has(t.name));
  if (missingFloor.length > 0) {
    failures.push({ invariant: 'I3-floor', detail: `floor tools dropped: ${names(missingFloor).join(', ')}` });
  }

  if (failures.length > 0) {
    return { tools: [...all], failedOpen: true, failures, repaired: [] };
  }
  return { tools, failedOpen: false, failures: [], repaired: added };
}
