import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SpotlightOverlay } from "./SpotlightOverlay";
import { SpotlightBubble } from "./SpotlightBubble";
import { TUTORIAL_STEPS } from "./TutorialSteps";
import {
  useTutorialEventListener,
  type TutorialEventName,
} from "./TutorialEventContext";
import "./TutorialRoom.css";

/**
 * Phase C — spotlight walkthrough orchestrator.
 *
 * Sits on TOP of the live AppShell as a fixed overlay (NOT a
 * fullscreen replacement like Phase A/B). The user can interact
 * with the highlighted feature inside the cut-out — clicks and
 * keystrokes pass through naturally because the SVG dim sits below
 * the bubble's z-index but above the rest, with `pointer-events:
 * none` on the cut-out region (the SVG mask creates a transparent
 * hole that doesn't block clicks).
 *
 * Step lifecycle:
 *   1. Mount step → speak narration via /api/onboarding/tutorial/speak
 *      (daemon broadcasts tts_start + chunks, AppShell's useVoice
 *      plays them through the existing speaker pipeline)
 *   2. User advances by clicking Next, pressing arrow/Enter, saying
 *      "next" (voice action), OR performing the step's auto-advance
 *      action (e.g. opening the palette)
 *   3. On every step advance, persist progress via
 *      /api/onboarding/tutorial/progress so a refresh resumes
 *   4. On final step → /api/onboarding/tutorial/complete → onComplete()
 *      bubbles to OnboardingGate which refetches status and removes us
 *
 * Sample-data injection: steps 5 and 6 need an InlineCard / RoomWindow
 * to spotlight. We lazily inject those via the `injectSample` callback
 * (wired in OnboardingGate) which calls `live.injectCard` /
 * `live.openRoomWindow`. The samples persist after the tutorial — no
 * explicit cleanup — they're harmless visually and the user can
 * dismiss them via the normal close affordances.
 */

interface TutorialRoomProps {
  /** Optional resume key from `tutorial_progress_step`. Skips ahead
   *  to that step on mount. Falls back to step 0 if invalid. */
  resumeFromStepId?: string | null;
  /** Called when the user finishes (Finish on the last step) OR
   *  dismisses (Skip tour). Both fire the appropriate backend
   *  endpoint first. */
  onComplete: () => void;
  /** Inject a sample InlineCard into the thread for the
   *  "inline-card" step. Wired by OnboardingGate to
   *  `live.injectCard`. */
  injectSampleCard: () => void;
  /** Open a sample RoomWindow inline for the "inline-roomwindow"
   *  step. Wired by OnboardingGate to `live.openRoomWindow("memory")`. */
  injectSampleRoomWindow: () => void;
}

export function TutorialRoom({
  resumeFromStepId,
  onComplete,
  injectSampleCard,
  injectSampleRoomWindow,
}: TutorialRoomProps) {
  const initialIndex = useMemo(() => {
    if (!resumeFromStepId) return 0;
    const idx = TUTORIAL_STEPS.findIndex((s) => s.id === resumeFromStepId);
    return idx >= 0 ? idx : 0;
  }, [resumeFromStepId]);

  const [stepIndex, setStepIndex] = useState(initialIndex);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const speakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const step = TUTORIAL_STEPS[stepIndex]!;
  const isLast = stepIndex === TUTORIAL_STEPS.length - 1;

  // ── Mute the AppShell's mic for the duration of the tutorial ──────
  // The narration plays through the user's speakers, gets picked up by
  // the mic, transcribed by browser SpeechRecognition, and sent to the
  // chat agent as a "user message" — Jarvis then conversationally
  // responds to its own onboarding script. Suppress the mic entirely
  // while the overlay is mounted. AppShell subscribes via the matching
  // window CustomEvent (mirrors the sample-injection pattern).
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("v2-tutorial:mute-mic"));
    return () => {
      window.dispatchEvent(new CustomEvent("v2-tutorial:unmute-mic"));
    };
  }, []);

  // ── Sample-data injection on entering certain steps ────────────────
  useEffect(() => {
    if (step.requireSampleCard) injectSampleCard();
    if (step.requireSampleRoomWindow) injectSampleRoomWindow();
    // Approval step: no inject — narration alone (Phase E will add
    // a proper sample-approval injection path).
  }, [step.id, step.requireSampleCard, step.requireSampleRoomWindow, injectSampleCard, injectSampleRoomWindow]);

  // ── Room navigation for the per-room walkthrough block ─────────────
  // Each per-room step asks the AppShell to open that Room fullscreen
  // before the spotlight renders, so the user sees the actual surface
  // behind the dim while Jarvis explains it. The outro asks for the
  // open Room to be closed so the centered card lands on the thread.
  useEffect(() => {
    if (step.closeRoomBefore) {
      window.dispatchEvent(new CustomEvent("v2-tutorial:close-room"));
    } else if (step.openRoomBefore) {
      window.dispatchEvent(
        new CustomEvent("v2-tutorial:open-room", { detail: { key: step.openRoomBefore } }),
      );
    }
  }, [step.id, step.openRoomBefore, step.closeRoomBefore]);

  // ── TTS narration on every step ──────────────────────────────────
  // Fire the speak endpoint; it returns when synthesis completes.
  // We optimistically set `speaking` for ~estimate(text) so the bubble
  // shows the speaking dot even if we miss the tts_start/end timing.
  useEffect(() => {
    let cancelled = false;
    const text = step.narration;
    const estimateMs = Math.min(15_000, Math.max(2_000, text.length * 60));
    setSpeaking(true);
    if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current);
    speakingTimerRef.current = setTimeout(() => {
      if (!cancelled) setSpeaking(false);
    }, estimateMs);

    fetch("/api/onboarding/tutorial/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    })
      .then(() => {
        // Daemon resolves when synthesis is done. Add a tail so the
        // last audio chunk has time to actually play through the
        // user's speakers before we clear the speaking state.
        if (!cancelled) {
          setTimeout(() => {
            if (!cancelled) setSpeaking(false);
          }, 600);
        }
      })
      .catch(() => {
        // TTS off / no provider — bubble already shows the text;
        // just clear the speaking state.
        if (!cancelled) setSpeaking(false);
      });

    return () => {
      cancelled = true;
      if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current);
    };
  }, [step.id, step.narration]);

  // ── Persist progress (resume support) ────────────────────────────
  useEffect(() => {
    fetch("/api/onboarding/tutorial/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stepId: step.id }),
    }).catch(() => {
      /* progress save is best-effort; doesn't block UX */
    });
  }, [step.id]);

  // ── Step advance ─────────────────────────────────────────────────
  const advance = useCallback(() => {
    setStepIndex((i) => {
      if (i + 1 >= TUTORIAL_STEPS.length) {
        // Final step's Next → complete
        fetch("/api/onboarding/tutorial/complete", { method: "POST" })
          .catch(() => {})
          .finally(() => onComplete());
        return i;
      }
      return i + 1;
    });
  }, [onComplete]);

  const back = useCallback(() => {
    setStepIndex((i) => Math.max(0, i - 1));
  }, []);

  const skip = useCallback(() => {
    if (!confirm("Skip the tour? You can replay it any time from Settings → Onboarding.")) return;
    fetch("/api/onboarding/tutorial/dismiss", { method: "POST" })
      .catch(() => {})
      .finally(() => onComplete());
  }, [onComplete]);

  const replayNarration = useCallback(() => {
    // Re-trigger the speak effect by bumping the dependency. Cheapest
    // way: nudge a counter that the effect ignores but causes re-run.
    // Simpler: just call the endpoint again directly.
    fetch("/api/onboarding/tutorial/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: step.narration }),
    }).catch(() => {});
    setSpeaking(true);
    setTimeout(() => setSpeaking(false), Math.max(2000, step.narration.length * 55));
  }, [step.narration]);

  // ── Auto-advance on user action ──────────────────────────────────
  // Subscribe to the step's auto-advance event (if any). Hooks must
  // be called unconditionally, so we register one for each event name
  // the steps could care about and check inside.
  useTutorialEventListener("palette_opened", () => {
    if (step.autoAdvanceOn === "palette_opened") advance();
  });
  useTutorialEventListener("room_opened", () => {
    if (step.autoAdvanceOn === "room_opened") advance();
  });
  useTutorialEventListener("notif_opened", () => {
    if (step.autoAdvanceOn === "notif_opened") advance();
  });

  // ── Keyboard nav ─────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack typing inside an input/textarea (especially the
      // composer — the user might be trying the "type something" hint).
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;

      if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        advance();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        back();
      } else if (e.key === "Escape") {
        e.preventDefault();
        skip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, back, skip]);

  return (
    <div className="v2-tutorial-root" aria-label="Onboarding tutorial">
      <SpotlightOverlay
        targetSelector={step.target}
        onRectChange={setRect}
      />
      <SpotlightBubble
        rect={rect}
        narration={step.narration}
        tryHint={step.tryHint}
        prefer={step.prefer}
        stepIndex={stepIndex}
        totalSteps={TUTORIAL_STEPS.length}
        speaking={speaking}
        onNext={advance}
        onSkip={skip}
        onReplayNarration={replayNarration}
        isLast={isLast}
      />
    </div>
  );
}
