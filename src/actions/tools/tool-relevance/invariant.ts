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
 *
 * Two structural rules keep the surface small, both learned from probing an
 * earlier version of this file:
 *
 *   1. It deals ONLY in registry tools. Synthetic tools (`discover_tools`,
 *      `ask_for_clarification`, the realtime nav tools) are appended by the
 *      call site AFTER filtering -- which is how `ask_for_clarification`
 *      already works. An earlier version took a `synthetic` name list and
 *      exempted those names from trigger detection; passing a REAL tool's
 *      name in that list then suppressed it as a trigger and let the framed
 *      readers be dropped while the shell stayed. There is now no such
 *      parameter to misuse.
 *   2. The output is always rebuilt from `all` by name. The candidate
 *      supplies names, never objects. That makes duplicates impossible,
 *      keeps the input's order (a reshuffle would invalidate the provider's
 *      cached prefix for nothing), and stops a caller passing a stub object
 *      that reuses a registered tool's name but carries a different schema.
 */

import type { ToolDefinition } from '../registry.ts';
import {
  isFloorEligible,
  isFramedPerception,
  isInvariantTrigger,
} from './authority-classes.ts';

/** Why a returned set is the full input rather than a filtered one. */
export type InvariantFailure = {
  invariant: 'I1' | 'I3-subset' | 'I3-floor';
  detail: string;
};

export type NormalizeResult = {
  /** The tools to offer. Always objects from `all`, in `all`'s order. */
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
 *
 * Quantified over `PERCEPTION(all)`, not over some global ideal: the filter
 * can only ever offer what the call site registered. A scoped sub-agent
 * registry of `[run_command, read_file, write_file, list_directory]` has no
 * browser tool to restore, so keeping the shell there is the status quo for
 * that agent and not a regression this filter introduced.
 */
export function checkFramingInvariant(
  all: readonly ToolDefinition[],
  selected: readonly ToolDefinition[],
): InvariantFailure | null {
  const triggers = selected.filter(isInvariantTrigger);
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
 * Normalise a candidate set and verify every invariant on the result.
 *
 * `candidate` is read for its NAMES only. Anything it carries that is not in
 * `all` is a caller bug and fails open rather than being laundered into the
 * result.
 */
export function normalizeToolSet(
  all: readonly ToolDefinition[],
  candidate: readonly ToolDefinition[],
): NormalizeResult {
  const failures: InvariantFailure[] = [];
  const registered = new Map(all.map((t) => [t.name, t]));

  // I3 (subset), checked on the CANDIDATE before any repair.
  const foreign = candidate.filter((t) => !registered.has(t.name));
  if (foreign.length > 0) {
    failures.push({ invariant: 'I3-subset', detail: `not in the input list: ${names(foreign).join(', ')}` });
    return { tools: [...all], failedOpen: true, failures, repaired: [] };
  }

  // Canonicalise immediately: from here on the candidate is a set of names
  // and every object comes from `all`.
  const keep = new Set(candidate.map((t) => t.name));
  const build = () => all.filter((t) => keep.has(t.name));

  let repaired: string[] = [];
  if (checkFramingInvariant(all, build())) {
    // Union, never subtraction. Both restore I1, but union only ever moves
    // the set toward the full list, so it cannot remove a capability the
    // task needs. Subtraction would let a crafted message delete
    // `run_command` from a turn where the person genuinely asked to run a
    // command -- a steerable denial-of-capability, a new bug of the same
    // family as the one this invariant exists to stop.
    const added = all.filter((t) => isFramedPerception(t) && !keep.has(t.name));
    for (const t of added) keep.add(t.name);
    repaired = names(added);
  }

  const tools = build();

  // Re-verify on the REPAIRED set. The repair is not trusted to be correct;
  // it is checked like anything else.
  const after = checkFramingInvariant(all, tools);
  if (after) failures.push(after);

  // I3 (floor). A set containment test against the tools the call site
  // actually passed -- not a length comparison against a hard-coded name
  // list, which is the off-by-one that made #475's guard unreachable
  // (`ask_for_clarification` is appended after filtering and can never be
  // counted; `request_approval` is only conditionally registered).
  const missingFloor = all.filter((t) => isFloorEligible(t) && !keep.has(t.name));
  if (missingFloor.length > 0) {
    failures.push({ invariant: 'I3-floor', detail: `floor tools dropped: ${names(missingFloor).join(', ')}` });
  }

  if (failures.length > 0) {
    return { tools: [...all], failedOpen: true, failures, repaired: [] };
  }
  return { tools, failedOpen: false, failures: [], repaired };
}
