/**
 * What an approved call was reviewed against, as ambient context for the one
 * execution that approval buys (#676).
 *
 * A reviewed REMOTE browser click, type or hover has to tell the sidecar which
 * snapshot the person approved it against, so the sidecar -- which owns the
 * element map's generation -- can refuse it when the map has been refilled
 * since. The generation is captured by the tool's `captureApprovalGuard` at
 * review time, and the call it binds runs later, from the approval executor,
 * through `ToolRegistry.execute(name, params)`.
 *
 * WHY AMBIENT, and not a parameter. `ToolDefinition.execute(params)` takes the
 * model's arguments and nothing else, and a reviewed generation passed as an
 * argument would be one the model can write -- and would also change the
 * arguments the approval compares byte for byte. Same reasoning as the
 * site-playbook delivery scope (#586), which carries a per-call fact the same way.
 *
 * WHY NOT RE-READ AT EXECUTION. The brain records the newest generation each
 * sidecar reported, so reading it again when the call runs would hand the
 * sidecar the generation of whatever snapshot came LAST -- one the person never
 * saw -- and the comparison would pass on exactly the interleaving it exists to
 * refuse. The value has to be the one captured when the card was raised.
 *
 * ABSENT means "not an approved execution": the realtime voice path, which
 * auto-approves and reviews nothing, and every ungated call. A tool keeps its
 * pre-#676 behaviour there. PRESENT is entered by the approval executor for
 * every UI call it runs, with whatever the guard bound -- possibly nothing --
 * so a remote element action that finds the scope but no snapshot in it was
 * reviewed by a guard that bound none, and refuses rather than running unbound.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** The remote snapshot a reviewed element action was approved against. */
export type ReviewedRemoteSnapshot = {
  /** Canonical sidecar id the call was reviewed for, or null if none resolved. */
  readonly sidecarId: string | null;
  /**
   * The `elem_gen` that sidecar's newest snapshot reply carried when the card
   * was raised, or null when none had (an older sidecar, or no snapshot this
   * process saw).
   */
  readonly elemGen: string | null;
};

/** Everything a guard bound at review that its execution needs to send. */
export type ReviewedExecution = {
  readonly remoteBrowserSnapshot?: ReviewedRemoteSnapshot;
  /**
   * The snapshot reader that raised the card (`currentSnapshotReader` in
   * sidecar-route.ts), so a snapshot the approved call itself takes -- an
   * approved `browser_navigate` -- is recorded as THAT reader's and not as
   * the executor's.
   */
  readonly reader?: string;
};

const store = new AsyncLocalStorage<ReviewedExecution>();

/**
 * Run `fn` as the execution of an approved call that was reviewed against
 * `reviewed`. Undefined runs `fn` outside any reviewed scope.
 */
export function runAsReviewed<T>(reviewed: ReviewedExecution | undefined, fn: () => T): T {
  return reviewed ? store.run(reviewed, fn) : fn();
}

/** What the call now running was reviewed against, or undefined if it was not. */
export function currentReviewedExecution(): ReviewedExecution | undefined {
  return store.getStore();
}
