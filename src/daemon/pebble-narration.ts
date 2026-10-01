/**
 * Pebble action narration -- resolving WHERE to point, and saying so honestly
 * when we cannot.
 *
 * The pebble flies to the element a tool is about to act on, with a label, a
 * moment before the action fires. That flight is not decoration: it is the
 * rendering of "this is what you are approving", so it has to name the same
 * element the action will take. #585 was the case where it did not -- the
 * browser narration re-resolved the snapshot's `element_id` by running a fresh
 * `querySelectorAll` inside the page, with a narrower selector than the
 * snapshot's and 0-based indexing against the snapshot's 1-based ids. Six
 * ids on a six-element page, six different elements.
 *
 * ONE RULE for everything in here: a narration reads the coordinates the
 * ACTION will use, and never re-derives them. Concretely that means
 *
 *   - nothing that CHOOSES an element: no selector, no index arithmetic, no
 *     DOM query. There is one narrow carve-out, and it is deliberately narrow:
 *     `viewportScreenOrigin` does evaluate script in the page to read where
 *     the viewport sits on screen. It asks only about the window, never about
 *     an element, and it asks in an isolated world. So the narration still
 *     runs script; what it can no longer do is let the page pick the element;
 *   - no action- or evaluate-class RPC. A narration runs on the `tool_call`
 *     stream event, i.e. BEFORE the action it previews has been approved or
 *     executed, and `dispatchRPC` reaches past the tool registry and so past
 *     the authority map (`browser_evaluate` is `execute_command` there) and
 *     past the local-tool kill switches. The old implementation dispatched
 *     `browser_evaluate`, which on a sidecar with a cold browser would also
 *     lazily launch a headed Chromium for a cosmetic code path;
 *   - no second resolution of WHICH machine will serve the call. Re-running
 *     the router here would be a live re-read of the sidecar inventory
 *     resolved at a different instant than the one the tool will use, which is
 *     the #585 mistake again one level up.
 *
 * When any of that leaves us without a point, the answer is `unplaced` and the
 * bubble says so. A pebble that quietly does not move looks exactly like a
 * pebble the user blinked past, so "we could not tell you" has to read
 * differently from "here it is".
 *
 * THIS FILE IMPORTS ONE THING, and that is still the point of it. It imported
 * nothing until #611 shared the capability predicate, and the module it now
 * imports has no imports of its own -- so every decision here remains a pure
 * function of its arguments, assertable by reading this file, with no daemon,
 * no sidecar and no browser stood up. That is what makes #590's fail-closed
 * branch testable. Anything with a dependency of its own does not belong here.
 */

import { servesCapability } from '../sidecar/capability-predicate.ts';

/** Where the pebble should fly, or why it is not flying. */
export type PebbleNarration =
  | { kind: 'point'; x: number; y: number }
  | { kind: 'unplaced'; reason: string };

/**
 * What the narration needs to place a browser element, all of it injected so
 * the decision is testable without a daemon, a sidecar or a browser.
 */
export type BrowserNarrationDeps = {
  /**
   * Whether the click/type will run on the daemon's own BrowserController, on
   * the machine whose screen the pebble is drawn on.
   *
   * False is the fail-closed answer, and the caller answers false on any hint
   * of a browser somewhere else -- note that a sidecar advertises `browser` in
   * its DEFAULT capability set, so on an ordinary deployment this is false and
   * browser actions narrate without a pointer. That is the honest end of the
   * trade #585 forces, not an oversight: the click really does run in the
   * sidecar's browser there, so the local coordinates are not its input.
   *
   * A sidecar-routed browser keeps its snapshot coordinates in the sidecar
   * (sidecar/browser_snapshot.go holds the same map, read by its own click
   * handler), so the local coordinates are not the click's input and pointing
   * at the local browser's idea of element 5 would be the worst answer
   * available: a confident pointer into an unrelated page. False here does NOT
   * mean "no pointer" any more -- it means "not from this process's cache", and
   * `remoteElementPoint` is where the answer comes from instead.
   */
  localBrowserWillServe: () => boolean;
  /**
   * Where the element is, asked of the machine that actually holds the
   * coordinates, for the case `localBrowserWillServe` just refused (#591).
   *
   * This is what unparked #585. `CapBrowser` is in the sidecar's DEFAULT
   * capability set, so on an ordinary install the predicate above is false and
   * the branch it guards was the only one browser actions ever reached --
   * correct, and quiet on almost every deployment. #591 added a read-only
   * `browser_element_point` RPC, so the coordinates can now be read FROM the
   * process that holds them rather than re-derived here.
   *
   * INJECTED, and optional, for two reasons that are the same reason: this file
   * must stay a pure decision over its inputs, testable with no daemon and no
   * sidecar, and the one rule above ("a narration reads the coordinates the
   * ACTION will use, and never re-derives them") has to be enforceable by
   * reading this file alone. So the RPC, the routing and the refusal wording
   * live in `src/actions/browser/remote-element-point.ts`, and when the dep is
   * absent the answer is the same fail-closed `unplaced` as before.
   *
   * It must NEVER be a fallback to a re-query. It answers `unplaced` for an
   * old sidecar (`METHOD_NOT_FOUND`), a stale snapshot, an ambiguous inventory
   * or a pebble on another machine, and nothing downstream of it may then try
   * `snapshotElementPoint`, `browser_evaluate` or a fresh DOM lookup -- see
   * `browserElementNarration` for why that is structural rather than a
   * convention.
   */
  remoteElementPoint?: (elementId: number) => Promise<PebbleNarration>;
  /** The controller's cached centre for that snapshot id (its click's input). */
  snapshotElementPoint: (elementId: number) => { x: number; y: number } | null;
  /**
   * The viewport's origin on screen, read out of the page's reach, and
   * `'moved'` when the document the snapshot's ids were minted under is no
   * longer the one on screen.
   *
   * That third answer is not a geometry failure and does not share a reason
   * with one: #592 made the action itself refuse on a document change, so
   * `'moved'` is the case where a point exists in the cache and previewing it
   * would be a confident pointer at an action that is about to refuse. The
   * controller answers it from the frame-tree read this same call already
   * makes, so there is one reading rather than two that can disagree, and it
   * mirrors every one of the action's document terms -- including a FRAME
   * digest change for an id that came from a subframe, which a main-frame
   * check alone misses.
   *
   * It takes the id only to ask whether that id was minted in a frame. That is
   * a membership test over ids this process already minted, so it cannot become
   * a second answer about WHICH element -- re-deriving is the #585 bug,
   * re-checking is not.
   */
  viewportScreenOrigin: (elementId: number) => Promise<{ x: number; y: number } | 'moved' | null>;
};

/** What the routing predicates need to know, with no daemon attached. */
export type NarrationRouting = {
  /** The sidecar drawing the pebble. */
  pebbleSidecarId: string;
  /** Every sidecar the manager knows, as it reports them. */
  sidecars: ReadonlyArray<{
    id: string;
    connected: boolean;
    hostname?: string | null;
    capabilities?: readonly string[];
    /**
     * Capabilities the sidecar advertises but cannot currently serve -- no
     * Chromium installed, a missing dependency. `SidecarInfo` has carried this
     * since before either PR.
     *
     * DECLARED, not merely passed through. `remote-element-point.ts` filters on
     * this field and the filter was sound only because `narrationRouting` hands
     * `listSidecars()` over verbatim, which TypeScript could not see: any caller
     * building this object from a narrower literal -- a test, a future call site
     * -- silently disabled the filter and got a pointer aimed by an inventory
     * entry the router would have skipped. Type-invisible soundness is one
     * unrelated edit away from being unsound, so the shape says it now.
     */
    unavailable_capabilities?: ReadonlyArray<{ name: string }>;
  }>;
  /** This process's own hostname. */
  selfHostname: string;
  /**
   * Whether this process's own browser is allowed to serve a call at all --
   * false under `--no-local-tools` or a hosted install's `browser.local: false`.
   *
   * Part of the routing facts rather than read here, so this file stays a pure
   * decision over its inputs. Without it `localBrowserWillServe` could answer
   * true on a host where `browser_click` refuses outright, which contradicts
   * the predicate's own contract ("will run on this process's own
   * BrowserController"). Inert today, because the same guards keep
   * `elementCoords` empty on such a host so the answer is `unplaced` either
   * way -- but with the wrong cause, and it stops being inert the moment any
   * path populates that cache.
   */
  localBrowserEnabled: boolean;
  /** Whether a workflow machine binding is in force. */
  machineScoped: boolean;
  /** The tool call's arguments, for an explicitly named target. */
  args: Record<string, unknown>;
};

/** Hostnames from two runtimes on one box: same syscall, but do not bet on the case. */
function sameHost(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (h: string | null | undefined) => (h ?? '').trim().toLowerCase().replace(/\.$/, '');
  const x = norm(a);
  return x !== '' && x === norm(b);
}

/**
 * Whether the pebble is drawn on the machine this process runs on.
 *
 * Both narration sources are LOCAL caches -- the browser controller's
 * `elementCoords` and the desktop tools' `localElementCache`, each filled only
 * by a snapshot taken here. Their coordinates are positions on THIS host's
 * screen, and the pebble flies on the sidecar's. Off-host, a pointer built
 * from them is a confident mark at a position that means nothing where the
 * user is looking.
 *
 * Fail-closed on a sidecar that reports no hostname: an unknown machine is not
 * evidence of the same machine.
 */
export function pebbleIsOnThisHost(routing: NarrationRouting): boolean {
  const pebble = routing.sidecars.find((s) => s.id === routing.pebbleSidecarId);
  return sameHost(pebble?.hostname, routing.selfHostname);
}

/**
 * Whether the sidecar can actually serve `browser` right now.
 *
 * NO LONGER A COPY (#611). The three terms -- connected, advertised, not
 * listed unavailable -- are `servesCapability` in
 * src/sidecar/capability-predicate.ts, which every account of why they belong
 * together now lives in, including which other call sites still hold their own
 * version and which one of them does NOT agree.
 *
 * That module is the only thing this file imports, and it imports nothing
 * itself, so the property that matters here is intact: the routing decision
 * below is still assertable by reading this file, with no daemon, no sidecar
 * and no browser to stand up. `capability-predicate.test.ts` pins that rather
 * than asking a reader to preserve it.
 *
 * Why the predicate must keep the unavailability term: matching on the
 * advertisement alone refused a pointer for a click that was about to run
 * locally with honest coordinates sitting in the local cache -- see
 * `localBrowserWillServe`.
 */
function servesBrowser(sidecar: NarrationRouting['sidecars'][number]): boolean {
  return servesCapability(sidecar, 'browser');
}

/**
 * Whether a browser_* call with these arguments will run on this process's own
 * BrowserController, on the machine whose screen the pebble is drawn on.
 *
 * Deliberately more conservative than the router, and deliberately NOT the
 * router: calling `resolveToolTarget` here would log a routing decision that
 * is not happening, could throw on a machine-scope violation, and -- the
 * reason that matters -- would read a live sidecar inventory at a different
 * instant than the tool will. Narration fires on the tool_call event and the
 * tool runs after the stream finishes, so a sidecar connecting in between
 * would make the two answers differ, which is #585 again one level up. So this
 * answers false on any hint of a browser somewhere else, and over-refusal is
 * the only direction it can be wrong in.
 *
 * Note what that means in practice: a sidecar advertises `browser` in its
 * DEFAULT capability set, and the pebble's own sidecar is in this list, so on
 * an ordinary deployment this is false. That no longer means "no pointer" --
 * `BrowserNarrationDeps.remoteElementPoint` asks the machine that holds the
 * coordinates instead (#591). What this predicate answers is narrower than it
 * once was: not "can we point" but "are the coordinates in THIS process".
 */
export function localBrowserWillServe(routing: NarrationRouting): boolean {
  // A host that refuses local browser calls has no local browser to serve one,
  // whatever the inventory says. First, because it is the most absolute of the
  // terms and the cheapest.
  if (!routing.localBrowserEnabled) return false;
  const target = routing.args.target;
  if (typeof target === 'string' && target.trim()) return false;
  // Defensive rather than load-bearing: the machine binding is entered only by
  // the workflow runtime, and narration runs on the ambient-UI stream. Checked
  // anyway because a binding, where one exists, picks the machine whatever the
  // inventory says.
  if (routing.machineScoped) return false;
  // UNAVAILABLE COUNTS AS ABSENT, matching the router. Advertising `browser`
  // is not the same as being able to serve it: a sidecar with no Chromium
  // reports the capability and lists it unavailable, `autoTargetForCapability`
  // skips it, and the call falls back to THIS process's browser. Matching on
  // the advertisement alone made this the one case where the two narration
  // predicates disagreed -- this one said "a browser lives elsewhere" while
  // `remoteBrowserPebbleTarget` filtered the same sidecar out and found nothing
  // to ask, so the user got "(location unknown)" for a click that really did
  // run here with honest coordinates already in the local cache.
  for (const s of routing.sidecars) {
    if (servesBrowser(s)) return false;
  }
  return pebbleIsOnThisHost(routing);
}

/**
 * The snapshot id in a tool call, or null if there is not one.
 *
 * Not coerced. Both `browser_click` and `desktop_click` pass `element_id`
 * straight to a number-keyed Map, so the string "5" misses there and the
 * action fails -- and a confident pointer for an action that will not happen
 * is the same narration/action disagreement, in the harmless direction.
 */
export function snapshotElementId(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

/** Suffix a bubble label carries when we could not place the pointer. */
const UNPLACED_SUFFIX = ' (location unknown)';

/**
 * The bubble text for a narration that has no pointer to show.
 *
 * Plain ASCII, and short enough to fit the bubble rather than be ellipsised:
 * the card wraps to a fixed width and truncates with an ellipsis rather than
 * enforcing any character count, so the budget is visual. The longest real
 * case is "Clicking element [12] (location unknown)", which is shorter than
 * labels the bubble already carries ("Delegating to ...", "Running ...").
 *
 * It states the absence as a fact about what we can show, not as an error the
 * user is asked to act on, because in the remote-browser case nothing has gone
 * wrong -- we simply do not have the coordinates.
 */
export function unplacedLabel(label: string): string {
  return label.endsWith(UNPLACED_SUFFIX) ? label : label + UNPLACED_SUFFIX;
}

/**
 * Resolve where to point for a browser `element_id`, or why we cannot.
 *
 * Order matters: the routing check comes first, so a sidecar-routed call never
 * reads the local cache at all. That cache can hold a live snapshot of some
 * OTHER page the model visited locally, and a hit on it would look exactly as
 * authoritative as a real one.
 */
export async function browserElementNarration(
  elementId: unknown,
  deps: BrowserNarrationDeps,
): Promise<PebbleNarration> {
  const id = snapshotElementId(elementId);
  if (id === null) {
    // Snapshot ids are 1-based integers. Anything else was never minted.
    return { kind: 'unplaced', reason: 'element_id is not a snapshot id' };
  }
  if (!deps.localBrowserWillServe()) {
    // INSIDE the check, and it RETURNS. That placement is the whole guarantee:
    // a remote browser's answer is this branch's answer, so `deps` below --
    // `snapshotElementPoint`, this process's own cache -- is unreachable for
    // one, whether the remote answered a point, refused, or was never asked.
    // Placed after the check instead, an old sidecar's `unplaced` would fall
    // through to a local cache that may hold a live snapshot of some OTHER page
    // the model visited locally, and a hit there would look exactly as
    // authoritative as a real answer. #591's version matrix requires that
    // nothing falls back to `browser_evaluate`, to the local coordinates, or to
    // a DOM re-query; this is where that is enforced rather than promised.
    return deps.remoteElementPoint
      ? await deps.remoteElementPoint(id)
      : { kind: 'unplaced', reason: 'the browser serving this call is not the local one' };
  }
  const point = deps.snapshotElementPoint(id);
  if (!point) {
    return { kind: 'unplaced', reason: `no live snapshot minted element [${id}]` };
  }
  const origin = await deps.viewportScreenOrigin(id);
  if (origin === 'moved') {
    // Its own reason, not the geometry one: this is the case the user most
    // needs distinguished in a log line, because the coordinate WAS there and
    // pointing at it is precisely what would have previewed an action that is
    // about to refuse.
    return { kind: 'unplaced', reason: `the page left the document element [${id}] came from` };
  }
  if (!origin) {
    return { kind: 'unplaced', reason: 'could not read the viewport position on screen' };
  }
  // THE SPACE, named rather than left to the reader (#604). Both terms are
  // Chromium device-independent pixels -- `viewportScreenOrigin` reads the
  // window's screen position and `snapshotElementPoint` holds a CSS-px centre
  // within it -- so the sum is `screen_dip`, the same space the sidecar names
  // on the wire for the remote branch above. That equals the pebble's own
  // space (`PEBBLE_SCREEN_SPACE` in pebble-point-prompt.ts) on macOS and
  // Linux, and on Windows at 100% DPI. Spelled out in words rather than
  // imported: this file's zero-dependency property is the point of it.
  //
  // No scale term here, and that is load-bearing: #590's first version
  // multiplied by `devicePixelRatio`, which was wrong on two of three
  // platforms and threw the pebble most of a screen away. (The in-tree prose
  // at sidecar/browser_element_point.go credits that removal to #585; `git
  // log -S devicePixelRatio` says it was #590. Noted rather than silently
  // picked, since the two files sit beside each other.)
  return {
    kind: 'point',
    x: Math.round(origin.x + point.x),
    y: Math.round(origin.y + point.y),
  };
}
