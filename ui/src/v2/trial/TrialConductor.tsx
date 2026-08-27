import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ConductorSession,
  microphoneAlreadyGranted,
  requestMicrophone,
  type BeatProposal,
  type CapturedFuel,
  type ConductorPhase,
  type LandedEntity,
  type OnboardingComplete,
  type PebblePoint,
  type PebbleWalk,
  type ProposalLanded,
  type StandDown,
} from "./conductorSession";
import { TrialProposal } from "./TrialProposal";
import { pebbleView, type PebbleBubble } from "./pebbleState";
import { TRIAL_SESSION_RENEW_MS, renewTrialSession } from "./sessionRenew";
import { formatTimeRemaining, type TrialStatus } from "./trialGate";
import { TrialClock } from "./TrialClock";
import { isReviewMode } from "./reviewMode";
import { standDownVerdict } from "./standDown";
import { openRoom, type RoomKey } from "../router";
import "./TrialConductor.css";

/** How long the pebble has the founder's eye to itself before the room lands.
 *  Long enough for the gesture to have started, short enough that the room
 *  still feels like the consequence of it. */
const ROOM_OPEN_DELAY_MS = 420;

const ROOM_KEYS: ReadonlySet<string> = new Set([
  "workflows", "memory", "tools", "agents", "authority", "logs",
  "calendar", "goals", "tasks", "content", "workspaces", "usage", "settings",
]);

function isRoomKey(v: string): v is RoomKey {
  return ROOM_KEYS.has(v);
}

/* ═══════ The 48-hour trial's conversation, from the mic to the finale ═══════
   Storyboard frames 02 to 10. Two surfaces, and the second one is the reason
   this is not a wizard:

     1. The microphone gate. Full screen, one thing on it. D10: voice is
        mandatory and there is no typed path through the trial.
     2. Everything after it. The gate DISSOLVES and the live shell is
        underneath, with the pebble and the captions floating over it. That is
        what lets the founder watch their vault fill while they are still
        talking (D22, frame 04), and it is the surface the room beats will
        need, since under D17 the rooms are things Jarvis does WHILE the
        conversation continues.

   There is no welcome screen, no bullet points and no "click to begin" (D10):
   the moment the microphone is on, the session opens and Jarvis speaks.

   The room beats (D16, reordered by D44) render on the SAME surface, over the
   same live shell, while the same conversation carries on. The first of them
   is now the file read, which means the first room the founder is ever led
   into is the one their own documents land in. Nothing about this component
   changes phase when the opening ends: a proposal card appears on the right
   when something is waiting on the founder's yes, and the pebble occasionally
   leaves its corner to lead them to a room. That is the whole of the visible
   difference, which is the point of D17. */

type GatePhase = "checking" | "gate" | "asking" | "denied" | "unavailable" | "live";

export function TrialConductor({ children }: { children: React.ReactNode }) {
  const [gate, setGate] = useState<GatePhase>("checking");
  const [phase, setPhase] = useState<ConductorPhase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [caption, setCaption] = useState<string>("");
  const [landedEntities, setLandedEntities] = useState<LandedEntity[]>([]);
  const [fuel, setFuel] = useState<CapturedFuel[]>([]);
  const [trial, setTrial] = useState<TrialStatus | null>(null);
  const [openingDone, setOpeningDone] = useState(false);
  const [proposal, setProposal] = useState<BeatProposal | null>(null);
  const [landedProposal, setLandedProposal] = useState<ProposalLanded | null>(null);
  const [finished, setFinished] = useState<OnboardingComplete | null>(null);
  /** The conducted hour is over and the shell is theirs. See standDown.ts. */
  const [stoodDown, setStoodDown] = useState(false);
  /** Set when the daemon asks for the stand-down; the moment it HAPPENS is
   *  decided here, at the next gap in the speech. */
  const [standAsked, setStandAsked] = useState(false);
  /** True once the page's credential could not be renewed, so the rooms under
   *  the conversation have stopped updating and the founder has to be told. */
  const [stale, setStale] = useState(false);
  const sessionRef = useRef<ConductorSession | null>(null);
  /** Streaming assistant deltas accumulate here until the turn is final. */
  const partialRef = useRef<string>("");
  /* ── the four facts the stand-down is decided from, as refs ──
     Refs rather than state because the decision is taken on a timer and must
     see the CURRENT phase, not the phase at the render that armed the timer.
     The rules themselves are pure and live in standDown.ts. */
  const standAtRef = useRef<number | null>(null);
  const finishedAtRef = useRef<number | null>(null);
  const speakingRef = useRef(false);
  const spokeSinceRequestRef = useRef(false);
  const pressedRef = useRef(false);
  /** True from the founder's keystroke onward, so the synthetic one we fire to
   *  open Talk for them is not swallowed by the listener that caught theirs. */
  const summonDoneRef = useRef(false);
  const gestures = useGestureQueue();
  const { push: pushGestures } = gestures;

  // Already granted from a previous run? Then there is nothing to ask and the
  // gate must not appear at all, D10's prompt exists only when it is needed.
  useEffect(() => {
    let cancelled = false;
    microphoneAlreadyGranted().then((granted) => {
      if (cancelled) return;
      if (granted) void begin();
      else setGate("gate");
    });
    return () => {
      cancelled = true;
    };
    // `begin` is stable for the life of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => sessionRef.current?.dispose(), []);

  const begin = useCallback(async () => {
    if (sessionRef.current) return;
    setGate("live");
    setError(null);

    // Mark the install onboarded before a word is spoken. The wizard this
    // replaces is what normally does it, and a founder mid-conversation must
    // never be dropped back into one. Deliberately does not start the clock.
    try {
      await fetch("/api/trial/opening/start", { method: "POST" });
    } catch {
      // Non-fatal: the conversation is what matters, and the daemon refuses
      // the conductor itself if there is no entitlement.
    }

    const session = new ConductorSession({
      onPhase: (p, detail) => {
        setPhase(p);
        speakingRef.current = p === "speaking";
        if (p === "speaking") spokeSinceRequestRef.current = true;
        // Jarvis's turn is over the moment its audio stops. Drop the words with
        // it, so a half-finished sentence cannot be prefixed onto the next turn
        // after a barge-in cancelled the response that was producing it.
        if (p !== "speaking") {
          partialRef.current = "";
          setCaption("");
        }
        // A closed session is a dead end in the opening, not a quiet return to
        // typing: voice is the only path through the trial (D10). The daemon's
        // own reason is used when it has one, a plan that excludes realtime
        // says so, because "say that again" is advice the founder cannot act
        // on here.
        if (p === "error") setError(detail ?? "Something went wrong.");
        else if (p === "closed") setError(detail ?? "The conversation ended. Reload to pick it back up.");
        else setError(null);
      },
      // Transcripts fill the caption and nothing else. They do NOT move the
      // pebble: an assistant delta is not the sound arriving, and a final user
      // transcript is whisper finishing, which routinely happens while Jarvis
      // is already speaking again. See pebbleState.ts for the whole story.
      onTranscript: (role, text, final) => {
        if (role !== "assistant") return;
        partialRef.current = final ? text : partialRef.current + text;
        setCaption(partialRef.current);
        if (final) partialRef.current = "";
      },
      onEntitiesLanded: (next) => {
        // Newest first: the founder is watching the top of this list.
        setLandedEntities((prev) => [...next].reverse().concat(prev).slice(0, 40));
      },
      onFuelCaptured: (f) => setFuel((prev) => [...prev.filter((p) => p.area !== f.area), f]),
      onTrialStatus: (s) => setTrial(s),
      onOpeningComplete: () => setOpeningDone(true),
      // The beats. None of these ends anything or says anything: the founder
      // hears the same voice they have been hearing since the first sentence.
      onProposal: (next, resolved) => {
        setProposal(next);
        if (resolved) setLandedProposal(resolved);
      },
      onBeatComplete: () => { /* the room underneath is the surface for this */ },
      onPoint: (p) => {
        // The gesture is QUEUED and the navigation is not. Two points used to
        // clobber each other, which did not matter while there was only ever
        // one in flight; a room that now explains itself sends a walk and then
        // marks its door, and the door would have cut the walk off halfway.
        pushGestures([p]);
        // The room opens BEHIND the gesture, not in front of it (D21): the
        // pebble leaves its corner first, and by the time the room is on the
        // screen the founder is already looking at where it came from. This
        // stays immediate for that reason: it is the one part of a point that
        // must not wait behind anything.
        //
        // Opened as the surface rather than through the shell's own
        // `navigate_room` handling, which from the home thread opens an inline
        // window inside the Thread, and the Thread lives in the Talk panel the
        // trial hides. Storyboard frames 05 to 10 all show the room owning the
        // surface with the Index beside it, which is what `openRoom` does.
        if (p.room && isRoomKey(p.room)) {
          const key = p.room;
          window.setTimeout(() => openRoom(key), ROOM_OPEN_DELAY_MS);
        }
      },
      onWalk: (walk) => {
        void resolveWalk(walk).then((parts) => {
          if (parts.length > 0) pushGestures(parts);
        });
      },
      onStandDown: (stand: StandDown) => {
        pressedRef.current = stand.pressed;
        standAtRef.current = Date.now();
        spokeSinceRequestRef.current = false;
        setStandAsked(true);
      },
      onOnboardingComplete: (summary) => {
        finishedAtRef.current = Date.now();
        setFinished(summary);
      },
    });
    sessionRef.current = session;
    try {
      await session.start();
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const askForMic = useCallback(async () => {
    setGate("asking");
    const verdict = await requestMicrophone();
    if (verdict === "granted") return begin();
    setGate(verdict === "denied" ? "denied" : "unavailable");
  }, [begin]);

  // The conductor's pebble floats OVER the live shell, and the shell docks a
  // pebble of its own at the bottom right, with a third inside its Talk panel.
  // Two of them nine pixels apart horizontally and twenty-five vertically do
  // not read as two pebbles, they read as one pebble sheared in half. While
  // the conductor owns the conversation there is exactly one, and Talk goes
  // with the docked one: it carries a composer, and the trial has no typed
  // path through it (D10). The marker is what TrialConductor.css scopes that
  // suppression to, so no other surface loses its pebble.
  //
  // And this is where it is given BACK. The marker is set while the conductor
  // is conducting and removed the moment it stands down, which is the whole of
  // the fix: on 26 August nothing ever removed it, so the founder spent the
  // other 47 hours of a 48-hour trial unable to reach their own pebble.
  useEffect(() => {
    if (gate !== "live" || stoodDown) return;
    const root = document.documentElement;
    root.dataset.trialConductor = "live";
    return () => {
      delete root.dataset.trialConductor;
    };
  }, [gate, stoodDown]);

  /* ─────────────── D24 · the keystroke that performs the handover ───────────────
     Capture phase, and it stops the event dead. The shell's own ⌘J listener
     would open Talk, and Talk carries a second pebble: while the conductor
     still owns the conversation there is exactly one pebble on screen, which
     is the bug the suppression exists for. So their press is heard here, the
     card ticks immediately (D24: acknowledged the moment it happens), the
     daemon is told, and the panel opens for them a few seconds later as part
     of the stand-down itself. Untrusted events are ignored, because the
     stand-down fires a synthetic one to open Talk and this must not eat it. */
  useEffect(() => {
    if (gate !== "live" || stoodDown) return;
    if (!proposal || proposal.beat !== "handover" || proposal.pressed) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.isTrusted) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "j" && e.key !== "J") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      summonDoneRef.current = true;
      pressedRef.current = true;
      setProposal((p) => (p && p.beat === "handover" ? { ...p, pressed: true } : p));
      sessionRef.current?.summonPressed();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [gate, stoodDown, proposal]);

  /* ─────────────────────── the stand-down itself ───────────────────────
     Polls the pure rules rather than reacting to one event, because the thing
     it is waiting for is an ABSENCE: the gap after the sentence the founder
     just earned. See standDown.ts for the three rules and why they conflict.
     Armed by a request from the daemon OR by onboarding finishing at all, and
     the second of those is what makes this unconditional: a model that never
     calls `teach_summon` no longer strands anybody. */
  useEffect(() => {
    if (gate !== "live" || stoodDown) return;
    if (!standAsked && finishedAtRef.current === null) return;
    const id = window.setInterval(() => {
      const verdict = standDownVerdict({
        requestedAt: standAtRef.current,
        finishedAt: finishedAtRef.current,
        speaking: speakingRef.current,
        spokeSinceRequest: spokeSinceRequestRef.current,
        now: Date.now(),
      });
      if (!verdict.stand) return;
      window.clearInterval(id);
      console.log(`[Trial] the conductor is standing down: ${verdict.because}`);
      setStoodDown(true);
    }, STANDDOWN_POLL_MS);
    return () => window.clearInterval(id);
  }, [gate, stoodDown, standAsked, finished]);

  /* The conversation itself ends here, and only here. One microphone, one
     realtime session, one pebble: the founder's next conversation is the
     shell's own, on the shell's own socket, which under D1 is also realtime
     for as long as the entitlement is running (see ws-service's
     `tryStartRealtimeVoice`). Then, if they pressed the key, the panel they
     summoned actually opens: the reward for the keystroke is the thing the
     keystroke does. */
  useEffect(() => {
    if (!stoodDown) return;
    sessionRef.current?.dispose();
    sessionRef.current = null;
    if (!pressedRef.current) return;
    const raf = requestAnimationFrame(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", ctrlKey: true, bubbles: true }));
    });
    return () => cancelAnimationFrame(raf);
  }, [stoodDown]);

  // D22, and the reason it was not true. The rooms under this conversation are
  // fetched over HTTP with a ten-minute credential; this conversation is an
  // hour long and never reloads. Renew it from in here, starting the moment the
  // layer goes live, because the token was minted before the founder opened the
  // page and some of its ten minutes is already spent. See sessionRenew.ts.
  //
  // Handed over to TrialClock at the stand-down, so exactly one thing is doing
  // it: after the handover this layer has no pebble left to report a failure
  // through, and the clock is the surface that outlives the conversation.
  useEffect(() => {
    if (gate !== "live" || stoodDown) return;
    let stopped = false;
    const renew = async () => {
      const ok = await renewTrialSession();
      if (!stopped) setStale(!ok);
    };
    void renew();
    const id = window.setInterval(() => void renew(), TRIAL_SESSION_RENEW_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [gate, stoodDown]);

  if (gate === "checking") return null;

  if (gate !== "live") {
    return <MicGate phase={gate} onTurnOn={askForMic} />;
  }

  /* ── after the handover ──
     The conducted hour is over and everything that belonged to it is gone: the
     pebble, the captions, the memory ticker, the microphone. What is left is
     the clock, because the TRIAL has not ended, and the hotkey card for a
     short while, because D28 makes it the reference they keep rather than a
     thing that flashes past. Underneath it, the ordinary shell: their own
     pebble, their own Talk panel, the palette, all of it. */
  if (stoodDown) {
    // `dayOne` is set HERE as well as in the gate, and this is the path that
    // actually matters: beat 14 fires about five minutes after the handover
    // and the founder has not reloaded, so this is the mount they are sitting
    // in when their agent comes back. The gate's copy covers the founder who
    // comes back later, at hour six or hour twenty.
    return (
      <TrialClock trial={trial} slot={<HandoverReference proposal={proposal} />} dayOne>
        {children}
      </TrialClock>
    );
  }

  return (
    <>
      {children}
      <div className="tc-layer" aria-live="polite">
        <ConductorPebble phase={phase} caption={caption} error={error} point={gestures.point} stale={stale} />
        <TrialProposal proposal={proposal} landed={landedProposal} />
        <VaultTicker landed={landedEntities} />
        <TrialFooter
          trial={trial}
          fuel={fuel}
          openingDone={openingDone}
          finished={finished !== null}
        />
      </div>
    </>
  );
}

/** How long the hotkey card stays after the handover. D28 calls it "the
 *  reference they keep"; a card that dissolved with the gesture would not be
 *  one, and a card pinned to their screen for the next 47 hours would be
 *  clutter in a product they have just been handed. */
const HANDOVER_LINGER_MS = 20_000;

function HandoverReference({ proposal }: { proposal: BeatProposal | null }) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setGone(true), HANDOVER_LINGER_MS);
    return () => window.clearTimeout(t);
  }, []);
  if (gone || !proposal || proposal.beat !== "handover") return null;
  return <TrialProposal proposal={{ ...proposal, handedOver: true }} landed={null} />;
}

/* ─────────────────── Frame 02 · the microphone gate ─────────────────── */

function MicGate({ phase, onTurnOn }: { phase: GatePhase; onTurnOn: () => void }) {
  const denied = phase === "denied";
  const unavailable = phase === "unavailable";
  return (
    <div className="tc-gate">
      <div className="tc-gate-wrap">
        <div className="tc-drop tc-drop--idle">
          <span className="in" />
        </div>
        <h2>Jarvis works by voice.</h2>
        <p className="tc-gate-sub">
          Turn on your microphone and it will introduce itself.
          <br />
          There is no typed way through this.
        </p>

        <div className={`tc-gate-card${denied || unavailable ? " is-warn" : ""}`}>
          <div className="tc-gate-card-text">
            <b>{denied ? "Microphone blocked" : unavailable ? "No microphone found" : "Microphone required"}</b>
            <span>
              {denied
                ? "Your browser is refusing the microphone. Allow it for this site, then try again."
                : unavailable
                  ? "Jarvis could not find a microphone on this machine."
                  : "So it can hear you, and so you never have to type."}
            </span>
          </div>
          <button className="tc-btn" onClick={onTurnOn} disabled={phase === "asking"} autoFocus>
            {phase === "asking" ? "Waiting…" : denied || unavailable ? "Try again" : "Turn on"}
          </button>
        </div>

        {/* D9, said plainly and only here. Nothing else in the opening
            mentions the clock, and nothing counts down. */}
        <p className="tc-gate-clock">
          Your 48 hours have not started. They begin at your first spoken word.
        </p>
      </div>
    </div>
  );
}

/* ─────────────── Frame 03 · the pebble, and Jarvis speaking first ─────────── */

function ConductorPebble({
  phase,
  caption,
  error,
  point,
  stale,
}: {
  phase: ConductorPhase;
  caption: string;
  error: string | null;
  point: PebblePoint | null;
  stale: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const pointing = usePebbleFlight(ref, point);
  const view = pebbleView({ phase, caption, error, pointing: pointing?.label ?? null, stale });
  return (
    <div
      ref={ref}
      className={`tc-pebble tc-pebble--${view.state}${pointing ? " is-pointing" : ""}`}
      style={pointing ? { transform: `translate(${pointing.dx}px, ${pointing.dy}px)` } : undefined}
    >
      <div className={`tc-drop tc-drop--${view.state}`}>
        <span className="in" />
      </div>
      <div className="tc-bubble">
        <span className={BUBBLE_CLASS[view.bubble.kind]}>{view.bubble.text}</span>
      </div>
    </div>
  );
}

const BUBBLE_CLASS: Record<PebbleBubble["kind"], string> = {
  caption: "",
  point: "tc-bubble-point",
  error: "tc-bubble-err",
  hint: "tc-bubble-hint",
};

/** How long the pebble holds its label at the target before drifting back.
 *  Long enough to be a gesture, short enough not to hide the caption. */
const POINT_HOLD_MS = 2400;

/**
 * The beat between one gesture and the next.
 *
 * This is NOT a matter of taste, and getting it wrong was visible in the
 * browser: the pebble's return to its dock is a 0.62s CSS transition, and the
 * flight measures `getBoundingClientRect()` to work out how far to travel. Ask
 * for the next stop before the return has finished and the measurement is
 * taken mid-transition, so the pebble sets off from where it happens to be at
 * that instant and lands nowhere near the thing it is pointing at. Measured:
 * with a 320ms gap the first stop of a walk landed on its target and the rest
 * did not.
 */
const GESTURE_GAP_MS = 760;

/** How long a stop in a walk holds. Shorter than a door being marked: there
 *  are several of them, each is one short line, and the whole walk has to fit
 *  inside the sentence Jarvis is saying over it. */
const WALK_HOLD_MS = 1500;

/** How often the stand-down rules are re-read. It is waiting for a gap in the
 *  speech, so it has to notice one within a fraction of a second. */
const STANDDOWN_POLL_MS = 400;

/** How long to wait for the thing that is about to be walked to exist. A flow
 *  editor has to fetch the flow and mount a graph; a room has to render. */
const ANCHOR_WAIT_MS = 6000;

/**
 * The pebble's gestures, one at a time and in order.
 *
 * Before this there was one `point` and each new one replaced it, which was
 * fine while a beat only ever pointed once. It stopped being fine the moment a
 * room started explaining itself: a walk down the three levels of their own
 * objective, immediately followed by the pebble marking that room's door,
 * would have played as one gesture and a flicker.
 */
function useGestureQueue(): {
  point: PebblePoint | null;
  push: (parts: { target: string; label: string; room?: string; hold?: number }[]) => void;
} {
  const queue = useRef<{ target: string; label: string; room?: string; hold?: number }[]>([]);
  const timer = useRef<number | null>(null);
  const [point, setPoint] = useState<PebblePoint | null>(null);

  const drain = (): void => {
    const next = queue.current.shift();
    if (!next) {
      timer.current = null;
      setPoint(null);
      return;
    }
    setPoint({ target: next.target, label: next.label, room: next.room, hold: next.hold, ts: Date.now() });
    timer.current = window.setTimeout(drain, (next.hold ?? POINT_HOLD_MS) + GESTURE_GAP_MS);
  };

  const push = (parts: { target: string; label: string; room?: string; hold?: number }[]): void => {
    if (parts.length === 0) return;
    queue.current.push(...parts);
    if (timer.current === null) drain();
  };

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  return { point, push };
}

/**
 * Turn a walk into a list of things to point at.
 *
 * Two shapes, and the difference matters. A goal walk names its anchors: the
 * daemon created those rows and knows their ids. A FLOW walk names none of
 * them, because the daemon proposed the flow in the founder's own sentences
 * and the composer decided what the nodes actually are, so the only honest
 * source for "what is in this flow" is the flow on the screen.
 *
 * Either way it waits for the thing to exist first: the room action that opens
 * the editor and the walk that follows it are broadcast in the same breath,
 * and a graph takes a moment to fetch and mount.
 */
async function resolveWalk(walk: PebbleWalk): Promise<{ target: string; label: string; hold: number }[]> {
  if (walk.kind === "flow") {
    const nodes = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[data-trial-anchor^="flow-step:"]')];
      return found.length > 0 ? found : null;
    });
    if (!nodes) return [];
    // Top to bottom is the order it runs in: the trigger sits at the top of
    // the graph and each step hangs below the one before it.
    return nodes
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      .slice(0, 4)
      .map((el) => ({
        target: `part:${el.dataset.trialAnchor}`,
        label: el.dataset.trialLabel || el.textContent?.trim().slice(0, 40) || "a step",
        hold: WALK_HOLD_MS,
      }));
  }

  if (walk.parts.length === 0) return [];
  // Wait once, for the first one. If the room is up, the rest of it is up.
  const first = await waitFor(() => document.querySelector<HTMLElement>(anchorSel(walk.parts[0]!.anchor)));
  if (!first) return [];
  return walk.parts
    .filter((part) => document.querySelector(anchorSel(part.anchor)) !== null)
    .map((part) => ({ target: `part:${part.anchor}`, label: part.label ?? "", hold: WALK_HOLD_MS }));
}

function anchorSel(anchor: string): string {
  return `[data-trial-anchor="${CSS.escape(anchor)}"]`;
}

/** Poll for something to appear. Resolves null rather than throwing: a walk
 *  that cannot find its subject simply does not happen, and nothing else in
 *  the conversation depends on it. */
async function waitFor<T>(get: () => T | null, timeoutMs = ANCHOR_WAIT_MS): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = get();
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 120));
  }
}

/**
 * D21, in the browser.
 *
 * The shipping `pebble.point_at` flies the OS sidecar's pebble to a screen
 * coordinate. The trial's founder is looking at a browser, and the pebble they
 * can see is a DOM node, so this is the same gesture in the same shape: the
 * pebble leaves its corner, goes and stands next to the room it is about to
 * open, holds a label there, and drifts back. It moves BEFORE the room opens,
 * so the founder's eye is already where the change is going to happen.
 *
 * Purely visual and entirely optional: if the target is not on screen (the
 * Index is collapsed to cluster tiles, or a room is expanded over it), the
 * pebble simply stays where it is and the room opens as normal.
 */
function usePebbleFlight(
  ref: React.RefObject<HTMLDivElement | null>,
  point: PebblePoint | null,
): { dx: number; dy: number; label: string } | null {
  const [flight, setFlight] = useState<{ dx: number; dy: number; label: string } | null>(null);
  useEffect(() => {
    if (!point) return;
    const el = ref.current;
    if (!el) return;
    // Two kinds of target, and they are two different scales of the same
    // gesture. `room:` points at a room's row in the Index, which is the door.
    // `part:` points at something INSIDE what the founder just made: a key
    // result on their own tree, a node in their own flow. D41's "more of the
    // room actually shown", delivered without a tour.
    const isPart = point.target.startsWith("part:");
    const target = isPart
      ? document.querySelector(anchorSel(point.target.slice(5)))
      : (() => {
          const room = point.target.startsWith("room:") ? point.target.slice(5) : point.target;
          return document.querySelector(`[data-nav-room="${room}"]`)
            ?? document.querySelector(`[data-nav-cluster~="${room}"]`);
        })();
    if (!target) return;

    // Two steps, and the first one is not decoration. The pebble is anchored
    // to the RIGHT edge of the screen, so its left edge depends on how wide
    // its bubble currently is; pointing swaps the caption for a label and
    // re-lays it out. Measuring before that swap put it tens of pixels off.
    // So: enter the pointing state first with no translation, let it settle,
    // then measure and fly.
    setFlight({ dx: 0, dy: 0, label: point.label });
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const from = el.getBoundingClientRect();
        const to = target.getBoundingClientRect();
        // Two placements, because the two kinds of target have different things
        // next to them.
        //
        // A room's row in the Index has nothing to its right, so the pebble
        // stands there and the founder can still read the name it is pointing
        // at. A PART is a node in a graph or a node in a tree, and both of
        // those are laid out left to right: standing to the right of one means
        // standing on top of the next one. Measured in the browser, on his own
        // flow: the pebble covered the step after the trigger. So parts are
        // approached from ABOVE, with the drop over the node's left edge and
        // the label running right across empty space.
        setFlight(
          isPart
            ? {
                dx: to.left - from.left,
                dy: to.top - 14 - from.bottom,
                label: point.label,
              }
            : {
                dx: to.right + 14 - from.left,
                dy: to.top + to.height / 2 - (from.top + from.height / 2),
                label: point.label,
              },
        );
      });
    });
    const t = window.setTimeout(() => setFlight(null), point.hold ?? POINT_HOLD_MS);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(t);
    };
  }, [point, ref]);
  return flight;
}

/* ─── Frame 04 · the vault filling while they are still talking (D22) ─── */

function VaultTicker({ landed }: { landed: LandedEntity[] }) {
  if (landed.length === 0) return null;
  return (
    <div className="tc-vault">
      <div className="tc-vault-head">
        <span className="tc-dot" />
        memory
      </div>
      <ul className="tc-vault-list">
        {landed.slice(0, 8).map((e, i) => (
          <li key={`${e.id}-${i}`} className={e.isNew ? "is-new" : ""}>
            <span className="tc-vault-name">{e.name}</span>
            <span className="tc-vault-kind">{e.role || e.type}</span>
            {i === 0 && <span className="tc-vault-now">just now</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── The clock, and the two things that are not the founder's business ──

   The clock stays: D3 and D9 make "48 hours, starting at your first word" a
   thing the founder is told plainly, and the gate screen says it before they
   speak. What went, on 26 August, is everything that told them HOW FAR ALONG
   THEY WERE. See reviewMode.ts. */

function TrialFooter({
  trial,
  fuel,
  openingDone,
  finished,
}: {
  trial: TrialStatus | null;
  fuel: CapturedFuel[];
  openingDone: boolean;
  finished: boolean;
}) {
  const remaining = formatTimeRemaining(trial?.ms_remaining ?? null);
  // Read once: whether this browser is somebody reviewing a run or a founder
  // living one. See reviewMode.ts for why the coverage counter is not the
  // founder's business (D12), and why it was on their screen anyway.
  const [review] = useState(isReviewMode);
  return (
    <div className="tc-foot">
      <span className="tc-foot-clock">
        {trial?.started_at ? `48 hours · ${remaining} left` : "48 hours · not started"}
      </span>
      {/* D44 resplit the five soft targets: the opening now goes looking for
          `company` only, and the other four are asked for in the beat that
          needs them, with the founder's own documents already open. So the bare
          x/5 was about to start reading as a broken opening. What a reviewer
          actually needs to know is whether the opening got the one thing it is
          responsible for. See FUEL_AREAS in src/daemon/trial/conductor.ts. */}
      {review && (
        <span className="tc-foot-fuel" title={fuel.map((f) => `${f.area}: ${f.summary}`).join("\n")}>
          {fuel.some((f) => f.area === "company") ? "company" : "no company yet"} · {fuel.length}/5 fuel
        </span>
      )}
      {/* The seam is a fact about the session, not a position in it, and it is
          only drawn for a reviewer for the same reason the counter is: a
          founder who reads "opening complete" has been told there are stages
          and that one of them is behind them (D12). */}
      {review && (finished
        ? <span className="tc-foot-seam">set up</span>
        : openingDone && <span className="tc-foot-seam">opening complete</span>)}
    </div>
  );
}
