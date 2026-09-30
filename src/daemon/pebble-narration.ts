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
 */

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
   * handler) and no RPC carries them back, so there is no honest point to
   * give -- and pointing at the local browser's idea of element 5 instead
   * would be the worst answer available: a confident pointer into an
   * unrelated page.
   *
   * The unblock is a read-only coords RPC on the sidecar, mapped at read
   * authority rather than routed through `browser_evaluate`. Until then remote
   * browsers narrate without a pointer, the same way a sidecar-routed
   * `desktop_click` already does -- its cache is only ever filled by a local
   * snapshot, so its narration has always failed closed here.
   */
  localBrowserWillServe: () => boolean;
  /** The controller's cached centre for that snapshot id (its click's input). */
  snapshotElementPoint: (elementId: number) => { x: number; y: number } | null;
  /** Element-independent viewport origin on screen, read out of the page's reach. */
  viewportScreenOrigin: () => Promise<{ x: number; y: number } | null>;
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
  }>;
  /** This process's own hostname. */
  selfHostname: string;
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
 * an ordinary deployment this is false and browser actions narrate without a
 * pointer. That is the honest end of the trade, not an oversight -- see
 * BrowserNarrationDeps.localBrowserWillServe.
 */
export function localBrowserWillServe(routing: NarrationRouting): boolean {
  const target = routing.args.target;
  if (typeof target === 'string' && target.trim()) return false;
  // Defensive rather than load-bearing: the machine binding is entered only by
  // the workflow runtime, and narration runs on the ambient-UI stream. Checked
  // anyway because a binding, where one exists, picks the machine whatever the
  // inventory says.
  if (routing.machineScoped) return false;
  for (const s of routing.sidecars) {
    if (s.connected && s.capabilities?.includes('browser')) return false;
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
    return { kind: 'unplaced', reason: 'the browser serving this call is not the local one' };
  }
  const point = deps.snapshotElementPoint(id);
  if (!point) {
    return { kind: 'unplaced', reason: `no live snapshot minted element [${id}]` };
  }
  const origin = await deps.viewportScreenOrigin();
  if (!origin) {
    return { kind: 'unplaced', reason: 'could not read the viewport position on screen' };
  }
  return {
    kind: 'point',
    x: Math.round(origin.x + point.x),
    y: Math.round(origin.y + point.y),
  };
}
