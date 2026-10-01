/**
 * "Can this sidecar serve that capability right now?", in one place (#611).
 *
 * THIS MODULE IMPORTS NOTHING, and that is a requirement rather than an
 * accident. Its first caller is `src/daemon/pebble-narration.ts`, which
 * imported nothing at all before this file existed. That purity is what keeps
 * a security-relevant routing decision assertable by reading one file, and it
 * is why #590's fail-closed branch could be tested at all.
 *
 * Note precisely what the property is and is not. It is about THIS module's
 * import graph, not about what a test costs to stand up: `pebble-narration.test.ts`
 * already imports `remote-element-point.ts`, `sidecar-route.ts`, `rpc.ts` and
 * `types.ts`. `capability-predicate.test.ts` pins the graph, because #611's
 * whole premise is that a comment asking people to remember something does not
 * hold.
 *
 * It lives under `src/sidecar/` because the field it reads is declared here
 * (`types.ts` `UnavailableCapability`) and both callers already import from
 * this directory. Not because `src/sidecar/` is a lower layer -- it is not:
 * `manager.ts` in this same directory imports runtime values from
 * `src/actions/`. What makes the placement safe is only this file's own
 * zero-import-ness, which no directory could guarantee.
 *
 * What it is NOT is `src/daemon/`. The single runtime-import direction in this
 * tree is daemon -> actions (the only `actions -> daemon` edge is an `import
 * type`), so a predicate in `src/daemon/` imported by
 * `src/actions/browser/remote-element-point.ts` would be the first inversion of
 * it. `src/util/` was the other candidate and is where this repo has
 * consolidated duplicates before (`util/redact.ts`, `util/subprocess-env.ts`,
 * both zero-import and both carrying a note about copies that drifted); it was
 * passed over only because the field belongs to the sidecar protocol.
 *
 * It must also be its OWN file: `src/sidecar/types.ts` imports `./compat.ts`,
 * so the predicate cannot go there without losing the zero-import property
 * that is the whole point.
 *
 * WHY IT IS SHARED. #611 counted three copies and asked for one. The count was
 * low. There are SIX:
 *
 *   1. `servesBrowser`              src/daemon/pebble-narration.ts
 *   2. `remoteBrowserPebbleTarget`  src/actions/browser/remote-element-point.ts
 *   3. `autoTargetForCapability`    src/actions/tools/sidecar-route.ts
 *   4. `resolveTarget`              src/workflows/runtime/machine-binding.ts
 *   5. `assertDispatch`             src/workflows/runtime/machine-binding.ts (negated)
 *   6. the dispatch gate            src/actions/tools/sidecar-route.ts (connected /
 *                                   unavailable / capabilities, as three returns)
 *
 * 1 and 2 are on this helper. 3, 4, 5 and 6 are not, for a mechanical reason:
 * both of those files were being edited by other in-flight changes when this
 * landed. This comment is the one place that records them, replacing the
 * separate notes that each asked the reader to remember the others -- which is
 * the specific thing #611 objected to.
 *
 * COPY 6 DOES NOT MATCH THE OTHER FIVE, and anyone moving it must know that.
 * Its capability term is
 *
 *     if (sidecar.capabilities && !sidecar.capabilities.includes(cap)) -> blocked
 *
 * so a sidecar whose `capabilities` array is ABSENT is ALLOWED through. Copies
 * 1-5, and this helper, reject it. Dropping this predicate into that gate
 * unchanged would turn a dispatch that works today into `CAPABILITY_DISABLED`.
 * It is a fail-open gate where the rest are fail-closed; that is a behaviour
 * change to decide on, not a refactor to apply.
 *
 * WHICH DIRECTION THE DRIFT IS DANGEROUS IN, which is worth more than the
 * count. State it as one rule:
 *
 *     copy 1 must never match FEWER sidecars than the gate the call will
 *     actually pass through.
 *
 * Not "stricter is safer" -- that is backwards here, and getting it backwards
 * is how this breaks. `localBrowserWillServe` returns true when NO sidecar
 * matches, and true means "narrate from this process's own coordinate cache".
 * So a copy 1 that matches too FEW sidecars is the failure: the narration
 * points into a local cache while the click runs on a sidecar, which is #585,
 * a confident pointer into an unrelated page.
 *
 * Measured today: copy 1 is EQUAL to copy 3, which is the gate every
 * auto-routed call passes. Copy 1 is STRICTER than copy 6, and that difference
 * is the hazard shape above rather than a comfort -- for a sidecar with an
 * absent `capabilities` array, copy 1 says "does not serve" while copy 6 would
 * dispatch to it happily.
 *
 * WHY THAT IS INERT ANYWAY, and the reason is reachability, not strictness:
 * copy 6 lives in `dispatchToSidecar`, which receives an ALREADY-RESOLVED
 * target. It therefore only ever sees a sidecar that copy 3 already selected
 * (fail-closed, so never the absent-array one) or a sidecar the caller named
 * outright -- and both narration predicates refuse outright when the tool call
 * carries an explicit `target`, and again when a machine scope is in force. So
 * the one input on which copies 1 and 6 disagree cannot reach a narration.
 * That is a fact about routing, and it would stop being true if narration ever
 * honoured a named target.
 *
 * WEAKER SIBLINGS, recorded because this comment claims to be the complete
 * record and a near-miss is how a seventh copy gets written. `src/daemon/index.ts`
 * has several `connected && capabilities.includes(X)` tests with NO
 * unavailability term -- `subPebbleCapableSidecars` is the clearest. They are
 * inert rather than correct: `sidecar/preflight.go` never reports `pebble` or
 * `windows` unavailable, and `sub_pebble` is not in that switch at all, so the
 * missing term can never fire for those capabilities. Any of them extended to
 * a capability preflight CAN mark unavailable needs the third term and should
 * come here.
 *
 * NOT A COPY: the `unavailable_capabilities?.find(...)` next to copy 6 that
 * reads the entry's `.reason` for an operator-facing error. That asks which
 * reason, not whether; a boolean cannot answer it. Nor are the UI's
 * capability listings, which display rather than route.
 */

/**
 * The narrowest shape the predicate needs, structural so every caller's own
 * sidecar type satisfies it with no conversion and no cast.
 *
 * `SidecarInfo` satisfies this, and so do the local literals
 * `pebble-narration.ts` and `remote-element-point.ts` already declare. Declared
 * here rather than imported because importing it would cost this module its
 * zero-import property for a type that is erased at runtime anyway.
 *
 * No `name` and no `id`, on purpose: a predicate that could see a name invites
 * a future caller to resolve BY name, which is the one thing
 * `remoteBrowserPebbleTarget` refuses to do.
 *
 * ALL THREE FIELDS OPTIONAL, which costs a compile-time warning that the
 * neighbouring file went out of its way to buy. `pebble-narration.ts` declares
 * `unavailable_capabilities` on its own routing type precisely so that a caller
 * assembling a narrower literal cannot silently disable the unavailability
 * term ("type-invisible soundness is one unrelated edit away from being
 * unsound"). Here the field CANNOT be required -- `SidecarInfo` declares it
 * optional, so requiring it would reject the real inventory type -- so the
 * protection is the fail-closed answers below plus that declaration upstream,
 * not this shape. A caller passing a literal with no `unavailable_capabilities`
 * gets term 3 vacuously satisfied and no warning; that is the hazard to know
 * about, and it is why the routing types keep declaring the field themselves.
 */
export type CapabilityBearer = {
  readonly connected?: boolean;
  readonly capabilities?: readonly string[];
  readonly unavailable_capabilities?: ReadonlyArray<{ readonly name: string }>;
};

/**
 * Whether this sidecar is connected, advertises `capability`, and is not
 * currently reporting it unavailable.
 *
 * ALL THREE TERMS, and the third is the one that is easy to drop. Advertising a
 * capability is not being able to serve it: a sidecar with no Chromium reports
 * `browser` AND lists it unavailable, and the router skips such a sidecar when
 * it routes. A predicate matching on the advertisement alone would answer "a
 * browser lives elsewhere" for a call about to run locally -- the exact
 * disagreement #590 found between two of the copies above.
 *
 * FAIL-CLOSED ON AN ABSENT `capabilities` ARRAY: `undefined` answers false. An
 * inventory entry that has not said what it serves is not evidence that it
 * serves this. See copy 6 in the header for the one site that does the
 * opposite.
 *
 * TRUTHINESS, NOT `=== true`, deliberately. The copies this replaces all
 * tested `!!connected` / `if (!s.connected) continue`, so `=== true` would
 * answer false for a `connected` that is truthy but not literally `true` --
 * six of the 200 inputs the test enumerates, none of them reachable under the
 * declared type (`connected: boolean`, set from `!!conn` in manager.ts). So
 * this is not a live bug either way; it is matching the gate on purpose, since
 * the rule above is about never matching fewer sidecars than the gate does,
 * and an unreachable divergence is still one fewer thing to re-derive.
 */
export function servesCapability(
  sidecar: CapabilityBearer,
  capability: string,
): boolean {
  return !!sidecar.connected
    && !!sidecar.capabilities?.includes(capability)
    && !sidecar.unavailable_capabilities?.some((u) => u.name === capability);
}
