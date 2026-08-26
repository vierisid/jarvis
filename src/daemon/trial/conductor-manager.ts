/**
 * Per-socket lifecycle for the trial conductor and the room beats that follow
 * it.
 *
 * Everything stateful about the session lives here rather than in ws-service:
 * which sockets are running a conductor session, what each has landed, how far
 * through D16's seven beats the two of them have got, and the one piece of
 * timing the whole commercial model rests on, when the 48-hour clock starts.
 *
 * ws-service keeps a four-line branch and delegates.
 *
 * The opening (conductor.ts) and the beats (beats.ts) are ONE conversation on
 * ONE realtime session (D17). What changes when the opening concludes is not
 * the session, the socket, the prompt or the tool list: it is a flag on the
 * beats ledger, and the tool result the model happens to be reading at that
 * moment. Nothing here ever sends the founder a message.
 */

import type { WSMessage } from '../../comms/websocket.ts';
import {
  TRIAL_FILES_SOURCE,
  createConductorSession,
  executeConductorTool,
  type ConductorSession,
  type CapturedFuel,
  type LandedEntity,
  type TrialOpeningHandoff,
} from './conductor.ts';
import {
  BEAT_ROOM,
  createBeatsSession,
  executeBeatTool,
  type BeatFuel,
  type BeatProposal,
  type BeatsSession,
  type RoomBeat,
  type WorkflowProposal,
} from './beats.ts';
import {
  markOpeningCompleted,
  startTrialClock,
  trialSnapshot,
  type TrialSnapshot,
} from '../../trial/entitlement.ts';
import type { RoomKey } from '../../voice/intent.ts';
import type { FoundEntities } from './reader-tools.ts';
import { detectHostShape, type HostShape } from './host-paths.ts';

/**
 * How long to wait for a transcript of the founder's first utterance before
 * starting the clock from the VAD alone.
 *
 * The clock is meant to start at the first spoken WORD (D9), and words come
 * from input transcription, which the conductor session turns on. If that
 * transcript never arrives (the model does not support it, the plan does not
 * include it, the event shape drifts), the alternative to a backstop is a
 * trial that never expires and bills uncapped realtime forever (open question
 * Q1). So: prefer the word, fall back to "a complete utterance was heard".
 */
export const CLOCK_TRANSCRIPT_GRACE_MS = 15_000;

/** True when a transcript contains something a person actually said. Guards
 *  the clock against empty and punctuation-only transcripts. */
export function transcriptHasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

type Timer = ReturnType<typeof setTimeout>;

type Entry<W> = {
  socket: W;
  session: ConductorSession;
  /** D16's beats, as a ledger. See beats.ts. */
  beats: BeatsSession;
  /** The room the founder is currently looking at, so the pebble only flies
   *  when they are actually being led somewhere new (D21). */
  room: RoomKey | null;
  /** Backstop timer armed by the first `speech_stopped`. */
  clockFallback: Timer | null;
  /**
   * D42's reader, as seen from this socket. Bookkeeping only: the entities
   * themselves live in the vault, and `found` is the running list of what has
   * landed so `reading_so_far` can answer honestly, including when the honest
   * answer is "nothing yet".
   */
  reader: { found: string[]; finished: boolean; summary: string | null } | null;
};

/**
 * The four things the room beats need that are not a vault write.
 *
 * Injected rather than imported so this file stays free of the daemon's
 * service graph (and so the beats are testable without one). ws-service binds
 * them to the running orchestrator, config and agent services. Absent means
 * the beat that needs one refuses out loud rather than pretending to work,
 * which is what the tests rely on.
 */
export type TrialBeatActions = {
  /** Compose + publish a flow from a proposal. Slow: it is a real LLM build. */
  publishWorkflow: (p: WorkflowProposal) => Promise<{ ok: true; detail: string } | { ok: false; detail: string }>;
  /** Persist both ends of the day into the goal rhythm. */
  setDailyRhythm: (morning: { hour: number; minute: number }, eveningHour: number) => void;
  /** Persist the authority level and the founder's carve-out. Returns what
   *  actually landed, since both are filtered on the way through. */
  setAuthority: (level: number, alwaysAsk: string[]) => { level: number; alwaysAsk: string[] };
  /**
   * D42. Spawn the background reader on a folder the founder approved.
   *
   * The manager supplies the two callbacks rather than the daemon, because
   * what the reader finds has to land through the SAME path the conversation
   * uses (`remember` on this socket's conductor session) so that the founder
   * sees one memory ticker filling rather than two sources of truth.
   */
  startFolderReader: (opts: {
    folder: string;
    shortlist: string[];
    about: string;
    onFound: (found: FoundEntities) => { landed: number; names: string[] };
    onDone: (summary: string | null) => void;
  }) => Promise<{ agentId: string; taskId: string | null }>;
  /** Spawn the finale's research agent and leave it running. */
  spawnResearchAgent: (
    question: string,
    brief: string,
  ) => Promise<{ agentId: string; taskId: string | null; agentName: string }>;
};

export type ConductorManagerDeps<W> = {
  send: (ws: W, msg: WSMessage) => void;
  broadcast: (msg: WSMessage) => void;
  /** Injectable clock so the tests are not timing-dependent. */
  now?: () => number;
  /** Backstop window, overridable so the fallback path is testable in ms. */
  clockGraceMs?: number;
  /** See TrialBeatActions. */
  beatActions?: TrialBeatActions;
};

export class TrialConductorManager<W> {
  private deps: ConductorManagerDeps<W>;
  /** Sockets that asked for the conductor and passed the entitlement check. */
  private armed = new Set<W>();
  private entries = new Map<W, Entry<W>>();
  /** WSL, Windows or Linux. See host-paths.ts; detected lazily, then kept. */
  private host: HostShape | null = null;

  constructor(deps: ConductorManagerDeps<W>) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Mark this socket as the trial's conductor socket. The realtime starter
   * reads this to decide which session to build; nothing else in the daemon
   * changes behaviour because of it.
   */
  arm(ws: W): void {
    this.armed.add(ws);
  }

  isArmed(ws: W): boolean {
    return this.armed.has(ws);
  }

  /** Is a conductor session actually running on this socket? */
  isRunning(ws: W): boolean {
    return this.entries.has(ws);
  }

  /** Open the conductor's bookkeeping for a socket whose realtime session is
   *  about to be built. Returns the session state the tool executor mutates. */
  begin(ws: W): ConductorSession {
    const existing = this.entries.get(ws);
    if (existing) return existing.session;
    const session = createConductorSession(this.now());
    this.entries.set(ws, {
      socket: ws,
      session,
      beats: createBeatsSession(),
      room: null,
      clockFallback: null,
      reader: null,
    });
    return session;
  }

  /** Tear down. Safe to call for a socket that never ran a conductor. */
  end(ws: W): void {
    const entry = this.entries.get(ws);
    if (entry?.clockFallback) clearTimeout(entry.clockFallback);
    this.entries.delete(ws);
    this.armed.delete(ws);
  }

  /**
   * Run one conductor tool call, wired to the live surfaces. Returns null when
   * the name is not a conductor tool.
   */
  async executeTool(ws: W, name: string, args: Record<string, unknown> = {}): Promise<string | null> {
    const entry = this.entries.get(ws);
    if (!entry) return null;

    // The opening's three tools stay synchronous: every one of them is a local
    // vault write, and a realtime session that awaits anything mid-sentence is
    // a founder listening to silence.
    const opening = executeConductorTool(entry.session, name, args, {
      onEntitiesLanded: (landed) => this.publishLanded(landed),
      onFuelCaptured: (fuel) => this.publishFuel(ws, fuel),
      onOpeningComplete: (handoff) => this.publishOpeningComplete(entry, handoff),
    }, this.now());
    if (opening) return opening.message;

    const beat = await executeBeatTool(entry.beats, name, args, this.beatDeps(ws, entry));
    return beat ? beat.message : null;
  }

  /* ───────────────────── D16, the seven beats ───────────────────── */

  /** Read-only view of how far through the beats this socket is. Used by the
   *  tests and by whoever builds the day-one beats on top of this seam. */
  beatsOf(ws: W): BeatsSession | null {
    return this.entries.get(ws)?.beats ?? null;
  }

  /**
   * Everything the beats can reach. Each one is a push to the founder's screen
   * or one of the four injected actions; none of them says anything to the
   * founder, which is what keeps the model holding the floor (D17).
   */
  private beatDeps(ws: W, entry: Entry<W>) {
    const actions = this.deps.beatActions;
    const notWired = (what: string) => {
      throw new Error(`${what} is not available on this install.`);
    };
    return {
      now: () => this.now(),
      // Detected once and held for the life of the manager: what kind of
      // machine this is does not change under a running daemon, and
      // `detectHostShape` reads /proc and /etc every time it is asked.
      host: () => (this.host ??= detectHostShape()),
      fuel: (): BeatFuel => {
        const out: BeatFuel = {};
        for (const [area, captured] of entry.session.coveredFuel) out[area] = captured.summary;
        return out;
      },
      enterRoom: (beat: RoomBeat, label: string) => this.enterRoom(entry, beat, label),
      roomIsTheirs: (beat: RoomBeat, label: string) => this.markRoom(beat, label),
      refreshRoom: (room: RoomKey) => this.refreshRoom(room),
      showProposal: (proposal: BeatProposal | null) => this.publishProposal(proposal),
      proposalLanded: (beat: RoomBeat, summary: string) => this.publishProposalLanded(beat, summary),
      beatComplete: (beat: RoomBeat, detail: Record<string, unknown>) =>
        this.publishBeatComplete(entry, beat, detail),
      publishWorkflow: (p: WorkflowProposal) =>
        actions ? actions.publishWorkflow(p) : Promise.reject(new Error('The workflow builder is not available on this install.')),
      setDailyRhythm: (morning: { hour: number; minute: number }, eveningHour: number) =>
        actions ? actions.setDailyRhythm(morning, eveningHour) : notWired('The daily rhythm'),
      setAuthority: (level: number, alwaysAsk: string[]) =>
        actions ? actions.setAuthority(level, alwaysAsk) : (notWired('Authority') as never),
      startFolderReader: (opts: { folder: string; shortlist: string[]; about: string }) =>
        actions
          ? actions.startFolderReader({
              ...opts,
              onFound: (found) => this.landFromReader(entry, found),
              onDone: (summary) => this.readerFinished(entry, summary),
            })
          : Promise.reject(new Error('Sub-agents are not available on this install.')),
      readerProgress: () => ({
        found: entry.reader ? [...entry.reader.found] : [],
        finished: entry.reader?.finished ?? false,
        summary: entry.reader?.summary ?? null,
      }),
      spawnResearchAgent: (question: string, brief: string) =>
        actions
          ? actions.spawnResearchAgent(question, brief)
          : Promise.reject(new Error('Sub-agents are not available on this install.')),
      onFinished: (beats: BeatsSession) => this.publishOnboardingComplete(entry, beats),
    };
  }

  /* ─────────────────── D42, what the reader sends back ─────────────────── */

  /**
   * Something the reader found in the founder's own files.
   *
   * Deliberately funnelled through the conversation's own `remember`, with a
   * different vault source. That buys three things at once: the same
   * de-duplication (a name in three documents lands once), the same
   * `trial_memory` broadcast so the founder watches their files arrive in the
   * ticker they have been watching all session, and one place where the D38
   * debrief can later tell what it read from what they said.
   */
  private landFromReader(entry: Entry<W>, found: FoundEntities): { landed: number; names: string[] } {
    if (!entry.reader) entry.reader = { found: [], finished: false, summary: null };
    const before = entry.session.landed.length;
    try {
      executeConductorTool(entry.session, 'remember', found as Record<string, unknown>, {
        onEntitiesLanded: (landed) => this.publishLanded(landed),
        source: TRIAL_FILES_SOURCE,
      }, this.now());
    } catch (err) {
      console.warn('[Trial] reader finding failed to land', err);
      return { landed: 0, names: [] };
    }
    const fresh = entry.session.landed.slice(before);
    const names: string[] = [];
    for (const e of fresh) {
      // A fact about a name they gave you an hour ago is the most striking
      // finding there is, and it is a fact rather than a new entity, so the
      // list is built from BOTH: the name, plus what was just learned about
      // it. `factCount` is only non-zero for facts that were genuinely new,
      // so a document repeating itself does not pad the count.
      const label = e.role ? `${e.name} (${e.role})` : e.name;
      const said = TrialConductorManager.factsFor(found, e.name);
      const line = !e.isNew && said ? `${label}: ${said}` : label;
      if (!entry.reader.found.includes(line)) {
        entry.reader.found.push(line);
        names.push(label);
      }
    }
    return { landed: names.length, names };
  }

  /** What this call said about `name`, joined, for the running list. */
  private static factsFor(found: FoundEntities, name: string): string {
    const lower = name.toLowerCase();
    return (found.facts ?? [])
      .filter((f) => (f.about ?? '').trim().toLowerCase() === lower)
      .map((f) => (f.detail ?? '').trim())
      .filter(Boolean)
      .join(' ');
  }

  private readerFinished(entry: Entry<W>, summary: string | null): void {
    if (!entry.reader) entry.reader = { found: [], finished: false, summary: null };
    entry.reader.finished = true;
    entry.reader.summary = summary;
    console.log(`[Trial] the folder reader finished: ${entry.reader.found.length} things landed`);
  }

  /**
   * Lead them into the room this beat happens in.
   *
   * D21: the pebble is a guide with physical presence, so it flies to the
   * room's entry in the Index and holds a label there, and the room opens
   * behind the gesture rather than in front of it. Only fires when the room
   * actually CHANGES: a second proposal in the same room is the same room, and
   * a pebble that re-flies on every tool call is a tic rather than a gesture.
   *
   * ONE event, carrying both the gesture and where it leads, and deliberately
   * NOT the `navigate_room` notification the voice nav tools broadcast. From
   * the home thread that notification opens the room as an INLINE WINDOW
   * inside the Thread, and the Thread lives in the Talk panel, which the trial
   * hides (see TrialConductor.css). The founder would have heard "here is your
   * quarter" and watched nothing happen. The trial's own layer opens the room
   * as the surface instead, which is what the storyboard shows.
   */
  private enterRoom(entry: Entry<W>, beat: RoomBeat, label: string): void {
    const room = BEAT_ROOM[beat];
    if (entry.room === room) return;
    entry.room = room;
    this.deps.broadcast({
      type: 'trial_point',
      payload: { target: `room:${room}`, label, room },
      timestamp: this.now(),
    });
  }

  /**
   * The pebble goes back to this room's row in the Index and says what now
   * lives there.
   *
   * Deliberately WITHOUT the `room` field the lead-in gesture carries, so the
   * layer points and does not navigate: the founder is already standing in
   * this room looking at the thing that just landed, and re-opening it under
   * them would be a flicker rather than a gesture. It also always fires, where
   * `enterRoom` is a no-op on an unchanged room, because the whole value of
   * this one is that it happens AFTER the work rather than before it.
   */
  private markRoom(beat: RoomBeat, label: string): void {
    this.deps.broadcast({
      type: 'trial_point',
      payload: { target: `room:${BEAT_ROOM[beat]}`, label },
      timestamp: this.now(),
    });
  }

  /** D22: what just landed has to be visible NOW, not on the room's 8s poll. */
  private refreshRoom(room: RoomKey): void {
    this.deps.broadcast({
      type: 'notification',
      payload: { source: 'room_action', room, action: 'refresh', args: {} },
      timestamp: this.now(),
    });
  }

  private publishProposal(proposal: BeatProposal | null): void {
    this.deps.broadcast({
      type: 'trial_proposal',
      payload: { proposal },
      timestamp: this.now(),
    });
  }

  private publishProposalLanded(beat: RoomBeat, summary: string): void {
    this.deps.broadcast({
      type: 'trial_proposal',
      payload: { proposal: null, landed: { beat, summary } },
      timestamp: this.now(),
    });
  }

  private publishBeatComplete(entry: Entry<W>, beat: RoomBeat, detail: Record<string, unknown>): void {
    console.log(`[Trial] beat complete: ${beat} ${JSON.stringify(detail)}`);
    this.deps.broadcast({
      type: 'trial_beat',
      payload: { beat, detail, done: [...entry.beats.done] },
      timestamp: this.now(),
    });
  }

  /**
   * The seventh beat closed. Onboarding is over; the CONVERSATION is not, and
   * nothing here ends it. This is the seam the day-one beats attach to.
   */
  private publishOnboardingComplete(entry: Entry<W>, beats: BeatsSession): void {
    console.log(
      `[Trial] onboarding complete, ${beats.done.length}/6 beats, ` +
      `authority ${beats.authorityLevel ?? 'unset'}, ${beats.workflowsPublished.length} flows`,
    );
    this.deps.broadcast({
      type: 'trial_onboarding_complete',
      payload: {
        beats: [...beats.done],
        workflows: [...beats.workflowsPublished],
        authorityLevel: beats.authorityLevel,
        briefAt: beats.briefAt,
        agent: beats.agent,
        entities: entry.session.landed.length,
        finishedAt: beats.finishedAt,
      },
      timestamp: this.now(),
    });
  }

  /* ───────────────────────── D9, the clock ───────────────────────── */

  /**
   * A transcript arrived. Starts the 48-hour clock on the founder's first
   * spoken word, and does nothing at all for Jarvis's own speech, Jarvis
   * speaks FIRST in this session (D10), so an assistant transcript is
   * guaranteed to arrive before any user one and must never be mistaken for
   * the founder having said something.
   */
  onTranscript(ws: W, role: 'user' | 'assistant', text: string, final: boolean): void {
    if (role !== 'user' || !final) return;
    if (!transcriptHasWords(text)) return;
    this.noteUserTurn(ws);
    this.startClock(ws);
  }

  /**
   * The founder was heard. The beats read this to refuse a commit that arrives
   * without them having said anything since the proposal went up (see
   * `founderHasAnswered`). Both the transcript and the VAD feed it: a
   * transcript-only signal would take the whole session down on an install
   * where input transcription is unavailable.
   */
  private noteUserTurn(ws: W): void {
    const entry = this.entries.get(ws);
    if (entry) entry.beats.lastUserTurnAt = this.now();
  }

  /**
   * The VAD closed the founder's turn. Arms the backstop rather than starting
   * the clock outright, so a real transcript still gets to be the thing that
   * starts it when transcription is working.
   */
  onUserSpeechStopped(ws: W): void {
    this.noteUserTurn(ws);
    const entry = this.entries.get(ws);
    if (!entry || entry.session.firstSpeechAt !== null || entry.clockFallback) return;
    entry.clockFallback = setTimeout(() => {
      entry.clockFallback = null;
      this.startClock(ws);
    }, this.deps.clockGraceMs ?? CLOCK_TRANSCRIPT_GRACE_MS);
    // Never hold the process open for this.
    (entry.clockFallback as { unref?: () => void }).unref?.();
  }

  /** Idempotent at both layers: here and in the entitlement record itself. */
  private startClock(ws: W): void {
    const entry = this.entries.get(ws);
    if (!entry || entry.session.firstSpeechAt !== null) return;
    const now = this.now();
    entry.session.firstSpeechAt = now;
    if (entry.clockFallback) {
      clearTimeout(entry.clockFallback);
      entry.clockFallback = null;
    }
    const updated = startTrialClock(now);
    console.log(
      `[Trial] clock started at first spoken word: ${new Date(now).toISOString()}` +
      `${updated?.expires_at ? ` → expires ${new Date(updated.expires_at).toISOString()}` : ''}`,
    );
    this.publishStatus(trialSnapshot(now));
  }

  /* ───────────────────────── surfaces ───────────────────────── */

  publishStatus(snapshot: TrialSnapshot): void {
    // Broadcast, not send: the shell's own socket needs the clock too.
    this.deps.broadcast({
      type: 'trial_status',
      payload: snapshot,
      timestamp: this.now(),
    });
  }

  private publishLanded(landed: LandedEntity[]): void {
    // D22: this is the push that makes the vault visibly fill while the
    // founder is still mid-sentence. Broadcast so the memory room sees it
    // without waiting for its 8-second poll.
    this.deps.broadcast({
      type: 'trial_memory',
      payload: { landed },
      timestamp: this.now(),
    });
  }

  private publishFuel(ws: W, fuel: CapturedFuel): void {
    this.deps.send(ws, {
      type: 'trial_fuel',
      payload: fuel,
      timestamp: this.now(),
    });
  }

  private publishOpeningComplete(entry: Entry<W>, handoff: TrialOpeningHandoff): void {
    markOpeningCompleted(handoff.concludedAt);
    // THE SEAM. This one line is the whole handover from the opening to the
    // seven beats: a flag, set while the model is mid-sentence. No new session,
    // no new prompt, no new socket, and nothing said to the founder (D17). The
    // model finds out by reading the tool result it is already waiting on.
    entry.beats.open = true;
    console.log(`[Trial] opening complete, ${handoff.fuel.length}/5 fuel areas, ${handoff.entities.length} entities landed`);
    // The seam, on the wire. The conversation is still live when this fires.
    this.deps.broadcast({
      type: 'trial_opening_complete',
      payload: {
        understanding: handoff.understanding,
        fuel: handoff.fuel,
        entityCount: handoff.entities.length,
        concludedAt: handoff.concludedAt,
      },
      timestamp: this.now(),
    });
  }
}
