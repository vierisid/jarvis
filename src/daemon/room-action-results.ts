/**
 * Waiting on a dashboard room to say whether it carried out a `room_action`
 * (#933).
 *
 * Room actions are broadcast; the room handler that runs them lives in the UI
 * and returns true or false to its action bus. The pebble's voice tab switch
 * used to broadcast and then announce "Switched X to Y." without that answer,
 * so a tab no room had was reported as switched. A caller that needs the
 * answer opens an entry here, sends its `resultId` with the action, and the
 * panel that ran it replies with `room_action_result`.
 *
 * The first answer settles the entry. For the pebble's requests only native
 * panels answer (a dashboard answers only a request addressed to it, and then
 * only its answer counts: see `answerer`, #965). The action is broadcast, so
 * every open panel of that room answers: a second panel of it on this
 * sidecar, or one on another sidecar. They run the same check and agree, except that Settings shows its
 * billing tab per client. Addressing the action to the one panel the pebble
 * meant would need the panel to know its native id, which it does not.
 *
 * NO IMPORTS: the UI bundles this file for ROOM_ACTION_QUEUE_TTL_MS.
 */

/**
 * How long a room's action bus keeps an action that arrived before the room
 * had registered a handler (a panel still mounting). After this the bus drops
 * it, so the daemon waits the same time: shorter, and a slow-mounting room's
 * real "yes" would be reported as no answer. It is not exact. The panel starts
 * its clock on arrival, after the daemon started its own, so a room that
 * mounts in the last transit time of the window can still answer after the
 * daemon gave up; the reply then says "didn't answer", which was so in time.
 */
export const ROOM_ACTION_QUEUE_TTL_MS = 5000;

export type RoomActionOutcome = 'accepted' | 'rejected' | 'no_answer';

export class RoomActionResults {
  private pending = new Map<string, { settle: (o: RoomActionOutcome) => void; answerer?: unknown }>();

  constructor(private readonly newId: () => string = () => crypto.randomUUID()) {}

  /**
   * Start waiting. `outcome` resolves on the first answer, or `no_answer` after
   * `timeoutMs`. With `answerer`, only an answer from that client counts
   * (#965): a dashboard voice turn asks the dashboard the user spoke to.
   */
  open(timeoutMs: number, answerer?: unknown): { id: string; outcome: Promise<RoomActionOutcome> } {
    const id = this.newId();
    const outcome = new Promise<RoomActionOutcome>((resolve) => {
      const timer = setTimeout(() => this.finish(id, 'no_answer'), timeoutMs);
      // A pending answer must not hold the daemon open at shutdown.
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, {
        settle: (o) => {
          clearTimeout(timer);
          resolve(o);
        },
        answerer,
      });
    });
    return { id, outcome };
  }

  /**
   * An answer from a client. Anything but a known id and a boolean is ignored:
   * this arrives over the dashboard socket, so it is not trusted to be well
   * formed, and an answer for an entry already settled changes nothing.
   */
  answer(id: unknown, accepted: unknown, from?: unknown): void {
    if (typeof id !== 'string' || typeof accepted !== 'boolean') return;
    const entry = this.pending.get(id);
    if (entry?.answerer !== undefined && entry.answerer !== from) return;
    this.finish(id, accepted ? 'accepted' : 'rejected');
  }

  /** Stop waiting now: the action reached no one who could answer. */
  abandon(id: string): void {
    this.finish(id, 'no_answer');
  }

  /** Stop waiting on everything only `answerer` could answer: it has gone. */
  abandonAnswerer(answerer: unknown): void {
    if (answerer === undefined) return;
    for (const [id, entry] of [...this.pending]) {
      if (entry.answerer === answerer) this.finish(id, 'no_answer');
    }
  }

  /** Entries still waiting. */
  get size(): number {
    return this.pending.size;
  }

  private finish(id: string, outcome: RoomActionOutcome): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.settle(outcome);
  }
}
