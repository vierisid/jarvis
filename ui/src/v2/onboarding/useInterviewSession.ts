import { useCallback, useEffect, useRef, useState } from "react";
import type { OrbState } from "../shell/MicOrb";

/**
 * Phase B — UI hook driving the onboarding profile interview.
 *
 * Owns the WebSocket lifecycle for the interview message types
 * (`interview_start`, `interview_user_message`, `interview_assistant`,
 * `interview_done`, `interview_error`) AND the local "current orb
 * state" + transcript-buffer machinery. The ProfileInterviewRoom
 * consumes this hook and renders.
 *
 * Voice flow (when TTS is on AND mic is available):
 *   1. Mount → connect WS → send `interview_start` → daemon replies
 *      with `interview_assistant` text + streams TTS audio.
 *   2. UI plays the audio (orb state="speaking"). When TTS audio ends,
 *      auto-arms recording (orb state="listening").
 *   3. User speaks → browser SpeechRecognition (or the existing voice
 *      pipeline) collects transcript → user clicks "send" or silence
 *      detection ends → we send `interview_user_message`.
 *   4. Repeat until `interview_done` arrives.
 *
 * Text-only fallback (TTS off OR mic unavailable):
 *   Same WS message types, but no auto-record. User types into a
 *   composer and hits Enter to send.
 *
 * The hook does NOT use the existing useVoice hook directly because
 * useVoice is the rail's voice machinery and would interfere with
 * the regular dashboard flow. We piggyback on the same TTS playback
 * pipeline (the daemon broadcasts `tts_start` + binary chunks; the
 * existing useVoice on AppShell would normally consume those — but
 * AppShell is not mounted while the gate renders ProfileInterviewRoom,
 * so we mount our own minimal TTS player here).
 */

export type InterviewMessage =
  | { role: "assistant"; text: string; ts: number }
  | { role: "user"; text: string; ts: number };

interface InterviewState {
  /** Connection + pipeline status. */
  phase: "connecting" | "ready" | "speaking" | "listening" | "thinking" | "done" | "error";
  /** Driver for the orb visual. Maps phase → OrbState. */
  orbState: OrbState;
  /** Full transcript so far — both sides. */
  messages: InterviewMessage[];
  /** Live STT partial under the orb. */
  partialUserText: string;
  /** Cumulative facts the agent has recorded. Updates after each turn. */
  factsRecorded: number;
  /** Closing line surfaced when the interview wraps. */
  farewell: string | null;
  /** Last error message, if any. */
  error: string | null;
}

interface InterviewControls {
  /** Send the user's text reply (typed OR transcribed). */
  sendUserMessage: (text: string) => void;
  /** Toggle text-only mode (skips TTS playback + auto-record). */
  setTextOnly: (next: boolean) => void;
  /** True when the user has explicitly opted out of voice. */
  textOnly: boolean;
  /** Update the live STT partial — driven by SpeechRecognition. */
  setPartialUserText: (text: string) => void;
}

export function useInterviewSession(opts: {
  /** True when the user picked "no TTS" in Phase A. Forces text-only. */
  ttsDisabled: boolean;
}): InterviewState & InterviewControls {
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<ArrayBuffer[]>([]);
  const audioPlayingRef = useRef(false);
  const ttsPendingRef = useRef(false);
  const ttsFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [phase, setPhase] = useState<InterviewState["phase"]>("connecting");
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [messages, setMessages] = useState<InterviewMessage[]>([]);
  const [partialUserText, setPartialUserText] = useState("");
  const [factsRecorded, setFactsRecorded] = useState(0);
  const [farewell, setFarewell] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [textOnly, setTextOnlyState] = useState(opts.ttsDisabled);
  // The WS handlers below live in a mount-once effect, so reading the
  // `textOnly` state there would see the value frozen at mount. The ref
  // is the live view — without it, toggling "Continue with text only"
  // mid-session left the handlers waiting for TTS that was no longer
  // requested.
  const textOnlyRef = useRef(textOnly);

  const clearTtsFallbackTimer = useCallback(() => {
    if (ttsFallbackTimerRef.current !== null) {
      clearTimeout(ttsFallbackTimerRef.current);
      ttsFallbackTimerRef.current = null;
    }
  }, []);

  /** Toggle text-only mode. Turning it ON also rescues a session stuck
   *  waiting on TTS audio — flip straight to listening so the composer
   *  re-enables. */
  const setTextOnly = useCallback(
    (next: boolean) => {
      textOnlyRef.current = next;
      setTextOnlyState(next);
      if (next && ttsPendingRef.current) {
        ttsPendingRef.current = false;
        clearTtsFallbackTimer();
        setPhase("listening");
        setOrbState("listening");
      }
    },
    [clearTtsFallbackTimer],
  );

  // ── WS lifecycle ─────────────────────────────────────────────────
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      setPhase("thinking");
      setOrbState("thinking");
      ws.send(
        JSON.stringify({
          type: "interview_start",
          payload: { speakReply: !textOnlyRef.current },
          timestamp: Date.now(),
        }),
      );
    };

    ws.onmessage = (event) => {
      // Binary frames are TTS audio chunks.
      if (event.data instanceof ArrayBuffer) {
        if (textOnlyRef.current) return; // ignore audio in text-only mode
        audioQueueRef.current.push(event.data);
        if (!audioPlayingRef.current) playNextChunk();
        return;
      }

      let msg: any;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }

      switch (msg.type) {
        case "interview_assistant": {
          const text = String(msg.payload?.text ?? "").trim();
          if (text) {
            setMessages((prev) => [
              ...prev,
              { role: "assistant", text, ts: msg.timestamp ?? Date.now() },
            ]);
          }
          if (typeof msg.payload?.facts_recorded === "number") {
            setFactsRecorded(msg.payload.facts_recorded);
          }
          // We get the text immediately; if TTS will follow, the
          // orb stays in "thinking" until tts_start fires. If not,
          // jump straight to listening so the user can reply. The
          // daemon says explicitly whether audio is coming
          // (`will_speak`) — trust it over our local mode guess, so
          // a TTS-less daemon never strands us waiting for audio.
          // (Older daemons omit the field; undefined falls through
          // to the local guess + timeout fallback below.)
          const willSpeak = msg.payload?.will_speak;
          if (textOnlyRef.current || !text || willSpeak === false) {
            setPhase("listening");
            setOrbState("listening");
          } else {
            ttsPendingRef.current = true;
            // Safety net: if tts_start never arrives (provider died,
            // pre-will_speak daemon with TTS off), un-stick the
            // composer rather than waiting forever.
            clearTtsFallbackTimer();
            ttsFallbackTimerRef.current = setTimeout(() => {
              ttsFallbackTimerRef.current = null;
              if (ttsPendingRef.current) {
                ttsPendingRef.current = false;
                setPhase("listening");
                setOrbState("listening");
              }
            }, 10_000);
          }
          break;
        }
        case "tts_start":
          if (!textOnlyRef.current) {
            ttsPendingRef.current = false;
            clearTtsFallbackTimer();
            setPhase("speaking");
            setOrbState("speaking");
            // Pre-warm AudioContext so the first chunk plays cleanly.
            getAudioContext();
          }
          break;
        case "tts_end":
          // Wait for the queue to drain in playNextChunk() before
          // flipping to listening. If the queue is already empty,
          // flip now.
          if (audioQueueRef.current.length === 0 && !audioPlayingRef.current) {
            setPhase("listening");
            setOrbState("listening");
          }
          break;
        case "interview_done": {
          setFarewell(String(msg.payload?.farewell ?? ""));
          if (typeof msg.payload?.facts_recorded === "number") {
            setFactsRecorded(msg.payload.facts_recorded);
          }
          // Wait for any in-flight TTS to drain before flipping done.
          const finishOnDrain = () => {
            if (audioQueueRef.current.length === 0 && !audioPlayingRef.current) {
              setPhase("done");
              setOrbState("idle");
            } else {
              setTimeout(finishOnDrain, 200);
            }
          };
          finishOnDrain();
          break;
        }
        case "interview_error":
          setError(String(msg.payload?.message ?? "Interview failed."));
          setPhase("error");
          setOrbState("idle");
          break;
        default:
          // Ignore unrelated messages — daemon may send chat / suggestions etc.
          break;
      }
    };

    ws.onerror = () => {
      setError("Connection error.");
      setPhase("error");
      setOrbState("idle");
    };

    ws.onclose = () => {
      // Only treat as error if we weren't already done.
      setPhase((p) => (p === "done" ? "done" : "error"));
    };

    return () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
      try {
        audioCtxRef.current?.close();
      } catch {
        /* ignore */
      }
      audioCtxRef.current = null;
      audioQueueRef.current = [];
      clearTtsFallbackTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── TTS playback ─────────────────────────────────────────────────
  function getAudioContext(): AudioContext {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new AudioContext();
    }
    return audioCtxRef.current;
  }

  const playNextChunk = useCallback(async () => {
    const chunk = audioQueueRef.current.shift();
    if (!chunk) {
      audioPlayingRef.current = false;
      // If TTS has fully drained AND we're past speaking, flip to listening.
      setPhase((prev) => {
        if (prev === "speaking") {
          setOrbState("listening");
          return "listening";
        }
        return prev;
      });
      return;
    }
    audioPlayingRef.current = true;
    const ctx = getAudioContext();
    try {
      const buf = await ctx.decodeAudioData(chunk.slice(0));
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.onended = () => playNextChunk();
      src.start();
    } catch (err) {
      console.warn("[Interview] TTS decode failed:", err);
      playNextChunk();
    }
  }, []);

  // ── User send ────────────────────────────────────────────────────
  const sendUserMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      setMessages((prev) => [
        ...prev,
        { role: "user", text: trimmed, ts: Date.now() },
      ]);
      setPartialUserText("");
      setPhase("thinking");
      setOrbState("thinking");
      ws.send(
        JSON.stringify({
          type: "interview_user_message",
          payload: { text: trimmed, speakReply: !textOnlyRef.current },
          timestamp: Date.now(),
        }),
      );
    },
    [],
  );

  return {
    phase,
    orbState,
    messages,
    partialUserText,
    factsRecorded,
    farewell,
    error,
    textOnly,
    sendUserMessage,
    setTextOnly,
    setPartialUserText,
  };
}
