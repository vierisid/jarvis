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
 * What a room can answer about an action it was sent: it ran it, it declined
 * it, or it asked for it and a card is now waiting on the person (#1016), so
 * nothing has run yet and nothing was refused either. A spawn the route holds
 * for approval (202) is the case today; it used to be reported as declined,
 * and the realtime model, told "didn't accept", could ask again and raise
 * another card.
 */
const ROOM_ANSWERS = ['accepted', 'rejected', 'pending'] as const;
export type RoomAnswer = (typeof ROOM_ANSWERS)[number];

/**
 * The answer a `room_action_result` payload carries, or null when it is not
 * one. `accepted` is the boolean every client sends; `outcome` says which no
 * a false one is, and must agree with it: a payload whose two halves disagree
 * is malformed, not an answer.
 */
export function roomAnswerOf(accepted: unknown, outcome?: unknown): RoomAnswer | null {
  if (typeof accepted !== 'boolean') return null;
  if (outcome === undefined) return accepted ? 'accepted' : 'rejected';
  if (!(ROOM_ANSWERS as readonly unknown[]).includes(outcome)) return null;
  return (outcome === 'accepted') === accepted ? outcome as RoomAnswer : null;
}

/**
 * What became of a room action: what the room answered (RoomAnswer); or the
 * room took it and was still working on it when the wait ran out (#1015:
 * its answer waits on a request to the daemon, and a dev server gets 30s to
 * come up where the realtime path waits 3.5s); or it was sent and nobody
 * answered in time; or it never reached anyone who could run it (#1011: a
 * socket closing as it was sent takes no frame, and "I sent that" was
 * untrue).
 */
export type RoomActionOutcome = RoomAnswer | 'started' | 'no_answer' | 'unreached';

/**
 * Told the room's answer to an action whose wait had already run out (#1034),
 * and what the wait was reported as then: `started` (recorded as run) or
 * `no_answer`. Called at most once.
 */
export type LateRoomAnswer = (answer: RoomAnswer, reported: 'started' | 'no_answer') => void;

/**
 * How many waits that ran out are remembered for a late answer at once
 * (#1034). A memory bound, not a timing one: a room's request has no
 * deadline of its own (a dev server alone gets 30s to come up, and a fetch
 * from the page none), so a late answer is heard for as long as its
 * dashboard stays connected, and the oldest is forgotten past this many.
 */
export const LATE_ANSWER_LIMIT = 256;

type Pending = { settle: (o: RoomActionOutcome) => void; answerer?: unknown; started?: boolean; onLate?: LateRoomAnswer };

export class RoomActionResults {
  private pending = new Map<string, Pending>();
  /**
   * Waits that ran out while the room may still answer (#1034), by id, oldest
   * first. Only for a caller that asked to hear (`onLate`) and a named
   * answerer: a late answer must come from the dashboard that was asked, and
   * goes when it does.
   */
  private late = new Map<string, { answerer: unknown; reported: 'started' | 'no_answer'; onLate: LateRoomAnswer }>();

  constructor(private readonly newId: () => string = () => crypto.randomUUID()) {}

  /**
   * Start waiting. `outcome` resolves on the first answer, or after
   * `timeoutMs` with `started` when the room said it had started on it, else
   * `no_answer`. With `answerer`, only an answer from that client counts
   * (#965): a dashboard voice turn asks the dashboard the user spoke to.
   * With `onLate` too, that client's answer after the wait ran out is passed
   * to it rather than dropped (#1034): the outcome said `started` or
   * `no_answer`, and the room's real answer is still worth recording.
   */
  open(timeoutMs: number, answerer?: unknown, onLate?: LateRoomAnswer): { id: string; outcome: Promise<RoomActionOutcome> } {
    const id = this.newId();
    const outcome = new Promise<RoomActionOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        const reported = entry?.started ? 'started' : 'no_answer';
        if (entry?.onLate && entry.answerer !== undefined) this.remember(id, entry.answerer, reported, entry.onLate);
        this.finish(id, reported);
      }, timeoutMs);
      // A pending answer must not hold the daemon open at shutdown.
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, {
        settle: (o) => {
          clearTimeout(timer);
          resolve(o);
        },
        answerer,
        onLate,
      });
    });
    return { id, outcome };
  }

  /**
   * An answer from a client. Anything but a known id and a well-formed answer
   * (roomAnswerOf) is ignored: this arrives over the dashboard socket, so it
   * is not trusted to be well formed, and an answer for an entry already
   * settled changes nothing.
   */
  answer(id: unknown, accepted: unknown, from?: unknown, outcome?: unknown): void {
    const answer = roomAnswerOf(accepted, outcome);
    if (typeof id !== 'string' || answer === null) return;
    const entry = this.pending.get(id);
    if (!entry) {
      this.answerLate(id, answer, from);
      return;
    }
    if (entry.answerer !== undefined && entry.answerer !== from) return;
    this.finish(id, answer);
  }

  /** A late answer (#1034): heard once, and only from the client asked. */
  private answerLate(id: string, answer: RoomAnswer, from: unknown): void {
    const late = this.late.get(id);
    if (!late || late.answerer !== from) return;
    this.late.delete(id);
    late.onLate(answer, late.reported);
  }

  private remember(id: string, answerer: unknown, reported: 'started' | 'no_answer', onLate: LateRoomAnswer): void {
    this.late.set(id, { answerer, reported, onLate });
    // Map order is insertion order, so the first key is the oldest.
    while (this.late.size > LATE_ANSWER_LIMIT) this.late.delete(this.late.keys().next().value!);
  }

  /**
   * The room has taken the action and its answer waits on work still running
   * (#1015). Not an answer: the entry stays open for the real one, and only
   * changes what the wait running out means. The same checks as an answer.
   */
  started(id: unknown, from?: unknown): void {
    if (typeof id !== 'string') return;
    const entry = this.pending.get(id);
    if (!entry || (entry.answerer !== undefined && entry.answerer !== from)) return;
    entry.started = true;
  }

  /** Stop waiting now: the action reached no one who could answer (#1011). */
  abandon(id: string): void {
    this.finish(id, 'unreached');
  }

  /**
   * Stop waiting on everything only `answerer` could answer: it has gone.
   * `no_answer` even for an action it said it had started: the page doing
   * the work has gone, and its request may have gone with it.
   */
  abandonAnswerer(answerer: unknown): void {
    if (answerer === undefined) return;
    for (const [id, entry] of [...this.pending]) {
      if (entry.answerer === answerer) this.finish(id, 'no_answer');
    }
    // Nothing late can come from it now either.
    for (const [id, late] of [...this.late]) {
      if (late.answerer === answerer) this.late.delete(id);
    }
  }

  /** Entries still waiting. */
  get size(): number {
    return this.pending.size;
  }

  /** Waits that ran out and may still hear a late answer (#1034). */
  get lateSize(): number {
    return this.late.size;
  }

  private finish(id: string, outcome: RoomActionOutcome): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.settle(outcome);
  }
}
