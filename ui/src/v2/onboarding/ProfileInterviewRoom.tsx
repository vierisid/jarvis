import React, { useEffect, useRef, useState } from "react";
import { ArrowRight, Mic, Send, SkipForward } from "lucide-react";
import { Button, Icon } from "../ui";
import { MicOrb } from "../shell/MicOrb";
import { useInterviewSession } from "./useInterviewSession";
import "./ProfileInterviewRoom.css";

/**
 * Phase B — fullscreen conversational onboarding interview. Centered
 * MicOrb that pulses while Jarvis speaks; live transcript bubbles
 * for the conversation; type-or-talk composer at the bottom; Skip
 * button always available.
 *
 * Voice flow: Jarvis speaks → orb pulses speaking → on TTS end the
 * orb flips to listening → browser SpeechRecognition collects user
 * audio → user clicks Send (or hits Enter) → daemon runs another
 * agent turn. Text-only fallback uses the same composer without TTS.
 */
export function ProfileInterviewRoom({
  ttsDisabled,
  onComplete,
}: {
  /** True when the user picked "no TTS" in Phase A. Hides the speak
   *  button and forces the chat-bubble layout. */
  ttsDisabled: boolean;
  /** Called after the agent wraps the interview AND the user clicks
   *  Continue. The gate then refetches `/api/onboarding/status` and
   *  falls through to the live shell (or to Phase C, when that ships). */
  onComplete: () => void;
}) {
  const session = useInterviewSession({ ttsDisabled });
  const [composerText, setComposerText] = useState("");
  const [recognizingByVoice, setRecognizingByVoice] = useState(false);
  const recognizerRef = useRef<any>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the bubble list to the latest entry.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [session.messages.length, session.partialUserText]);

  // Auto-arm browser SpeechRecognition when the orb hits "listening"
  // (and the user hasn't opted into text-only). The recognizer feeds
  // setPartialUserText so the live transcript shows under the orb;
  // we send the final text via `sendUserMessage`.
  useEffect(() => {
    if (session.textOnly) return;
    if (session.phase !== "listening") {
      // Tear down any in-flight recognizer when we leave listening.
      if (recognizerRef.current) {
        try { recognizerRef.current.stop(); } catch { /* ignore */ }
        recognizerRef.current = null;
        setRecognizingByVoice(false);
      }
      return;
    }
    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      // Browser doesn't support STT — fall back to text-only quietly.
      return;
    }

    const rec = new SpeechRecognitionCtor();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = "en-US";
    let finalText = "";

    rec.onresult = (event: any) => {
      let interim = "";
      let captured = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        const t = String(r?.[0]?.transcript ?? "");
        if (r?.isFinal) captured += t;
        else interim += t;
      }
      if (captured) finalText += captured;
      session.setPartialUserText((finalText + interim).trim());
    };

    rec.onend = () => {
      const text = finalText.trim();
      recognizerRef.current = null;
      setRecognizingByVoice(false);
      if (text) session.sendUserMessage(text);
    };

    rec.onerror = (err: any) => {
      console.warn("[Interview] STT error:", err);
      recognizerRef.current = null;
      setRecognizingByVoice(false);
    };

    try {
      rec.start();
      recognizerRef.current = rec;
      setRecognizingByVoice(true);
    } catch (err) {
      console.warn("[Interview] STT start failed:", err);
    }

    return () => {
      try { rec.stop(); } catch { /* ignore */ }
      recognizerRef.current = null;
      setRecognizingByVoice(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.phase, session.textOnly]);

  const handleSendTyped = () => {
    const text = composerText.trim();
    if (!text) return;
    setComposerText("");
    session.sendUserMessage(text);
  };

  const handleSkip = async () => {
    if (!confirm("Skip the profile interview? You can come back to it any time from Settings.")) return;
    try {
      await fetch("/api/onboarding/profile/skip", { method: "POST" });
      onComplete();
    } catch (err) {
      console.error("[Interview] Skip failed:", err);
    }
  };

  // ── Render ────────────────────────────────────────────────────────

  if (session.phase === "done") {
    return (
      <div className="v2-interview" role="dialog" aria-modal="true" aria-label="Onboarding interview complete">
        <div className="v2-interview__wrap">
          <div className="v2-interview__done">
            <h1 className="v2-interview__done-title">Got it.</h1>
            <p className="v2-interview__done-body">
              {session.farewell ||
                "I have plenty to start with. Welcome to Jarvis."}
            </p>
            <p className="v2-interview__done-meta">
              {session.factsRecorded} {session.factsRecorded === 1 ? "fact" : "facts"} captured.
            </p>
            <Button variant="primary" size="md" onClick={onComplete}>
              Continue
              <Icon icon={ArrowRight} size="sm" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="v2-interview" role="dialog" aria-modal="true" aria-label="Onboarding interview">
      <div className="v2-interview__wrap">
        <header className="v2-interview__head">
          <div className="v2-interview__brand">JARVIS · onboarding</div>
          <div className="v2-interview__meta">
            <span className="v2-interview__facts-count">
              {session.factsRecorded} {session.factsRecorded === 1 ? "fact" : "facts"} captured
            </span>
            <button type="button" className="v2-interview__skip" onClick={handleSkip}>
              <Icon icon={SkipForward} size="sm" />
              Skip
            </button>
          </div>
        </header>

        {/* Centered orb anchors the page even when transcript is short. */}
        <div className="v2-interview__orb-wrap">
          <MicOrb state={session.orbState} size={120} />
          <div className="v2-interview__phase-label">
            {phaseLabel(session.phase)}
          </div>
          {session.partialUserText && (
            <div className="v2-interview__partial">"{session.partialUserText}"</div>
          )}
        </div>

        {/* Conversation bubbles */}
        <div className="v2-interview__messages" aria-live="polite">
          {session.messages.length === 0 && session.phase === "connecting" && (
            <p className="v2-interview__hint">Connecting…</p>
          )}
          {session.messages.map((m, i) => (
            <div
              key={`${m.ts}-${i}`}
              className="v2-interview__bubble"
              data-role={m.role}
            >
              {m.text}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {session.error && (
          <div className="v2-interview__error" role="alert">
            {session.error}
          </div>
        )}

        {/* Composer — always visible. Replaces voice when user types. */}
        <div className="v2-interview__composer">
          {!session.textOnly && (
            <div className="v2-interview__voice-pill" data-active={recognizingByVoice}>
              <Icon icon={Mic} size="sm" />
              {recognizingByVoice ? "Listening…" : "Voice ready"}
            </div>
          )}
          <input
            type="text"
            className="v2-interview__input"
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSendTyped();
              }
            }}
            placeholder={
              session.textOnly
                ? "Type your answer…"
                : "Or type your answer instead of speaking…"
            }
            disabled={session.phase === "thinking" || session.phase === "speaking"}
            aria-label="Type your reply"
          />
          <Button
            variant="primary"
            size="md"
            onClick={handleSendTyped}
            disabled={!composerText.trim() || session.phase === "thinking"}
          >
            <Icon icon={Send} size="sm" />
            Send
          </Button>
        </div>

        {!session.textOnly && (
          <button
            type="button"
            className="v2-interview__toggle-text"
            onClick={() => session.setTextOnly(true)}
          >
            Continue with text only
          </button>
        )}
      </div>
    </div>
  );
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "connecting": return "Connecting…";
    case "thinking": return "Jarvis is thinking…";
    case "speaking": return "Jarvis is speaking — listen up";
    case "listening": return "Your turn — speak or type";
    case "ready": return "Ready";
    case "error": return "Error";
    default: return "";
  }
}
