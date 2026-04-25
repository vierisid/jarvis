import { useEffect, useRef } from "react";

/**
 * Global push-to-talk via Spacebar.
 *
 * Hold Space anywhere outside an editable element → start recording.
 * Release Space → stop recording.
 *
 * Editable-element check: if focus is inside an `<input>`, `<textarea>`, a
 * native `contenteditable`, or any element with role=textbox, the spacebar
 * keeps its native meaning (typing) and PTT is suppressed.
 *
 * Repeat keydown events that fire continuously while a key is held are
 * ignored so we only start recording once per press.
 */
export function useSpacebarPTT({
  startRecording,
  stopRecording,
  interrupt,
  enabled = true,
  voiceState,
}: {
  startRecording: () => void;
  stopRecording: () => void;
  /** Called when PTT triggers while voice is busy (speaking/thinking) — interrupts then starts. */
  interrupt: () => void;
  enabled?: boolean;
  voiceState: string;
}): void {
  // Stable callbacks via ref so changing identities don't churn the listeners.
  const startRef = useRef(startRecording);
  const stopRef = useRef(stopRecording);
  const interruptRef = useRef(interrupt);
  const stateRef = useRef(voiceState);
  const heldRef = useRef(false);

  useEffect(() => { startRef.current = startRecording; }, [startRecording]);
  useEffect(() => { stopRef.current = stopRecording; }, [stopRecording]);
  useEffect(() => { interruptRef.current = interrupt; }, [interrupt]);
  useEffect(() => { stateRef.current = voiceState; }, [voiceState]);

  useEffect(() => {
    if (!enabled) return;

    const isEditable = (el: EventTarget | null): boolean => {
      if (!el || !(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return true;
      if (el.isContentEditable) return true;
      if (el.getAttribute("role") === "textbox") return true;
      return false;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      // Ignore auto-repeat — only the first keydown matters.
      if (e.repeat) return;
      // Don't hijack Space inside text fields.
      if (isEditable(e.target)) return;
      // Don't conflict with browser modifier shortcuts.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      e.preventDefault();
      heldRef.current = true;

      const s = stateRef.current;
      if (s === "speaking" || s === "processing" || s === "wake_detected") {
        // PTT during a busy state interrupts before starting.
        interruptRef.current();
      } else if (s === "idle") {
        startRef.current();
      }
      // If already recording (rare — user spammed), no-op.
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (!heldRef.current) return;
      heldRef.current = false;
      // Stop only if we're actually recording (PTT may have been suppressed
      // by an editable element on keydown — heldRef would be false then).
      if (stateRef.current === "recording") {
        stopRef.current();
      }
    };

    // If focus moves to an editable element while space is held, release the
    // PTT cleanly to avoid stuck-on recording.
    const onBlur = () => {
      if (heldRef.current && stateRef.current === "recording") {
        heldRef.current = false;
        stopRef.current();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [enabled]);
}
