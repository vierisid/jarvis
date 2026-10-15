/**
 * The remote browser snapshots ONE model loop has read, as ambient context
 * (#827).
 *
 * #676 records the newest `elem_gen` each READER saw from each sidecar, so a
 * reviewed click carries the generation of the snapshot its card was raised
 * against and the sidecar refuses it once the map has been refilled. The reader
 * is the site-playbook delivery scope, which tells a sub-agent (named) and a
 * workflow (suppressed) from the main orchestrator -- but every main-orchestrator
 * turn shares the one DEFAULT scope: each chat channel, the realtime voice route
 * and every task-tier call. So a snapshot taken by any of them between another
 * one's read and its card was what that card bound, and the sidecar's compare
 * then passed on the refill it exists to refuse.
 *
 * WHY A LOOP, and not a conversation. A snapshot's element ids are only in the
 * model's context for the loop that read them: `processMessage` and
 * `streamMessage` keep their tool results in a local buffer and persist only
 * the user's text and the final answer (`primary.addMessage`). The loop is
 * therefore the narrowest unit that can say "the snapshot this model read",
 * which is what a card should bind, and it has an owner that knows when it
 * starts. There is no conversation identity at the tool boundary to key a
 * wider one on, and none is needed.
 *
 * The exception is a PAUSED `processTaskCall`, which stores its whole buffer,
 * tool results included, and replays it on resume. Its generations are not
 * stored with it, so a resumed loop whose buffer holds a browser read is
 * marked `resumedWithReads` and fails closed instead of falling back.
 *
 * WHAT IT DOES NOT COVER, stated so nobody counts the entered loops and
 * concludes the hole is closed. A loop that raises a card for an element it
 * did not read itself -- ids the model carried over in its own text from an
 * earlier turn, or from another delegate's result -- has no entry here, and
 * falls back to the shared default record, exactly as before #827. The voice
 * route runs no loop of this kind, so its reads land only in that shared
 * record. This NARROWS the window to cards raised without a read of their own;
 * it does not close it for those.
 *
 * Held on the loop's own object rather than in a module map keyed by a loop
 * id, so nothing outlives the loop that needs cleaning up. Only an INLINE
 * approval carries the log to its execution (`getUiExecution` in
 * authority/approval.ts): a deferred one -- including an inline one demoted
 * after its wait timed out, whose loop may well still be running -- writes
 * only the shared record, because its result goes to a person and not to that
 * loop's model.
 *
 * NOT A GRANT. Like the delivery scope it sits beside, nothing here permits
 * anything: an entry only decides which generation a card copies, and the
 * sidecar does the comparing.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per canonical sidecar id, the `elem_gen` of the newest snapshot reply this
 * loop read, or null when the loop's newest read carried none. A null is an
 * answer, not an absence: it must not fall back to the shared record, which
 * could name another reader's map.
 */
export type SnapshotReadLog = {
  readonly generations: Map<string, string | null>;
  /**
   * The loop RESUMED a buffer that already holds snapshot replies -- a paused
   * `processTaskCall` replays its whole conversation, tool results included --
   * whose generations were not carried across the pause. With no entry of its
   * own for a sidecar, a card here must bind NOTHING (and be refused as
   * unverified until the loop snapshots again) rather than fall back to the
   * shared record: the pause can last as long as the person takes to answer,
   * and anything another reader snapshots meanwhile is in that record.
   */
  readonly resumedWithReads: boolean;
};

const store = new AsyncLocalStorage<SnapshotReadLog>();

/** A fresh, empty log for one model loop. */
export function newSnapshotReadLog(opts: { resumedWithReads?: boolean } = {}): SnapshotReadLog {
  return { generations: new Map(), resumedWithReads: opts.resumedWithReads === true };
}

/** Run `fn` as part of the loop that owns `log`. */
export function withSnapshotReadLog<T>(log: SnapshotReadLog, fn: () => T): T {
  return store.run(log, fn);
}

/** The log of the model loop this call runs in, or undefined outside one. */
export function currentLoopSnapshotReadLog(): SnapshotReadLog | undefined {
  return store.getStore();
}
