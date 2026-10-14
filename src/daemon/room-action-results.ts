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
 * it, so the classifier and pebble paths wait the same time: shorter, and a
 * slow-mounting room's real "yes" would be reported as no answer. The
 * realtime path waits less (REALTIME_ROOM_ACTION_WAIT_MS in ws-service.ts),
 * so every action the daemon waits on carries its own wait as `expiresInMs`
 * (#1010), and that, not this, is the bound for it.
 */
export const ROOM_ACTION_QUEUE_TTL_MS = 5000;

/**
 * When a room action the daemon is waiting on stops being worth running
 * (#1010), on the receiving clock: `receivedAt` plus the `expiresInMs` the
 * daemon sent with it, or undefined when it sent none. Past this the daemon
 * has already said it got no answer, and the caller may have asked again, so
 * the bus drops the action rather than run it late.
 *
 * The daemon's clock started when it sent the action, this one when the
 * client handled the message, so the action can still run after the daemon
 * gave up by as long as that took: the network, any backlog in the daemon's
 * send queue, and any time the page's main thread was busy before it read the
 * message (a room's code still loading, the late-mount case itself). A
 * relative wait, not the daemon's timestamp, because the two clocks need not
 * agree at all; `receivedAt` should be monotonic (performance.now) so a wall
 * clock step cannot stretch it.
 *
 * Anything but a finite, non-negative number is no deadline, as from a daemon
 * that sends none: the daemon always sends its own timeout, which is neither.
 */
export function roomActionExpiry(expiresInMs: unknown, receivedAt: number): number | undefined {
  if (typeof expiresInMs !== 'number' || !Number.isFinite(expiresInMs) || expiresInMs < 0) return undefined;
  return receivedAt + expiresInMs;
}

/**
 * What became of a room action: a room ran it, a room declined it, it was
 * sent and nobody answered in time, or it never reached anyone who could run
 * it (#1011: a socket closing as it was sent takes no frame, and "I sent that"
 * was untrue).
 */
export type RoomActionOutcome = 'accepted' | 'rejected' | 'no_answer' | 'unreached';

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

  /** Stop waiting now: the action reached no one who could answer (#1011). */
  abandon(id: string): void {
    this.finish(id, 'unreached');
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
