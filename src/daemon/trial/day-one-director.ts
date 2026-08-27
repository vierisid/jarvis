/**
 * Day one, after the handover: the thing that is still awake when the
 * conductor is not.
 *
 * The conducted hour ran inside a socket. Everything in D25 to D30 happens
 * after that socket has been stood down, over the next eight or nine hours,
 * across reloads and possibly across a daemon restart. So none of it can live
 * in the conductor and none of it can live in a React component. It lives
 * here, in the daemon, holding the small amount of state day one actually
 * needs and persisting it beside the realtime budget.
 *
 * What it owns:
 *
 *  - **Beat 14.** The finale's agent settling, and the two paths D26 draws.
 *  - **D27.** The offer that follows the finding, and executing it when taken.
 *  - **Beat 16.** The governor. Every ambient interruption in a running day
 *    one goes through `allowAmbient` and most of them do not come out.
 *  - **Beat 17.** The ledger written as the day happens, and the close.
 *
 * The judgement all four rest on is in `day-one.ts` and is pure. This file is
 * plumbing, timers and the vault.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WSMessage } from '../../comms/websocket.ts';
import type { AgentFailure } from '../../agents/task-failure.ts';
import {
  type AmbientCandidate,
  type AmbientState,
  type AgentReturn,
  type DayLine,
  type DayOneClose,
  type DayOneFoundation,
  type DayOneOffer,
  ambientVerdict,
  composeAgentReturn,
  composeDayOneClose,
  dayOneCloseAt,
  emptyAmbientState,
  emptyFoundation,
} from './day-one.ts';

/**
 * D25. "Roughly five minutes, not twenty. It fires when the work is actually
 * done." So the trigger is the task settling, not a clock.
 *
 * The one thing a clock is still needed for is the other half of D25: it fires
 * even if the founder has gone off elsewhere, which means it must not fire
 * INTO the last sentence of the conducted hour either. An agent that finished
 * during the handover waits this long and no longer.
 */
export const RETURN_SETTLE_MS = 45_000;

/** How long the pebble stands over the finished row before drifting back. */
export const RETURN_GESTURE_HOLD_MS = 4_000;

/**
 * How much later a handover has to be before it counts as a different day one
 * rather than the same one being re-announced. An hour: longer than any gap
 * between a stand-down and the daemon noticing it, far shorter than the gap
 * between two walks of the arc.
 */
export const NEW_DAY_ONE_MS = 60 * 60_000;

/**
 * How late D30 can be and still be worth delivering.
 *
 * The close falls due while the daemon is down more often than it sounds: it
 * is the one beat scheduled hours out, and a founder who quits the app at six
 * for a close due at seven is the ordinary case, not the edge. Two hours is
 * the window in which they are plausibly still in the same evening, so the
 * close arrives late rather than not at all. Past it the day is genuinely
 * over, and a proposal about "your day" delivered the following morning is
 * worse than silence.
 */
export const CLOSE_GRACE_MS = 2 * 60 * 60_000;

export type DayOneExecution = { ok: boolean; says: string };

/**
 * The half of the foundation that was learned by VOICE and lives nowhere else.
 *
 * The other half (their quarter, their board, the people the reader landed) is
 * in the vault and can be re-read at any moment. These five cannot: they came
 * out of the conducted hour and the beats session is the only record of them.
 * So day one keeps its own copy, in its own ledger, and puts it back on every
 * time the vault half is refreshed. See `refreshFoundation`.
 */
export type DayOneSessionHalf = Pick<
  DayOneFoundation,
  'workflows' | 'workspace' | 'authorityLevel' | 'agent' | 'eveningHour'
>;

export function sessionHalfOf(f: DayOneFoundation): DayOneSessionHalf {
  return {
    workflows: f.workflows,
    workspace: f.workspace,
    authorityLevel: f.authorityLevel,
    agent: f.agent,
    eveningHour: f.eveningHour,
  };
}

export type DayOneDeps = {
  broadcast: (msg: WSMessage) => void;
  /** Proactive TTS. Best-effort: a founder with no audio still gets the card. */
  speak: (text: string) => Promise<void>;
  /** Is an entitlement running at all? False ends every path in here. */
  trialRunning: () => boolean;
  /** How many surfaces could see a gesture right now. D26's pebble on / off. */
  surfaceCount: () => number;
  /** Everything the hour built, read from the vault. */
  readFoundation: () => DayOneFoundation;
  /** Do the thing the founder just accepted. */
  execute: (offer: DayOneOffer) => Promise<DayOneExecution>;
  /** Where the ledger lives across a restart. */
  statePath: string;
  now?: () => number;
  /**
   * D26's gesture on a machine that has the real pebble on it.
   *
   * The browser does its own: the day-one layer takes the shell's docked
   * pebble by the hand and flies it to the row (ui/src/v2/trial/TrialDayOne).
   * A founder running the desktop app has a SECOND pebble, the native one on
   * their screen, and the agent strip is a 290x440 always-on-top panel rather
   * than a room. This is how that one points, when it is there.
   *
   * Optional because most of what runs this has no sidecar at all, and
   * best-effort because a panel the founder has never opened has no saved
   * bounds and pointing at where it would be is pointing at nothing.
   */
  pointNativePebble?: (label: string) => void;
};

type Persisted = {
  version: 1;
  handedOverAt: number | null;
  spoken: number;
  lastSpokenAt: number | null;
  subjects: string[];
  engagement: number;
  lines: DayLine[];
  /** Beat 14's payload, held for a founder who was not there. */
  pending: AgentReturn | null;
  /** True once the pending return has actually been delivered. */
  returned: boolean;
  /** D30's payload, held for the same reason and on the same terms. */
  pendingClose: DayOneClose | null;
  /** The five fields only the conducted hour knew. See DayOneSessionHalf. */
  session: DayOneSessionHalf | null;
  closedAt: number | null;
};

export class DayOneDirector {
  private deps: DayOneDeps;
  private foundation: DayOneFoundation = emptyFoundation();
  private ambient: AmbientState = emptyAmbientState();
  private lines: DayLine[] = [];
  private pending: AgentReturn | null = null;
  private returned = false;
  /** A composed close nobody was there to receive. See `closeDay`. */
  private pendingClose: DayOneClose | null = null;
  /** What the conducted hour knew that the vault does not. */
  private session: DayOneSessionHalf | null = null;
  private closedAt: number | null = null;
  private handedOverAt: number | null = null;
  /** Offers currently live on a surface, by id, so an accept can be executed. */
  private offers = new Map<string, DayOneOffer>();
  private returnTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(deps: DayOneDeps) {
    this.deps = deps;
    this.restore();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /* ───────────────────────────── the seam ───────────────────────────── */

  /**
   * A conductor just stood down. This is a NEW day one.
   *
   * Authoritative over anything in the ledger, and that is the difference from
   * `resume`. Vieri walks the whole arc repeatedly on the same trial home, so
   * a second handover a day after the first must not inherit yesterday's
   * interruption budget, yesterday's day lines or yesterday's stranded agent
   * result. A handover materially later than the one on file wipes the ledger
   * and starts the day again.
   *
   * "Materially later" rather than "different" because the same handover can
   * arrive twice: `resume` passes the entitlement's `conductor_finished_at`,
   * which is stamped from the same moment but not always to the same
   * millisecond, and a reload must not reset a founder's afternoon.
   */
  begin(foundation: DayOneFoundation, handedOverAt: number): void {
    // The one call that arrives with the beats session behind it, and so the
    // only one that can set the half of the foundation the vault never holds.
    this.session = sessionHalfOf(foundation);
    if (this.handedOverAt !== null && handedOverAt > this.handedOverAt + NEW_DAY_ONE_MS) {
      console.log('[TrialDayOne] a new handover, well after the last one: starting day one again');
      this.ambient = emptyAmbientState();
      this.lines = [];
      this.pending = null;
      this.pendingClose = null;
      this.returned = false;
      this.closedAt = null;
      this.offers.clear();
      this.handedOverAt = null;
      // Both timers, and the return one matters more than it looks. Yesterday's
      // delivery timer left armed would fire into TODAY's pending return and
      // hand it over early, before the settle window that keeps beat 14 off the
      // end of the handover.
      if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
      if (this.returnTimer) { clearTimeout(this.returnTimer); this.returnTimer = null; }
    }
    this.adopt(foundation, handedOverAt);
  }

  /**
   * A daemon that restarted in the middle of a day one that is already
   * running. Everything on file wins; nothing is reset.
   */
  resume(foundation: DayOneFoundation, handedOverAt: number): void {
    this.adopt(foundation, handedOverAt);
  }

  private adopt(foundation: DayOneFoundation, handedOverAt: number): void {
    this.foundation = foundation;
    if (this.handedOverAt === null) {
      this.handedOverAt = handedOverAt;
      console.log(`[TrialDayOne] day one begins, handover at ${new Date(handedOverAt).toISOString()}`);
    }
    this.foundation.handedOverAt = this.handedOverAt;
    // Only `begin` carries the session half, and only the first time. Every
    // other way in here (a resume, a re-announce) arrives with the vault half
    // alone, so the retained copy is put back on.
    this.wearSession();
    this.started = true;
    this.armClose();
    this.persist();
  }

  /**
   * Re-read the vault, and keep the half of the foundation the vault does not
   * hold.
   *
   * This used to replace the foundation outright, and that was quietly fatal
   * to two of the beats it feeds. `readDayOneFoundation` reads goals, board
   * and landed entities; it cannot know the flows they published, the folder
   * they let be organised, the authority they granted, the question they gave
   * the agent, or the evening hour they chose, because all five were learned
   * by voice and live only in the beats session. Overwriting with a vault read
   * therefore nulled all five, and `onAgentSettled` calls this immediately
   * BEFORE composing beat 14. The result on every real run:
   *
   *  - the founder's own question came back empty, so the card had no question
   *    on it and the agent was called "your agent";
   *  - `floorOffers` saw no workspace and no authority level, so D27's OUTWARD
   *    arm could never be offered at all;
   *  - the close fell back to nine hours after the handover rather than the
   *    evening hour they picked, and the governor lost two of its subjects.
   *
   * The tests did not catch it because the harness's `readFoundation` returns
   * a complete foundation, which the daemon's never does.
   */
  refreshFoundation(): void {
    if (!this.started) return;
    try {
      const next = this.deps.readFoundation();
      next.handedOverAt = this.handedOverAt;
      this.foundation = next;
      this.wearSession();
    } catch (err) {
      console.warn('[TrialDayOne] could not re-read the foundation:', err);
    }
  }

  /** Put the retained session half back onto whatever the vault just gave us. */
  private wearSession(): void {
    if (!this.session) return;
    this.foundation.workflows = this.session.workflows;
    this.foundation.workspace = this.session.workspace;
    this.foundation.authorityLevel = this.session.authorityLevel;
    this.foundation.agent = this.session.agent;
    this.foundation.eveningHour = this.session.eveningHour;
  }

  /** Is day one live? Everything in here is a no-op when it is not. */
  running(): boolean {
    return this.started
      && this.handedOverAt !== null
      && this.closedAt === null
      && this.deps.trialRunning();
  }

  /* ─────────────────── D25, D26: the agent comes back ─────────────────── */

  /**
   * Does beat 14 own this task?
   *
   * Asked by the ordinary completion notification so it can stand aside. Two
   * things must not both happen: a chat line saying "Research Analyst finished
   * its task, open the Agents room", and Jarvis speaking the finding and
   * pointing at the row. The second one is the beat; the first would step on
   * it and would also be the instruction the beat exists to replace.
   */
  claimsAgent(taskId: string): boolean {
    return this.running() && this.foundation.agent?.taskId === taskId;
  }

  /**
   * The finale's agent settled, either way.
   *
   * Held for `RETURN_SETTLE_MS` past the handover so a fast agent does not
   * arrive over the top of the sentence that handed the product back.
   */
  onAgentSettled(opts: {
    taskId: string;
    response: string | null;
    failure: AgentFailure | null;
  }): void {
    if (!this.running()) return;
    if (this.foundation.agent?.taskId !== opts.taskId) return;
    if (this.pending || this.returned) return;

    this.refreshFoundation();
    this.pending = composeAgentReturn({
      question: this.foundation.agent?.question ?? '',
      agentName: this.foundation.agent?.agentName ?? 'your agent',
      taskId: opts.taskId,
      response: opts.response,
      failure: opts.failure,
      foundation: this.foundation,
    });
    this.persist();

    const since = this.now() - (this.handedOverAt ?? 0);
    const wait = Math.max(0, RETURN_SETTLE_MS - since);
    console.log(
      `[TrialDayOne] beat 14 armed (${this.pending.answered ? 'answered' : 'no answer'}), ` +
      `delivering in ${Math.round(wait / 1000)}s`,
    );
    this.returnTimer = setTimeout(() => {
      this.returnTimer = null;
      this.deliverReturn('push');
    }, wait);
    (this.returnTimer as { unref?: () => void }).unref?.();
  }

  /**
   * A surface opened. D26 Path B: the founder who was not there when it landed
   * hears about it now, and it is the first thing said.
   */
  onSurfaceOpened(): void {
    // A close that fired into an empty house comes first, and is checked
    // before `running()` because day one has already ended by then.
    this.deliverHeldClose();
    if (!this.running()) return;
    if (!this.pending || this.returned) return;
    if (this.returnTimer) return; // the push is still on its way
    console.log('[TrialDayOne] beat 14, path B: a surface opened and the result was waiting');
    // A small delay: the socket has just connected and the page is still
    // mounting its own layer. Speaking into that is speaking to nobody.
    const t = setTimeout(() => this.deliverReturn('on_open'), 1_500);
    (t as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Put the return on whatever is there, or leave it queued.
   *
   * D26's two paths are one function with one branch, because the difference
   * between them is not what is said, it is whether anybody is there. Nothing
   * chases a founder who closed the app.
   */
  private deliverReturn(via: 'push' | 'on_open'): void {
    if (!this.running() || !this.pending || this.returned) return;

    if (this.deps.surfaceCount() === 0) {
      // Path B. Nothing is pushed, nothing is queued anywhere else, and no
      // desktop notification is fired: that is the founder's own choice and it
      // is left alone.
      console.log('[TrialDayOne] beat 14, path A declined: nothing is on. Holding for their next open.');
      return;
    }

    this.returned = true;
    for (const offer of this.pending.offers) this.offers.set(offer.id, offer);

    const opener = via === 'on_open'
      ? 'While you were away, '
      : '';
    const spoken = opener
      ? `${opener}${lowerFirst(this.pending.says)}`
      : this.pending.says;

    this.deps.broadcast({
      type: 'trial_day_one',
      payload: {
        kind: 'agent_back',
        via,
        says: spoken,
        question: this.pending.question,
        finding: this.pending.finding,
        answered: this.pending.answered,
        failure: this.pending.failure,
        offers: this.pending.offers,
        agent: this.pending.agent,
        // D26's gesture, expressed as a target rather than a coordinate. The
        // surface owns where its own pebble is and what its own strip looks
        // like; the daemon owns which row.
        gesture: this.pending.agent.taskId
          ? {
              room: 'agent_strip',
              anchor: `agent:${this.pending.agent.taskId}`,
              label: this.pending.answered ? 'here it is' : 'this one',
              holdMs: RETURN_GESTURE_HOLD_MS,
            }
          : null,
        // D26's closing half: where these live permanently.
        permanentHome: 'agents',
      },
      timestamp: this.now(),
    });

    void this.deps.speak(spoken).catch(() => { /* no audio is not a failure */ });
    // And the other pebble, if there is one. Same gesture, different screen.
    try {
      this.deps.pointNativePebble?.(this.pending.answered ? 'here it is' : 'this one');
    } catch (err) {
      console.warn('[TrialDayOne] the native pebble could not point:', err);
    }
    this.persist();
  }

  /* ─────────────────────── D27: taking the offer ─────────────────────── */

  /**
   * The founder said yes to something.
   *
   * Returns what to tell them. An offer that cannot be executed says so
   * plainly rather than pretending, because a button that silently does
   * nothing is worse than no button.
   */
  async acceptOffer(id: string): Promise<DayOneExecution> {
    const offer = this.offers.get(id);
    if (!offer) return { ok: false, says: 'That offer is no longer on the table.' };
    this.noteEngagement();
    let outcome: DayOneExecution;
    try {
      outcome = await this.deps.execute(offer);
    } catch (err) {
      console.error('[TrialDayOne] offer execution threw:', err);
      outcome = { ok: false, says: 'I could not do that one. Nothing of yours changed.' };
    }
    if (outcome.ok) this.offers.delete(id);
    this.deps.broadcast({
      type: 'trial_day_one',
      payload: { kind: 'offer_done', id, ok: outcome.ok, says: outcome.says },
      timestamp: this.now(),
    });
    return outcome;
  }

  /* ─────────────────── D29: the governor on the afternoon ─────────────────── */

  /**
   * May this be said out loud?
   *
   * The single gate every ambient interruption passes through during day one.
   * Returns TRUE when day one is not running, which is the branch every
   * non-trial install takes and the reason this can be dropped into the
   * daemon's awareness wiring without changing anybody else's behaviour.
   */
  allowAmbient(candidate: AmbientCandidate): boolean {
    if (!this.running()) return true;
    const verdict = ambientVerdict({
      state: this.ambient,
      candidate,
      foundation: this.foundation,
      now: this.now(),
      dayOneRunning: true,
    });
    if (!verdict.speak) {
      console.log(`[TrialDayOne] ambient held back (${verdict.why}): "${candidate.title.slice(0, 60)}"`);
      return false;
    }
    this.ambient.spoken++;
    this.ambient.lastSpokenAt = this.now();
    this.ambient.subjects.add(verdict.subject);
    console.log(
      `[TrialDayOne] ambient SPOKEN (${this.ambient.spoken}/${this.allowanceNow()}) ` +
      `on ${verdict.subject}: "${candidate.title.slice(0, 60)}"`,
    );
    this.persist();
    return true;
  }

  private allowanceNow(): number {
    // Exposed only for the log line, so the count in the log is the count the
    // governor is actually working to.
    const earned = Math.floor(this.ambient.engagement / 12);
    return Math.min(4, 2 + earned);
  }

  /**
   * The founder did something of their own accord.
   *
   * D29's "more only if the founder is themselves using Jarvis heavily", and
   * this is the only thing that feeds it. Counted rather than measured, and
   * counted from two things only: a turn they started (`chat` on the shell's
   * socket) and an offer they took.
   *
   * Rooms opened are deliberately NOT counted, even though they would be the
   * obvious third. The dashboard routes on a hash and never tells the daemon,
   * so counting them would mean a new message from the surface whose only
   * purpose was to raise a rate limit, which is the wrong thing to add to a
   * product that is asking a founder to trust it with their screen.
   */
  noteEngagement(): void {
    if (!this.running()) return;
    this.ambient.engagement++;
    if (this.ambient.engagement % 12 === 0) this.persist();
  }

  /* ─────────────────────── D30: the ledger and the close ─────────────────────── */

  /**
   * One stretch of their day, recorded as it closes.
   *
   * Called from the awareness session-ended path. This is what makes the
   * whole-day summary survive a one-hour capture retention: the line is
   * written while the captures that produced it still exist, and the line
   * itself is ours and is never swept.
   */
  noteDayLine(line: DayLine): void {
    if (!this.running()) return;
    if (!line.topic || line.minutes <= 0) return;
    this.lines.push(line);
    // A day has a lot of stretches and a summary has three. Keeping fifty is
    // already far more than the composer will ever look at.
    if (this.lines.length > 50) this.lines = this.lines.slice(-50);
    this.persist();
  }

  /**
   * The foundation as it currently stands, vault half and session half both.
   * Read-only; the copy is shallow because nothing here mutates it in place.
   */
  previewFoundation(): DayOneFoundation {
    return { ...this.foundation };
  }

  /** What the close would say if it ran now. Exposed for the API and tests. */
  previewClose(): DayOneClose {
    return composeDayOneClose({ lines: this.lines, foundation: this.foundation, now: this.now() });
  }

  private armClose(): void {
    if (this.closeTimer || this.closedAt !== null || this.handedOverAt === null) return;
    const at = dayOneCloseAt(this.foundation, this.handedOverAt);
    const wait = at - this.now();
    if (wait <= 0) { this.closeOverdue(at); return; }
    // setTimeout past ~24.8 days overflows; day one never is, but a corrupted
    // ledger could make it look like it.
    if (wait > 20 * 60 * 60_000) return;
    console.log(`[TrialDayOne] day one closes at ${new Date(at).toISOString()}`);
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      this.closeDay();
    }, wait);
    (this.closeTimer as { unref?: () => void }).unref?.();
  }

  /**
   * The close fell due while the daemon was down.
   *
   * Day one is the one beat scheduled hours out, so this is ordinary rather
   * than exotic: a founder who quits the app at six for a close due at seven
   * hits it every time. Before this, `armClose` simply declined to arm a timer
   * for a moment already past, which left `closedAt` null forever. Day one
   * then never ended: the governor went on holding every ambient suggestion
   * against a budget already spent, and D30 never happened at all.
   */
  private closeOverdue(dueAt: number): void {
    const late = this.now() - dueAt;
    if (late <= CLOSE_GRACE_MS) {
      console.log(`[TrialDayOne] the close fell due ${Math.round(late / 60_000)}m ago; delivering it late`);
      const t = setTimeout(() => this.closeDay(), 2_000);
      (t as unknown as { unref?: () => void }).unref?.();
      return;
    }
    // Long past. The day is over and there is nobody in it to propose to.
    console.log('[TrialDayOne] day one closed while the daemon was down; ending it without a word');
    this.closedAt = dueAt;
    this.persist();
  }

  /**
   * D30. A proposal, not a report.
   *
   * Fires once. If nothing is on when it fires it is held exactly the way beat
   * 14 is held: nothing chases them, and the next surface to open gets it.
   * `decisions.md` is silent on a close with nobody home, so this takes the
   * smallest reasonable thing and takes it from D26, which already answers the
   * same question for beat 14: do not push, do not chase, say it first the
   * next time they open something.
   *
   * `closedAt` is stamped either way. Day one is over at the moment it is over
   * whether or not anybody was there to be told, and leaving the governor
   * running until somebody opened a window would let the afternoon's budget
   * follow them into the evening.
   *
   * Unlike the ambient interruptions it spends none of that budget, because it
   * is not an interruption; it is the end of the day they were told about.
   */
  closeDay(): void {
    if (!this.running()) return;
    this.refreshFoundation();
    const close = this.previewClose();
    this.closedAt = this.now();
    for (const offer of close.offers) this.offers.set(offer.id, offer);

    if (this.deps.surfaceCount() === 0) {
      console.log('[TrialDayOne] day one closed with nothing on. Holding the proposal for their next open.');
      this.pendingClose = close;
      this.persist();
      return;
    }
    this.emitClose(close, 'push');
  }

  /** The close, put on a surface that is actually there. */
  private emitClose(close: DayOneClose, via: 'push' | 'on_open'): void {
    for (const offer of close.offers) this.offers.set(offer.id, offer);
    const opener = via === 'on_open' ? 'Before you go, here is where your day went. ' : '';
    const spoken = close.thin
      ? `${opener}${close.summary[0]} What I can do is take one thing off tomorrow.`
      : opener
        ? `${opener}${close.summary.join('. ')}. Let me take one of them off you.`
        : `Here is where your day went. ${close.summary.join('. ')}. Let me take one of them off you.`;

    this.deps.broadcast({
      type: 'trial_day_one',
      payload: {
        kind: 'day_close',
        via,
        says: spoken,
        summary: close.summary,
        thin: close.thin,
        offers: close.offers,
      },
      timestamp: this.now(),
    });
    if (this.deps.surfaceCount() > 0) {
      void this.deps.speak(spoken).catch(() => { /* no audio is not a failure */ });
    }
    this.persist();
  }

  /**
   * A held close, handed over the next time a surface appears.
   *
   * Deliberately outside the `running()` gate, because by this point day one
   * has already ended: `closedAt` was stamped when the close fired. What is
   * left is a message with nowhere to go, and the trial still being live is
   * the only condition that matters for delivering it.
   */
  private deliverHeldClose(): void {
    if (!this.pendingClose) return;
    if (!this.deps.trialRunning()) { this.pendingClose = null; return; }
    const close = this.pendingClose;
    this.pendingClose = null;
    const t = setTimeout(() => this.emitClose(close, 'on_open'), 1_500);
    (t as unknown as { unref?: () => void }).unref?.();
  }

  /* ───────────────────────────── persistence ───────────────────────────── */

  /**
   * Day one is eight hours long and a daemon restart inside it must not reset
   * the interruption budget: a founder who has already been spoken to twice
   * and then restarts the app has not earned two more.
   */
  private persist(): void {
    try {
      const data: Persisted = {
        version: 1,
        handedOverAt: this.handedOverAt,
        spoken: this.ambient.spoken,
        lastSpokenAt: this.ambient.lastSpokenAt,
        subjects: [...this.ambient.subjects],
        engagement: this.ambient.engagement,
        lines: this.lines,
        pending: this.pending,
        returned: this.returned,
        pendingClose: this.pendingClose,
        session: this.session,
        closedAt: this.closedAt,
      };
      mkdirSync(dirname(this.deps.statePath), { recursive: true });
      writeFileSync(this.deps.statePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[TrialDayOne] could not persist:', err);
    }
  }

  private restore(): void {
    try {
      if (!existsSync(this.deps.statePath)) return;
      const raw = JSON.parse(readFileSync(this.deps.statePath, 'utf-8')) as Partial<Persisted>;
      if (raw.version !== 1) return;
      this.handedOverAt = raw.handedOverAt ?? null;
      this.ambient = {
        spoken: raw.spoken ?? 0,
        lastSpokenAt: raw.lastSpokenAt ?? null,
        subjects: new Set(raw.subjects ?? []),
        engagement: raw.engagement ?? 0,
      };
      this.lines = Array.isArray(raw.lines) ? raw.lines : [];
      this.pending = raw.pending ?? null;
      this.returned = raw.returned ?? false;
      this.pendingClose = raw.pendingClose ?? null;
      this.session = raw.session ?? null;
      this.closedAt = raw.closedAt ?? null;
      if (this.handedOverAt !== null) this.started = true;
      if (this.pending && !this.returned) {
        for (const offer of this.pending.offers) this.offers.set(offer.id, offer);
      }
      // A close held across a restart keeps its offers live too, or the
      // founder gets a proposal with buttons that no longer do anything.
      if (this.pendingClose) {
        for (const offer of this.pendingClose.offers) this.offers.set(offer.id, offer);
      }
      console.log(
        `[TrialDayOne] restored: ${this.ambient.spoken} spoken, ${this.lines.length} day lines, ` +
        `${this.pending && !this.returned ? 'a result still waiting' : 'nothing waiting'}`,
      );
    } catch (err) {
      console.warn('[TrialDayOne] could not restore, starting clean:', err);
    }
  }

  /** For tests and for a clean shutdown. */
  stop(): void {
    if (this.returnTimer) clearTimeout(this.returnTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.returnTimer = null;
    this.closeTimer = null;
  }
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text;
}
