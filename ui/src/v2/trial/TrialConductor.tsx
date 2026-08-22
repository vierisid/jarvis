import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ConductorSession,
  microphoneAlreadyGranted,
  requestMicrophone,
  type CapturedFuel,
  type ConductorPhase,
  type LandedEntity,
} from "./conductorSession";
import { formatTimeRemaining, type TrialStatus } from "./trialGate";
import "./TrialConductor.css";

/* ═══════════════ The opening of the 48-hour trial, beats 01 to 05 ═══════════
   Storyboard frames 02 to 04. Two surfaces, and the second one is the reason
   this is not a wizard:

     1. The microphone gate. Full screen, one thing on it. D10 — voice is
        mandatory and there is no typed path through the trial.
     2. Everything after it. The gate DISSOLVES and the live shell is
        underneath, with the pebble and the captions floating over it. That is
        what lets the founder watch their vault fill while they are still
        talking (D22, frame 04), and it is the surface the seven room beats
        will need, since under D17 the rooms are things Jarvis does WHILE the
        conversation continues.

   There is no welcome screen, no bullet points and no "click to begin" (D10):
   the moment the microphone is on, the session opens and Jarvis speaks. */

type GatePhase = "checking" | "gate" | "asking" | "denied" | "unavailable" | "live";

export function TrialConductor({ children }: { children: React.ReactNode }) {
  const [gate, setGate] = useState<GatePhase>("checking");
  const [phase, setPhase] = useState<ConductorPhase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [caption, setCaption] = useState<string>("");
  const [landed, setLanded] = useState<LandedEntity[]>([]);
  const [fuel, setFuel] = useState<CapturedFuel[]>([]);
  const [trial, setTrial] = useState<TrialStatus | null>(null);
  const [openingDone, setOpeningDone] = useState(false);
  const sessionRef = useRef<ConductorSession | null>(null);
  /** Streaming assistant deltas accumulate here until the turn is final. */
  const partialRef = useRef<string>("");

  // Already granted from a previous run? Then there is nothing to ask and the
  // gate must not appear at all — D10's prompt exists only when it is needed.
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
        // A closed session is a dead end in the opening, not a quiet return to
        // typing: voice is the only path through the trial (D10). The daemon's
        // own reason is used when it has one — a plan that excludes realtime
        // says so — because "say that again" is advice the founder cannot act
        // on here.
        if (p === "error") setError(detail ?? "Something went wrong.");
        else if (p === "closed") setError(detail ?? "The conversation ended. Reload to pick it back up.");
        else setError(null);
      },
      onTranscript: (role, text, final) => {
        if (role === "assistant") {
          partialRef.current = final ? text : partialRef.current + text;
          setCaption(partialRef.current);
          if (final) partialRef.current = "";
          setPhase("speaking");
        } else if (final) {
          setPhase("listening");
        }
      },
      onEntitiesLanded: (next) => {
        // Newest first: the founder is watching the top of this list.
        setLanded((prev) => [...next].reverse().concat(prev).slice(0, 40));
      },
      onFuelCaptured: (f) => setFuel((prev) => [...prev.filter((p) => p.area !== f.area), f]),
      onTrialStatus: (s) => setTrial(s),
      onOpeningComplete: () => setOpeningDone(true),
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

  if (gate === "checking") return null;

  if (gate !== "live") {
    return <MicGate phase={gate} onTurnOn={askForMic} />;
  }

  return (
    <>
      {children}
      <div className="tc-layer" aria-live="polite">
        <ConductorPebble phase={phase} caption={caption} error={error} />
        <VaultTicker landed={landed} />
        <TrialFooter trial={trial} fuel={fuel} openingDone={openingDone} />
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
}: {
  phase: ConductorPhase;
  caption: string;
  error: string | null;
}) {
  const state = error ? "error" : phase;
  return (
    <div className={`tc-pebble tc-pebble--${state}`}>
      <div className={`tc-drop tc-drop--${state}`}>
        <span className="in" />
      </div>
      <div className="tc-bubble">
        {error ? (
          <span className="tc-bubble-err">{error}</span>
        ) : caption ? (
          <span>{caption}</span>
        ) : (
          <span className="tc-bubble-hint">
            {phase === "connecting" ? "…" : phase === "listening" ? "your turn" : "…"}
          </span>
        )}
      </div>
    </div>
  );
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
}: {
  trial: TrialStatus | null;
  fuel: CapturedFuel[];
  openingDone: boolean;
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
      {openingDone && <span className="tc-foot-seam">opening complete</span>}
    </div>
  );
}
