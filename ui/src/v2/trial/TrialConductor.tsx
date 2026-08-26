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
  type ProposalLanded,
} from "./conductorSession";
import { TrialProposal } from "./TrialProposal";
import { pebbleView, type PebbleBubble } from "./pebbleState";
import { formatTimeRemaining, type TrialStatus } from "./trialGate";
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
        talking (D22, frame 04), and it is the surface the seven room beats
        will need, since under D17 the rooms are things Jarvis does WHILE the
        conversation continues.

   There is no welcome screen, no bullet points and no "click to begin" (D10):
   the moment the microphone is on, the session opens and Jarvis speaks.

   The seven room beats (D16) render on the SAME surface, over the same live
   shell, while the same conversation carries on. Nothing about this component
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
  const [point, setPoint] = useState<PebblePoint | null>(null);
  const [finished, setFinished] = useState<OnboardingComplete | null>(null);
  const sessionRef = useRef<ConductorSession | null>(null);
  /** Streaming assistant deltas accumulate here until the turn is final. */
  const partialRef = useRef<string>("");

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
        setPoint(p);
        // The room opens BEHIND the gesture, not in front of it (D21): the
        // pebble leaves its corner first, and by the time the room is on the
        // screen the founder is already looking at where it came from.
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
      onOnboardingComplete: (summary) => setFinished(summary),
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
  useEffect(() => {
    if (gate !== "live") return;
    const root = document.documentElement;
    root.dataset.trialConductor = "live";
    return () => {
      delete root.dataset.trialConductor;
    };
  }, [gate]);

  if (gate === "checking") return null;

  if (gate !== "live") {
    return <MicGate phase={gate} onTurnOn={askForMic} />;
  }

  return (
    <>
      {children}
      <div className="tc-layer" aria-live="polite">
        <ConductorPebble phase={phase} caption={caption} error={error} point={point} />
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
}: {
  phase: ConductorPhase;
  caption: string;
  error: string | null;
  point: PebblePoint | null;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const pointing = usePebbleFlight(ref, point);
  const view = pebbleView({ phase, caption, error, pointing: pointing?.label ?? null });
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
    const room = point.target.startsWith("room:") ? point.target.slice(5) : point.target;
    const target =
      document.querySelector(`[data-nav-room="${room}"]`)
      ?? document.querySelector(`[data-nav-cluster~="${room}"]`);
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
        // Stand just to the RIGHT of the row rather than on top of it: the
        // founder has to be able to read the name it is pointing at.
        setFlight({
          dx: to.right + 14 - from.left,
          dy: to.top + to.height / 2 - (from.top + from.height / 2),
          label: point.label,
        });
      });
    });
    const t = window.setTimeout(() => setFlight(null), POINT_HOLD_MS);
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

/* ── The clock, and the seam. Neither counts down at the founder (D37). ── */

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
  return (
    <div className="tc-foot">
      <span className="tc-foot-clock">
        {trial?.started_at ? `48 hours · ${remaining} left` : "48 hours · not started"}
      </span>
      {/* Coverage is shown to whoever is REVIEWING the opening, never spoken
          and never used to decide what Jarvis asks next. See D12. */}
      <span className="tc-foot-fuel" title={fuel.map((f) => `${f.area}: ${f.summary}`).join("\n")}>
        {fuel.length}/5
      </span>
      {finished
        ? <span className="tc-foot-seam">set up</span>
        : openingDone && <span className="tc-foot-seam">opening complete</span>}
    </div>
  );
}
