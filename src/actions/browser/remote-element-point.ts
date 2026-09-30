/**
 * Pointing the pebble at a browser action that runs on a SIDECAR (#591).
 *
 * #585 made the pebble narration point at the element the snapshot actually
 * named, and fail closed -- `(location unknown)`, the pebble does not move --
 * when no honest coordinate is available. That was the right trade and both
 * reviewers agreed, but it meant the pointer went quiet on almost every
 * install, because `CapBrowser` is in the sidecar's DEFAULT capability set
 * (`sidecar/config.go`): the click routes to the sidecar, its coordinates live
 * in that process's own Go map, and nothing carried them back. This module is
 * the other half, and #590 is wired to it.
 *
 * ONE RULE, inherited from `src/daemon/pebble-narration.ts` and not weakened
 * here: a narration reads the coordinates the ACTION will use, and never
 * re-derives them. What this adds is a way to read them from the machine that
 * holds them, over a read-authority RPC, instead of giving up. What it must
 * not add is a second answer to "which element" or "which machine".
 *
 * Three things follow from that, and each is the reason for one of the checks
 * below:
 *
 *   - It may only ask the sidecar that will SERVE the click, because a
 *     coordinate is a position in one browser's viewport.
 *   - It may only ask the sidecar that DRAWS the pebble, because the answer is
 *     a position on that machine's screen. Those must be the same sidecar.
 *   - It must not resolve either of those by calling the router, for #585's own
 *     reason one level up: the narration fires on the `tool_call` event and the
 *     tool runs after the stream finishes, so a live inventory read here is
 *     resolved at a different instant than the one the tool will use.
 *
 * WHERE THIS IS WIRED, past tense: #590 applied the handoff. The dep is
 * `BrowserNarrationDeps.remoteElementPoint` (src/daemon/pebble-narration.ts),
 * it is consumed INSIDE `browserElementNarration`'s `!localBrowserWillServe()`
 * check -- inside, never after, so `deps.snapshotElementPoint` stays
 * unreachable for a remote browser -- and `resolveToolNarration`
 * (src/daemon/index.ts) builds it from one routing object per narration. That
 * placement is the load-bearing part; see `browserElementNarration` for why it
 * is structural rather than a convention.
 *
 * The two type claims that made it fit were checked rather than assumed, and
 * both held with no adapter and no cast: `NarrationRouting` satisfies
 * `RemotePointRouting` structurally, and `RemoteElementPoint` is assignable to
 * `PebbleNarration`.
 *
 * The dep stays OPTIONAL although the one production caller always supplies it.
 * That keeps this module out of the narration's hard dependencies -- a
 * narration is cosmetic and runs before the action it previews is approved, so
 * `pebble-narration.ts` must stay a pure decision over its inputs, with the
 * fail-closed answer reachable and unit-testable without a sidecar at all.
 */

import { routeBrowserElementPointToSidecar, type ElementPointRefusal } from '../tools/sidecar-route.ts';
import { ActionOutcomeError } from '../action-outcome.ts';

/**
 * The routing facts this module decides on, gathered once by the caller.
 *
 * Structurally the same shape `pebble-narration.ts` already assembles for its
 * own predicates (`NarrationRouting`), so #590's object satisfies this without
 * a conversion. Declared here rather than imported because that file is not on
 * main yet and this one must compile and be tested without it.
 */
export type RemotePointRouting = {
  /** The sidecar drawing the pebble. */
  readonly pebbleSidecarId: string;
  /** Every sidecar the manager knows, as it reports them. */
  // No `name`. The narrowest shape that satisfies the predicate, on purpose:
  // an unused name field invites a future reader to resolve BY name, which is
  // the one thing remoteBrowserPebbleTarget below refuses to do.
  readonly sidecars: ReadonlyArray<{
    readonly id: string;
    readonly connected: boolean;
    readonly hostname?: string | null;
    readonly capabilities?: readonly string[];
    readonly unavailable_capabilities?: ReadonlyArray<{ readonly name: string }>;
  }>;
  /** Whether a workflow machine binding is in force. */
  readonly machineScoped: boolean;
  /** The tool call's arguments, for an explicitly named target. */
  readonly args: Record<string, unknown>;
};

/** Where the pebble should fly, or why it is not flying. */
export type RemoteElementPoint =
  | { readonly kind: 'point'; readonly x: number; readonly y: number }
  | { readonly kind: 'unplaced'; readonly reason: string };

/**
 * The sidecar to ask for a coordinate, or null when there is no unambiguous
 * answer.
 *
 * Deliberately narrower than the router, and deliberately NOT the router. The
 * conditions:
 *
 *   1. No explicit `target` on the tool call. A named target would have to be
 *      resolved by `findSidecar`, whose last resort is a SUBSTRING match on the
 *      sidecar's name -- so honouring one would mean a second, looser
 *      resolution of which machine serves the call, evaluated at a different
 *      instant than the tool's own. That is the #585 mistake one level up, and
 *      refusing costs a pointer on a call that names a machine explicitly,
 *      which is rare.
 *   2. No machine scope. A workflow binding picks the machine whatever the
 *      inventory says. Defensive rather than load-bearing -- narration runs on
 *      the ambient-UI stream and bindings are entered by the workflow runtime.
 *      Note it is a PRECONDITION, not a fence: if this ever runs inside a
 *      workflow-run context the dispatch re-resolves through
 *      `getMachineScope()` and a blocked binding throws, which is why
 *      `remoteBrowserElementPoint` keeps its try/catch. It is not a RACE with
 *      this check -- `getMachineScope` reads an `AsyncLocalStorage` store and a
 *      scope cannot be entered into a context that is already running, so both
 *      reads see the same store.
 *   3. EXACTLY ONE connected sidecar advertising `browser`, and it must be the
 *      sidecar drawing the pebble. One, because with two the router takes
 *      whichever comes first in `listSidecars()` order and this module must not
 *      guess at that; the pebble's own, because the coordinate is a position on
 *      that machine's screen and pointing at it from another machine's geometry
 *      would be a confident mark where the user is not looking.
 *
 * With exactly one browser-capable sidecar, any resolution the tool later does
 * must land on the same one or fail, which is what makes this safe without
 * re-running the router.
 *
 * Over-refusal is the only direction this can be wrong in.
 */
export function remoteBrowserPebbleTarget(routing: RemotePointRouting): string | null {
  const target = routing.args.target;
  if (typeof target === 'string' && target.trim()) return null;
  if (routing.machineScoped) return null;

  const browserCapable = routing.sidecars.filter((s) =>
    s.connected
    && s.capabilities?.includes('browser')
    && !s.unavailable_capabilities?.some((u) => u.name === 'browser'));
  if (browserCapable.length !== 1) return null;

  const only = browserCapable[0]!;
  return only.id === routing.pebbleSidecarId ? only.id : null;
}

/**
 * Why there is no pointer, in words, naming the machine that would not give one.
 *
 * Brain-authored, one per refusal the RPC can report, so the sentence that
 * reaches a log line is entirely ours. Nothing from the sidecar's error text is
 * interpolated: it is remote-controlled, and the refusals it can carry include
 * the local-content one, whose shared wording embeds the page URL -- #594
 * refused to put a URL in a log line for exactly that reason, a refused URL
 * being the value most likely to be carrying the characters that must not reach
 * one.
 *
 * THE SIDECAR ID IS IN THE REASON, and that is why this module logs nothing
 * itself. #591 asks for a skipped-coordinate line, and the caller already
 * writes one for every unplaced narration ("no pebble pointer for <tool>:
 * <reason>", src/daemon/index.ts on #590's branch). A second line from here
 * would duplicate the tool and the reason to add only the machine -- so the
 * machine goes in the reason instead, the caller's one line carries tool,
 * machine and cause together, and this module keeps no log sink of its own to
 * leave untested.
 */
function refusalReason(why: ElementPointRefusal, sidecarId: string): string {
  switch (why) {
    case 'no_reply': return `sidecar "${sidecarId}" did not answer`;
    case 'sidecar_too_old': return `sidecar "${sidecarId}" predates the element-coordinate RPC`;
    case 'refused': return `sidecar "${sidecarId}" has no current coordinate for that element`;
    case 'unusable_reply': return `sidecar "${sidecarId}" answered a coordinate this daemon will not use`;
  }
}

/**
 * Whether this is an id a snapshot could have minted.
 *
 * Checked here as well as by the caller because this is an EXPORTED boundary
 * and `number` is erased at runtime -- and because `remoteBrowserNarration`
 * takes a `routing` that CONTAINS `args`, so
 * `remoteBrowserNarration(routing, routing.args.element_id as number)` is the
 * natural mistake for a second caller to make.
 *
 * Duplicating the caller's check is safe precisely because it is idempotent:
 * one integer against one rule cannot disagree with itself. That is a different
 * thing from #585, which was two different DERIVATIONS of which element -- a
 * fresh `querySelectorAll` with a narrower selector and 0-based indexing versus
 * the cached map. Re-deriving is the bug; re-checking is not.
 */
function isSnapshotElementId(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

/**
 * Ask the sidecar where the element is, and say why not when it will not tell
 * us.
 *
 * Nothing this function throws. A narration is cosmetic and runs before the
 * action it previews has been approved, so a failure to place it must never
 * fail the turn.
 */
export async function remoteBrowserElementPoint(
  sidecarId: string,
  elementId: number,
): Promise<RemoteElementPoint> {
  if (!isSnapshotElementId(elementId)) {
    return { kind: 'unplaced', reason: 'element_id is not a snapshot id' };
  }
  let outcome;
  try {
    outcome = await routeBrowserElementPointToSidecar(sidecarId, elementId);
  } catch (err) {
    // The dispatch resolves a workflow machine binding BEFORE its own try
    // block, and a blocked binding throws. Reachable only if a narration is
    // ever driven from inside a workflow-run context -- an AsyncLocalStorage
    // scope cannot be entered into a context already running, so this is not a
    // race with the `machineScoped` precondition, it is the case where a scope
    // was already in force. Cosmetic path: turn it into words, never propagate.
    //
    // The CODE, never the message: these codes are brain-authored
    // (WORKFLOW_RETARGET_REQUIRED and friends) and the message is not
    // guaranteed to be.
    const code = err instanceof ActionOutcomeError ? err.outcome.code : 'unknown';
    return {
      kind: 'unplaced',
      reason: `the coordinate request to sidecar "${sidecarId}" was refused (${code})`,
    };
  }

  if (outcome.kind === 'point') {
    // `loaderId` is deliberately dropped here. It is the pairing token that
    // made the coordinate checkable, not a value to carry onward: it comes from
    // another machine, and the reason string it would join is written to a log.
    return { kind: 'point', x: outcome.x, y: outcome.y };
  }
  return { kind: 'unplaced', reason: refusalReason(outcome.why, sidecarId) };
}

/**
 * Both halves together, for the caller that has the routing facts and an id.
 *
 * Returns `unplaced` rather than null when there is no sidecar to ask, because
 * a tool that addresses an element still owes the user an answer: a pebble that
 * quietly does not move looks exactly like one the user blinked past, which is
 * the whole reason #585 added the "(location unknown)" amendment.
 *
 * The predicate is a GATE, not a hint: when it says no, no RPC is sent at all.
 */
export async function remoteBrowserNarration(
  routing: RemotePointRouting,
  elementId: number,
): Promise<RemoteElementPoint> {
  if (!isSnapshotElementId(elementId)) {
    return { kind: 'unplaced', reason: 'element_id is not a snapshot id' };
  }
  const sidecarId = remoteBrowserPebbleTarget(routing);
  if (sidecarId === null) {
    return { kind: 'unplaced', reason: 'the browser serving this call is not one we can locate' };
  }
  return remoteBrowserElementPoint(sidecarId, elementId);
}
