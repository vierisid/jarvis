import { useState, useEffect, useRef, useCallback } from "react";
import { RealtimeVoiceController } from "../lib/RealtimeVoiceController";

const SPEECH_WAKE_INTERRUPT_COMMANDS = new Set([
  "stop",
  "wait",
  "pause",
  "listen",
  "quiet",
  "sorry",
  "question",
  "hold on",
  "one sec",
  "one second",
]);

function normalizeTranscript(transcript: string): string {
  return transcript
    .toLowerCase()
    .replace(/[.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getWakePrefix(normalized: string): "hey jarvis " | "jarvis " | null {
  if (normalized.startsWith("hey jarvis ")) return "hey jarvis ";
  if (normalized.startsWith("jarvis ")) return "jarvis ";
  return null;
}

/**
 * Strict matcher used during TTS playback (voiceState === "speaking").
 * Accepts bare wake phrases ("jarvis", "hey jarvis") or wake + a short
 * whitelisted interrupt command. Prevents Jarvis's own TTS from self-triggering
 * when the reply contains the word "jarvis" inside a sentence.
 */
export function matchesSpeechWakePhrase(transcript: string): boolean {
  const normalized = normalizeTranscript(transcript);
  if (!normalized) return false;
  if (normalized === "jarvis" || normalized === "hey jarvis") return true;

  const prefix = getWakePrefix(normalized);
  if (!prefix) return false;

  const remainder = normalized.slice(prefix.length).trim();
  if (!remainder) return true;

  return SPEECH_WAKE_INTERRUPT_COMMANDS.has(remainder);
}

/**
 * Loose matcher used when idle. Accepts any utterance that starts with the
 * wake phrase, so natural "hey jarvis turn off the lights" wakes in one breath
 * without waiting for Chrome to emit a bare-wake interim first.
 * NOT safe to use while Jarvis is speaking — use matchesSpeechWakePhrase there.
 */
export function matchesSpeechWakePrefix(transcript: string): boolean {
  const normalized = normalizeTranscript(transcript);
  if (!normalized) return false;
  if (normalized === "jarvis" || normalized === "hey jarvis") return true;
  return getWakePrefix(normalized) != null;
}

export type VoiceState =
  | "idle"           // listening for wake word (if enabled) or waiting for PTT
  | "wake_detected"  // brief visual feedback before recording starts
  | "recording"      // capturing mic audio
  | "processing"     // audio sent, waiting for STT + LLM
  | "speaking"       // receiving and playing TTS audio
  | "error";         // recoverable — returns to idle after timeout

/** User-facing engine choice (see server config `voice.wake_engine`). */
export type WakeEngineChoice = "openwakeword" | "webspeech" | "auto";

/** Which engine is actually running right now (reported back to UI). */
export type ActiveWakeEngine = "openwakeword" | "webspeech" | "none";

/**
 * Internal state machine for the Web Speech recognizer. Transitions are only
 * driven by real browser events (`onstart`, `onend`) — never optimistically
 * flipped on `.start()` / `.stop()` calls, which used to race on Chromium.
 */
type SpeechWakeState = "stopped" | "starting" | "running" | "stopping";

/** Minimum ms between two accepted wake matches. Prevents interim-result bursts. */
const WAKE_COOLDOWN_MS = 500;

/** After this many consecutive transient errors without a successful start, stop retrying. */
const SPEECH_WAKE_MAX_CONSECUTIVE_ERRORS = 3;

/**
 * Classify a SpeechRecognition error so the caller can decide what to do:
 *  - "expected":  normal part of the API lifecycle; ignore.
 *  - "transient": may recover; retry with existing restart logic.
 *  - "fatal":     user or environment requires manual intervention; stop.
 * Exported for unit testing.
 */
export function classifySpeechWakeError(code: SpeechRecognitionErrorCode): "expected" | "transient" | "fatal" {
  switch (code) {
    case "aborted":
    case "no-speech":
      return "expected";
    case "not-allowed":
    case "service-not-allowed":
    case "bad-grammar":
    case "language-not-supported":
      return "fatal";
    case "audio-capture":
    case "network":
      return "transient";
  }
}

/**
 * Pure decision function: which wake engine should own the mic right now?
 * Consolidates the engine-selection rules (config + SpeechRecognition
 * availability + fatal state) so the effect that drives OpenWakeWord /
 * the active-engine indicator can't drift from the test expectations.
 * Exported for unit testing.
 */
export function selectActiveWakeEngine(inputs: {
  isMicAvailable: boolean;
  wakeWordEnabled: boolean;
  wakeEngine: WakeEngineChoice;
  speechRecognitionAvailable: boolean;
  speechWakeFatal: boolean;
}): ActiveWakeEngine {
  const { isMicAvailable, wakeWordEnabled, wakeEngine, speechRecognitionAvailable, speechWakeFatal } = inputs;
  if (!isMicAvailable || !wakeWordEnabled) return "none";
  if (wakeEngine === "openwakeword") return "openwakeword";
  const speechUsable = speechRecognitionAvailable && !speechWakeFatal;
  if (wakeEngine === "webspeech") return speechUsable ? "webspeech" : "none";
  // "auto": prefer the browser recognizer when usable, fall back to local.
  return speechUsable ? "webspeech" : "openwakeword";
}

/**
 * Pure decision function: given current inputs, should the Web Speech wake
 * recognizer be running right now? Exported for unit testing.
 */
export function shouldSpeechWakeBeRunning(inputs: {
  isMicAvailable: boolean;
  wakeWordEnabled: boolean;
  voiceState: VoiceState;
  wakeEngine: WakeEngineChoice;
  speechRecognitionAvailable: boolean;
  /** True once the recognizer has hit a non-recoverable error. */
  speechWakeFatal?: boolean;
}): boolean {
  const { isMicAvailable, wakeWordEnabled, voiceState, wakeEngine, speechRecognitionAvailable, speechWakeFatal } = inputs;
  if (speechWakeFatal) return false;
  if (!isMicAvailable || !wakeWordEnabled || !speechRecognitionAvailable) return false;
  // Run in every state except active recording (which owns the mic for the
  // live transcript recognizer). Includes processing/wake_detected/speaking
  // so "Jarvis" can interrupt mid-thought, not just kick off from idle.
  if (voiceState === "recording" || voiceState === "error") return false;
  if (wakeEngine === "openwakeword") return false;
  return true; // "webspeech" or "auto" with the API available
}

/**
 * Pure decision: are we still inside the trailing-tail cooldown after a
 * containsWake speaking turn exited? Used to suppress wake-recognizer
 * restarts during the window in which trailing speaker audio could echo
 * the wake word back into the mic.
 *
 * Boundary: returns `false` exactly when `now - exitedAt === cooldownMs`
 * (strictly less than is "still inside"). Exported for unit testing.
 */
export function isWithinSpeakingTailCooldown(now: number, exitedAt: number, cooldownMs: number): boolean {
  return now - exitedAt < cooldownMs;
}

/**
 * Pure plan for what `handleTTSContainsWake` should do when invoked.
 *
 * The mid-turn `containsWake` flip is one-way (false → true only) because
 * earlier audio carrying the wake word may still be in the speaker buffer
 * when a later sentence arrives. Calling this with `currentFlag === true`
 * is a no-op.
 *
 * Critically: the very same call that flips the flag must also stamp the
 * trailing-tail cooldown. The "exit-stamp" effect inside `useVoice` only
 * registers a cleanup function when its predicate is true at setup time —
 * a flag flip via ref does not re-run the effect, so without this
 * imperative stamp, the cooldown would silently not fire on turn end.
 *
 * Exported for unit testing; this is the regression boundary for the bug
 * where a containsWake flip during a `speaking` turn left the cooldown
 * un-stamped and trailing TTS audio re-triggered wake.
 */
export interface ContainsWakeFlipPlan {
  /** Whether to perform the flip (false → true). */
  shouldFlip: boolean;
  /** Whether to stamp `speakingExitedAtRef.current = now()` immediately. */
  shouldStampCooldown: boolean;
  /** Whether to imperatively stop both wake recognizers. */
  shouldStopRecognizers: boolean;
}

export function planContainsWakeFlip(currentFlag: boolean): ContainsWakeFlipPlan {
  if (currentFlag) {
    return { shouldFlip: false, shouldStampCooldown: false, shouldStopRecognizers: false };
  }
  return { shouldFlip: true, shouldStampCooldown: true, shouldStopRecognizers: true };
}

export type UseVoiceOptions = {
  wsRef: React.MutableRefObject<WebSocket | null>;
  wakeWordEnabled?: boolean;
  /** Default "openwakeword" (local). "webspeech" uses Chromium's cloud STT. */
  wakeEngine?: WakeEngineChoice;
  /**
   * Phase 6.7.C — Optional getter for the current Room key (or null when
   * on the home thread). Included in every voice_start/voice_text payload
   * so the daemon's classifier can disambiguate utterances like "show me
   * active tasks" — chat answer when on home, room_action filter when in
   * the tasks Room. Returns the literal string "home" for the thread view.
   */
  getCurrentRoom?: () => string | null;
  /**
   * Trailing cooldown (ms) applied after a `containsWake` speaking turn
   * exits, before the wake recognizer is allowed to re-arm. Prevents
   * trailing TTS speaker audio from self-triggering. Hardware echo on
   * some headsets needs a longer tail; raise this if you see false
   * wakes immediately after a reply finishes. Default 700.
   */
  speakingTailCooldownMs?: number;
};

export type UseVoiceReturn = {
  voiceState: VoiceState;
  startRecording: () => void;
  stopRecording: () => void;
  isMicAvailable: boolean;
  isWakeWordReady: boolean;
  ttsAudioPlaying: boolean;
  cancelTTS: () => void;
  activeWakeEngine: ActiveWakeEngine;
  // Called by useWebSocket for TTS events
  handleTTSBinary: (data: ArrayBuffer) => void;
  handleTTSStart: (requestId: string, containsWake?: boolean) => void;
  /** Mid-turn flip: a later sentence in the same TTS turn contains "Jarvis". */
  handleTTSContainsWake: () => void;
  handleTTSEnd: () => void;
  handleError: (message?: string) => void;
  /** Realtime session closed server-side — stop the mic, return to idle. */
  handleRealtimeClosed: () => void;
  // v2 additions (Phase 4A)
  /** Mute the mic. While muted, wake-word is paused and `startRecording` is a no-op. */
  muted: boolean;
  setMuted: (next: boolean) => void;
  /** Mic input level 0..1, RMS-derived from the analyser. 0 when not recording. */
  micLevel: number;
  /** Live interim STT text shown under the orb during recording. Empty when not listening. */
  partialTranscript: string;
  /** Snap state to idle. For non-streaming responses (e.g. Room nav) where no tts_start arrives. */
  forceIdle: () => void;
};

export function useVoice({ wsRef, wakeWordEnabled = true, wakeEngine = "openwakeword", getCurrentRoom, speakingTailCooldownMs = 700 }: UseVoiceOptions): UseVoiceReturn {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [isMicAvailable, setIsMicAvailable] = useState(false);
  const [isWakeWordReady, setIsWakeWordReady] = useState(false);
  const [ttsAudioPlaying, setTtsAudioPlaying] = useState(false);
  const [activeWakeEngine, setActiveWakeEngine] = useState<ActiveWakeEngine>("none");
  const [speechWakeFatal, setSpeechWakeFatal] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [partialTranscript, setPartialTranscript] = useState("");
  const mutedRef = useRef(false);
  const transcriptRecognizerRef = useRef<any>(null);
  // Final transcript captured from the browser SpeechRecognition during the
  // current recording. When present, we prefer this over uploading WAV for
  // daemon Whisper because it's typically more accurate for short utterances.
  const finalBrowserTranscriptRef = useRef("");

  const recordingContextRef = useRef<AudioContext | null>(null);
  const recordingSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const recordingWorkletRef = useRef<AudioWorkletNode | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef(16000);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceCtxRef = useRef<AudioContext | null>(null);
  const silenceSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ttsQueueRef = useRef<ArrayBuffer[]>([]);
  const ttsPlayingRef = useRef(false);
  const ttsRequestIdRef = useRef<string | null>(null);
  const voiceStateRef = useRef<VoiceState>("idle");
  const wakeEngineRef = useRef<any>(null);
  const wakeWordEnabledRef = useRef(wakeWordEnabled);
  const speechWakeRef = useRef<SpeechRecognition | null>(null);
  const speechWakeStateRef = useRef<SpeechWakeState>("stopped");
  const speechWakeRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechWakeFatalRef = useRef(false);
  const speechWakeConsecutiveErrorsRef = useRef(0);
  const lastWakeAtRef = useRef(0);
  const isMicAvailableRef = useRef(false);
  const configuredWakeEngineRef = useRef<WakeEngineChoice>(wakeEngine);
  // Timestamp of the most recent transition OUT of the "speaking" state.
  // Used to apply a short cooldown before re-arming the speech wake
  // recognizer so trailing TTS audio (and any speaker reverb) doesn't
  // immediately self-trigger a wake the moment we go idle.
  const speakingExitedAtRef = useRef<number>(0);
  // Cooldown duration is held in a ref so callbacks below capture the latest
  // configured value without re-creating on every render.
  const speakingTailCooldownMsRef = useRef(speakingTailCooldownMs);
  useEffect(() => { speakingTailCooldownMsRef.current = speakingTailCooldownMs; }, [speakingTailCooldownMs]);
  // True if the in-flight TTS turn contains "Jarvis" anywhere. The
  // daemon sets this in tts_start, and may flip false→true mid-turn via
  // tts_text when a later sentence introduces the wake word. Reset on
  // tts_end / state→idle. When true, the wake recognizer is suppressed
  // for the duration of the speaking state. When false, the recognizer
  // stays running so a real human "Jarvis" can interrupt the reply.
  const ttsContainsWakeRef = useRef(false);
  const startRecordingRef = useRef<(autoStop?: boolean) => void>(() => {});
  const autoStopRef = useRef(false);
  const cancelTTSRef = useRef<() => void>(() => {});
  const forceIdleRef = useRef<() => void>(() => {});
  // Premium realtime voice (gpt-realtime-2). When enabled+keyed, recording and
  // playback take a continuous 24kHz PCM path via RealtimeVoiceController
  // instead of the push-to-talk WAV flow. Defaults off; only flips true after
  // /api/config/voice reports the realtime mode is available.
  const realtimeActiveRef = useRef(false);
  const realtimeCtrlRef = useRef<RealtimeVoiceController | null>(null);

  // Keep refs in sync with state for use inside callbacks
  useEffect(() => { voiceStateRef.current = voiceState; }, [voiceState]);
  useEffect(() => { wakeWordEnabledRef.current = wakeWordEnabled; }, [wakeWordEnabled]);
  useEffect(() => { isMicAvailableRef.current = isMicAvailable; }, [isMicAvailable]);
  useEffect(() => { configuredWakeEngineRef.current = wakeEngine; }, [wakeEngine]);
  useEffect(() => { speechWakeFatalRef.current = speechWakeFatal; }, [speechWakeFatal]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  // Reset fatal state when the user changes engine choice or toggles wake word.
  // A config change is a clear signal that the user wants us to retry.
  useEffect(() => {
    setSpeechWakeFatal(false);
    speechWakeConsecutiveErrorsRef.current = 0;
  }, [wakeEngine, wakeWordEnabled]);

  // --- AudioContext helper ---
  const getAudioContext = useCallback((): AudioContext => {
    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      audioContextRef.current = new AudioContext();
    }
    // Resume if suspended (browser autoplay policy)
    if (audioContextRef.current.state === "suspended") {
      audioContextRef.current.resume().catch(() => {});
    }
    return audioContextRef.current;
  }, []);

  // Short "I'm listening" chime played the instant the wake word fires. Gives
  // immediate feedback (so the user knows to start talking) and covers the
  // realtime session's connect/setup window. Synthesized in Web Audio — no
  // asset, no network. Two soft ascending sine notes (~150ms total).
  const playWakeChime = useCallback(() => {
    try {
      const ctx = getAudioContext();
      const t0 = ctx.currentTime;
      const notes = [
        { freq: 740, at: 0 },     // F#5
        { freq: 988, at: 0.085 }, // B5
      ];
      for (const n of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = n.freq;
        const start = t0 + n.at;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(0.1, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.14);
      }
    } catch {
      /* chime is cosmetic — never let it break the voice flow */
    }
  }, [getAudioContext]);

  // --- Premium realtime voice availability ---
  // Poll the voice config so the recording/playback path can switch to the
  // realtime streaming flow. Cheap; mirrors the settings poll cadence.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch("/api/config/voice");
        if (!res.ok) return;
        const cfg = await res.json();
        if (!cancelled) {
          realtimeActiveRef.current = Boolean(cfg?.realtime?.enabled && cfg?.realtime?.available);
        }
      } catch { /* leave previous value; default false */ }
    };
    check();
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      check();
    }, 15000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  // Tear down the realtime controller (mic + playback contexts) on unmount.
  useEffect(() => () => {
    realtimeCtrlRef.current?.dispose();
    realtimeCtrlRef.current = null;
  }, []);

  // Lazily create the realtime controller bound to the live WebSocket. State
  // transitions are driven by playback start/idle since the realtime server
  // streams audio without the tts_start/tts_end envelope.
  const getRealtimeController = useCallback((): RealtimeVoiceController | null => {
    const ws = wsRef.current;
    if (!ws) return null;
    if (!realtimeCtrlRef.current) {
      realtimeCtrlRef.current = new RealtimeVoiceController({
        ws,
        getCurrentRoom: () => getCurrentRoom?.() ?? "home",
        onPlaybackStart: () => setVoiceState("speaking"),
        onPlaybackIdle: () => {
          // Only fall to idle if we're not actively capturing the next turn.
          if (!realtimeCtrlRef.current?.isStreaming) setVoiceState("idle");
        },
        onError: (msg) => {
          console.error("[Voice] realtime error:", msg);
          setVoiceState("error");
          setTimeout(() => setVoiceState("idle"), 3000);
        },
      });
    }
    return realtimeCtrlRef.current;
  }, [wsRef, getCurrentRoom]);

  const encodeWav = useCallback((chunks: Float32Array[], sampleRate: number): ArrayBuffer => {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const pcm = new Int16Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) {
        const sample = Math.max(-1, Math.min(1, chunk[i]!));
        pcm[offset++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
    }

    const buffer = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(buffer);
    const writeString = (position: number, value: string) => {
      for (let i = 0; i < value.length; i++) {
        view.setUint8(position + i, value.charCodeAt(i));
      }
    };

    writeString(0, "RIFF");
    view.setUint32(4, 36 + pcm.length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, pcm.length * 2, true);

    for (let i = 0; i < pcm.length; i++) {
      view.setInt16(44 + i * 2, pcm[i]!, true);
    }

    return buffer;
  }, []);

  // --- Check mic availability on mount ---
  useEffect(() => {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        stream.getTracks().forEach(t => t.stop());
        setIsMicAvailable(true);
      })
      .catch(() => setIsMicAvailable(false));
  }, []);

  // --- Wake word engine ---
  const startWakeWordEngine = useCallback(async () => {
    if (wakeEngineRef.current) {
      try { await wakeEngineRef.current.start(); } catch {}
      return;
    }

    try {
      const { WakeWordEngine } = await import("openwakeword-wasm-browser");
      const engine = new WakeWordEngine({
        baseAssetUrl: "/openwakeword/models",
        ortWasmPath: "/ort/",
        keywords: ["hey_jarvis"],
        detectionThreshold: 0.3,
        cooldownMs: 2000,
        debug: true,
      });

      engine.on("detect", ({ keyword, score }: { keyword: string; score: number }) => {
        console.log(`[Voice] Wake word "${keyword}" detected (score: ${score.toFixed(2)})`);
        if (voiceStateRef.current !== "idle") return;

        // Stop wake word mic, brief visual feedback, then start recording
        engine.stop().catch(() => {});
        setVoiceState("wake_detected");
        setTimeout(() => {
          if (voiceStateRef.current === "wake_detected") {
            startRecordingRef.current(true); // autoStop: silence detection for hands-free
          }
        }, 300);
      });

      engine.on("speech-start", () => {
        console.log("[Voice] Wake word: speech detected");
      });

      engine.on("speech-end", () => {
        console.log("[Voice] Wake word: silence");
      });

      engine.on("error", (err: Error) => {
        console.error("[Voice] Wake word engine error:", err);
      });

      await engine.load();
      wakeEngineRef.current = engine;
      await engine.start();
      setIsWakeWordReady(true);
      console.log("[Voice] Wake word engine ready — say 'Hey JARVIS'");
    } catch (err) {
      console.warn("[Voice] Wake word init failed:", err);
      setIsWakeWordReady(false);
    }
  }, []);

  const stopWakeWordEngine = useCallback(async () => {
    if (wakeEngineRef.current) {
      try { await wakeEngineRef.current.stop(); } catch {}
    }
  }, []);

  const isSpeechRecognitionAvailable = useCallback((): boolean => {
    return (window.SpeechRecognition ?? window.webkitSpeechRecognition) != null;
  }, []);

  // ── Speech wake recognizer: state machine + reconcile ─────────────────
  // Transitions are only flipped on real browser events (`onstart`, `onend`).
  // The public API is startSpeechWakeIfNeeded / stopSpeechWakeIfNeeded — both
  // idempotent and safe to call from any code path.

  // Promote the speech-wake recognizer to "permanently failed" until the user
  // changes config (which resets the flag). The engine-selection effect picks
  // up the new state and handles the OWW fallback for "auto".
  const markSpeechWakeFatal = useCallback((): void => {
    speechWakeFatalRef.current = true;
    setSpeechWakeFatal(true);
    setIsWakeWordReady(false);
  }, []);

  const shouldSpeechWakeRun = useCallback((): boolean => {
    // Suppress when a containsWake speaking turn is active — TTS would
    // self-trigger via mic echo. Suppress during the trailing cooldown
    // for the same reason. Both are checked here so the onend-driven
    // restart and the reconcile path agree.
    if (voiceStateRef.current === "speaking" && ttsContainsWakeRef.current) return false;
    if (isWithinSpeakingTailCooldown(Date.now(), speakingExitedAtRef.current, speakingTailCooldownMsRef.current)) return false;
    return shouldSpeechWakeBeRunning({
      isMicAvailable: isMicAvailableRef.current,
      wakeWordEnabled: wakeWordEnabledRef.current,
      voiceState: voiceStateRef.current,
      wakeEngine: configuredWakeEngineRef.current,
      speechRecognitionAvailable: isSpeechRecognitionAvailable(),
      speechWakeFatal: speechWakeFatalRef.current,
    });
  }, [isSpeechRecognitionAvailable]);

  const startSpeechWakeIfNeeded = useCallback((): void => {
    if (speechWakeStateRef.current !== "stopped") return;

    if (!speechWakeRef.current) {
      const SpeechRecognitionCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      if (!SpeechRecognitionCtor) {
        console.warn("[Voice] SpeechRecognition fallback unavailable in this browser");
        return;
      }

      const recognition = new SpeechRecognitionCtor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onstart = () => {
        speechWakeStateRef.current = "running";
        // A successful start means any prior transient error streak is resolved.
        speechWakeConsecutiveErrorsRef.current = 0;
        setIsWakeWordReady(true);
      };

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        // Don't process wakes while we're already capturing the user
        // (recording owns the transcript recognizer). All other states
        // — including processing and wake_detected — accept wake events
        // so "Jarvis" can interrupt mid-thought.
        const sNow = voiceStateRef.current;
        if (sNow === "recording") return;
        // Realtime voice streams the mic straight to OpenAI, which owns
        // turn-taking + barge-in. This browser recognizer is only hearing the
        // realtime TTS echo through the speakers; acting on a (false) wake or
        // interrupt match here would cancelTTS → send voice_end → kill the
        // session, forcing a re-wake mid-conversation. Ignore browser-SR matches
        // during any active realtime turn. (Idle wake still works to start one.)
        if (realtimeActiveRef.current && sNow !== "idle") return;
        // During speaking with "Jarvis" in the TTS text: ignore wake
        // matches; the recognizer is hearing its own voice through the
        // speakers. The daemon flips this flag; UI honors it.
        if (sNow === "speaking" && ttsContainsWakeRef.current) return;
        // Trailing-tail guard: a short window after exiting a containsWake
        // speaking turn so trailing TTS audio can't false-trigger.
        if (isWithinSpeakingTailCooldown(Date.now(), speakingExitedAtRef.current, speakingTailCooldownMsRef.current)) return;

        // Strict matcher during speaking to keep TTS echo from self-triggering;
        // loose prefix matcher when idle so "hey jarvis <command>" wakes in one breath.
        const matcher = voiceStateRef.current === "speaking"
          ? matchesSpeechWakePhrase
          : matchesSpeechWakePrefix;

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = String(event.results[i]?.[0]?.transcript ?? "").toLowerCase().trim();
          if (!transcript) continue;
          if (!matcher(transcript)) continue;

          const now = Date.now();
          if (now - lastWakeAtRef.current < WAKE_COOLDOWN_MS) return;
          lastWakeAtRef.current = now;

          console.log(`[Voice] Speech wake phrase detected: "${transcript}"`);
          const s = voiceStateRef.current;
          if (s === "speaking") {
            cancelTTSRef.current();
          } else if (s === "processing" || s === "wake_detected") {
            // Mid-thought interrupt: drop the in-flight turn before re-arming.
            forceIdleRef.current();
          }
          setVoiceState("wake_detected");

          // Hand the mic off cleanly: wait for the recognizer's own end event
          // before calling getUserMedia so Chrome can fully release its mic stream.
          const rec = speechWakeRef.current;
          if (rec) {
            const onEnd = () => {
              rec.removeEventListener("end", onEnd);
              if (voiceStateRef.current === "wake_detected") {
                startRecordingRef.current(true);
              }
            };
            rec.addEventListener("end", onEnd);
            try {
              if (speechWakeStateRef.current !== "stopping") {
                rec.stop();
                speechWakeStateRef.current = "stopping";
              }
            } catch {
              rec.removeEventListener("end", onEnd);
              speechWakeStateRef.current = "stopped";
              if (voiceStateRef.current === "wake_detected") {
                startRecordingRef.current(true);
              }
            }
          } else {
            startRecordingRef.current(true);
          }
          return;
        }
      };

      recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        const kind = classifySpeechWakeError(event.error);
        if (kind === "expected") return; // aborted / no-speech are part of normal lifecycle

        if (kind === "transient") {
          speechWakeConsecutiveErrorsRef.current += 1;
          console.warn(`[Voice] Speech wake transient error (${speechWakeConsecutiveErrorsRef.current}/${SPEECH_WAKE_MAX_CONSECUTIVE_ERRORS}): ${event.error}`, event.message);
          if (speechWakeConsecutiveErrorsRef.current >= SPEECH_WAKE_MAX_CONSECUTIVE_ERRORS) {
            console.error(`[Voice] Speech wake disabled after ${SPEECH_WAKE_MAX_CONSECUTIVE_ERRORS} consecutive "${event.error}" errors`);
            markSpeechWakeFatal();
          }
          return; // otherwise let the existing onend-driven restart handle it
        }

        // kind === "fatal"
        console.error(`[Voice] Speech wake recognizer fatal error: ${event.error}`, event.message);
        markSpeechWakeFatal();
      };

      recognition.onend = () => {
        const wasStopping = speechWakeStateRef.current === "stopping";
        speechWakeStateRef.current = "stopped";
        if (speechWakeRestartTimerRef.current) {
          clearTimeout(speechWakeRestartTimerRef.current);
          speechWakeRestartTimerRef.current = null;
        }
        if (wasStopping) return;
        // Chrome ends continuous sessions ~every 30s; retry if we still need
        // to run. shouldSpeechWakeRun() now also checks the containsWake +
        // tail-cooldown guards added by Phase 6.8.9.
        if (!shouldSpeechWakeRun()) return;
        // After a containsWake speaking turn exits, wait out the tail
        // cooldown so trailing speaker audio can't false-trigger.
        const sinceExit = Date.now() - speakingExitedAtRef.current;
        const tailDelay = sinceExit < speakingTailCooldownMsRef.current
          ? speakingTailCooldownMsRef.current - sinceExit
          : 0;
        speechWakeRestartTimerRef.current = setTimeout(() => {
          speechWakeRestartTimerRef.current = null;
          if (!shouldSpeechWakeRun()) return;
          startSpeechWakeIfNeeded();
        }, Math.max(300, tailDelay));
      };

      speechWakeRef.current = recognition;
    }

    // shouldSpeechWakeRun() in the reconcile effect already gates the
    // containsWake / tail-cooldown / recording cases before we get here,
    // so this is just the start-of-recognizer plumbing.
    try {
      speechWakeRef.current.start();
      speechWakeStateRef.current = "starting";
      console.log("[Voice] Speech wake recognizer starting — say 'Jarvis' or 'Hey Jarvis'");
    } catch {
      // The browser throws if start() is called in an invalid state; the
      // reconcile effect will retry on the next relevant change.
    }
  }, [shouldSpeechWakeRun]);

  const stopSpeechWakeIfNeeded = useCallback((): void => {
    if (speechWakeRestartTimerRef.current) {
      clearTimeout(speechWakeRestartTimerRef.current);
      speechWakeRestartTimerRef.current = null;
    }
    const s = speechWakeStateRef.current;
    if (s === "stopped" || s === "stopping") return;
    const rec = speechWakeRef.current;
    if (!rec) {
      speechWakeStateRef.current = "stopped";
      return;
    }
    try {
      rec.stop();
      speechWakeStateRef.current = "stopping";
    } catch {
      speechWakeStateRef.current = "stopped";
    }
  }, []);

  // Engine selection effect. Picks which wake engine should own the mic based
  // on config + SpeechRecognition availability + fatal state via the pure
  // selector. Imperatively drives the OpenWakeWord side here; the speech-wake
  // recognizer is driven by the reconcile effect below. Muting forces "none";
  // a containsWake speaking turn also forces "none" because TTS playing
  // "Jarvis" through speakers would self-trigger via the mic.
  useEffect(() => {
    // Block local wake engines during a containsWake speaking turn (echo) AND
    // during ANY active realtime turn — realtime streams the mic to OpenAI and
    // owns turn-taking, so a local engine here only self-triggers on TTS echo.
    const blockedBySpeaking =
      (voiceState === "speaking" && ttsContainsWakeRef.current) ||
      (realtimeActiveRef.current && voiceState !== "idle");
    const active = (muted || blockedBySpeaking) ? "none" : selectActiveWakeEngine({
      isMicAvailable,
      wakeWordEnabled,
      wakeEngine,
      speechRecognitionAvailable: isSpeechRecognitionAvailable(),
      speechWakeFatal,
    });
    setActiveWakeEngine(active);
    if (active === "openwakeword") startWakeWordEngine();
    else stopWakeWordEngine();
  }, [muted, isMicAvailable, wakeWordEnabled, wakeEngine, voiceState, speechWakeFatal, startWakeWordEngine, stopWakeWordEngine, isSpeechRecognitionAvailable]);

  // Single reconcile effect for the Web Speech recognizer. Computes desired
  // running state from inputs and nudges the state machine toward it. Has no
  // cleanup function — transitions are idempotent and the dedicated unmount
  // effect tears the recognizer down. Gated on `blockedBySpeaking` so a
  // containsWake speaking turn doesn't echo-trigger.
  useEffect(() => {
    // Block local wake engines during a containsWake speaking turn (echo) AND
    // during ANY active realtime turn — realtime streams the mic to OpenAI and
    // owns turn-taking, so a local engine here only self-triggers on TTS echo.
    const blockedBySpeaking =
      (voiceState === "speaking" && ttsContainsWakeRef.current) ||
      (realtimeActiveRef.current && voiceState !== "idle");
    const shouldRun = !muted && !blockedBySpeaking && shouldSpeechWakeBeRunning({
      isMicAvailable,
      wakeWordEnabled,
      voiceState,
      wakeEngine,
      speechRecognitionAvailable: isSpeechRecognitionAvailable(),
      speechWakeFatal,
    });
    if (shouldRun) startSpeechWakeIfNeeded();
    else stopSpeechWakeIfNeeded();
  }, [muted, isMicAvailable, wakeWordEnabled, voiceState, wakeEngine, speechWakeFatal, startSpeechWakeIfNeeded, stopSpeechWakeIfNeeded, isSpeechRecognitionAvailable]);

  // Restart wake word listening when returning to idle (with delay for mic release)
  useEffect(() => {
    if (voiceState === "idle" && wakeWordEnabledRef.current && wakeEngineRef.current) {
      const timer = setTimeout(() => {
        if (voiceStateRef.current !== "idle") return;
        wakeEngineRef.current?.start()
          .then(() => console.log("[Voice] Wake word engine restarted"))
          .catch((err: Error) => {
            console.error("[Voice] Wake word engine restart failed:", err);
            // Retry once after a longer delay
            setTimeout(() => {
              if (voiceStateRef.current === "idle" && wakeEngineRef.current) {
                wakeEngineRef.current.start()
                  .then(() => console.log("[Voice] Wake word engine restarted (retry)"))
                  .catch((e: Error) => console.error("[Voice] Wake word restart retry failed:", e));
              }
            }, 2000);
          });
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [voiceState]);

  // Stamp the tail cooldown on exit from a containsWake speaking turn so
  // the reconcile path can hold off re-arming during trailing TTS audio.
  // We use a separate effect rather than wiring this into the reconcile
  // effect so the bookkeeping is contained.
  useEffect(() => {
    if (voiceState === "speaking" && ttsContainsWakeRef.current) {
      return () => {
        speakingExitedAtRef.current = Date.now();
      };
    }
  }, [voiceState]);


  // --- TTS Playback ---
  const playNextTTSChunk = useCallback(() => {
    const chunk = ttsQueueRef.current.shift();
    if (!chunk) {
      ttsPlayingRef.current = false;
      if (!ttsRequestIdRef.current) {
        // Server is done sending and queue is empty
        setVoiceState("idle");
        setTtsAudioPlaying(false);
      }
      return;
    }

    ttsPlayingRef.current = true;
    const ctx = getAudioContext();
    ctx.decodeAudioData(chunk.slice(0)) // slice to avoid detached buffer issues
      .then(buffer => {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.onended = () => playNextTTSChunk();
        source.start();
      })
      .catch(err => {
        console.error("[Voice] Audio decode error:", err);
        playNextTTSChunk(); // skip bad chunk, continue
      });
  }, [getAudioContext]);

  const handleTTSBinary = useCallback((data: ArrayBuffer) => {
    // Realtime output is raw PCM s16 24kHz (no WAV/MP3 header) — route to the
    // streaming player, not decodeAudioData.
    if (realtimeActiveRef.current) {
      getRealtimeController()?.enqueuePlayback(data);
      return;
    }
    ttsQueueRef.current.push(data);
    if (!ttsPlayingRef.current) {
      playNextTTSChunk();
    }
  }, [playNextTTSChunk, getRealtimeController]);

  const handleTTSStart = useCallback((requestId: string, containsWake = false) => {
    console.log("[Voice] TTS start:", requestId, containsWake ? "(contains wake)" : "");
    // Stop any lingering playback from a previous TTS session
    if (ttsPlayingRef.current || ttsQueueRef.current.length > 0) {
      audioContextRef.current?.close();
      audioContextRef.current = null;
    }
    ttsRequestIdRef.current = requestId;
    ttsContainsWakeRef.current = containsWake;
    ttsQueueRef.current = [];
    ttsPlayingRef.current = false;
    setVoiceState("speaking");
    setTtsAudioPlaying(true);
    // Pre-warm AudioContext so it's ready for binary chunks
    getAudioContext();
  }, [getAudioContext]);

  const handleTTSContainsWake = useCallback(() => {
    // The plan is computed by a pure helper so the regression boundary
    // (cooldown stamp on first flip) is unit-testable without React.
    const plan = planContainsWakeFlip(ttsContainsWakeRef.current);
    if (!plan.shouldFlip) return;
    console.log("[Voice] TTS turn now contains wake — suppressing recognizer");
    ttsContainsWakeRef.current = true;
    if (plan.shouldStampCooldown) {
      // Stamp the trailing-tail cooldown NOW. The exit-stamp effect's
      // cleanup is registered based on the predicate at setup time, so a
      // false→true flip mid-turn (writing a ref, not state) leaves no
      // cleanup registered and the timestamp would never get written on
      // exit — letting trailing TTS audio re-trigger wake. Stamping here
      // guarantees the cooldown is honored regardless of effect timing.
      speakingExitedAtRef.current = Date.now();
    }
    if (plan.shouldStopRecognizers) {
      stopSpeechWakeIfNeeded();
      if (wakeEngineRef.current) {
        wakeEngineRef.current.stop().catch(() => {});
      }
    }
  }, [stopSpeechWakeIfNeeded]);

  const handleTTSEnd = useCallback((bargeIn = false) => {
    // Realtime: tts_end is used by the server only as a barge-in signal
    // (user started speaking) — flush queued output so we stop talking over them.
    if (realtimeActiveRef.current) {
      if (bargeIn) realtimeCtrlRef.current?.flushPlayback();
      return;
    }
    ttsRequestIdRef.current = null;
    ttsContainsWakeRef.current = false;
    // If nothing is playing and queue is empty, transition now
    if (!ttsPlayingRef.current && ttsQueueRef.current.length === 0) {
      setVoiceState("idle");
      setTtsAudioPlaying(false);
    }
    // Otherwise playNextTTSChunk will transition when queue drains
  }, []);

  const cancelTTS = useCallback(() => {
    if (realtimeActiveRef.current) {
      // Realtime: "stop talking" is a local flush (barge-in), NOT a session
      // teardown. Keep the mic streaming so the conversation continues — calling
      // stopStreaming here was sending voice_end and killing the session.
      realtimeCtrlRef.current?.flushPlayback();
      return;
    }
    ttsQueueRef.current = [];
    ttsPlayingRef.current = false;
    ttsRequestIdRef.current = null;
    ttsContainsWakeRef.current = false;
    // Close and recreate AudioContext to stop current playback
    audioContextRef.current?.close();
    audioContextRef.current = null;
    setVoiceState("idle");
    setTtsAudioPlaying(false);
  }, []);

  useEffect(() => {
    cancelTTSRef.current = cancelTTS;
  }, [cancelTTS]);

  // Server ended the realtime session (max_session_minutes timeout or a
  // server-side close). The session keeps the mic streaming for fast multi-turn
  // while it's alive; once it's gone we must stop, or the browser keeps a hot
  // mic streaming PCM into a session that no longer exists (the server silently
  // drops it). Distinct from handleError: a normal close returns to idle with
  // no error flash.
  const handleRealtimeClosed = useCallback(() => {
    if (!realtimeActiveRef.current) return;
    realtimeCtrlRef.current?.stopStreaming();
    realtimeCtrlRef.current?.flushPlayback();
    setVoiceState("idle");
  }, []);

  const handleError = useCallback(() => {
    if (realtimeActiveRef.current && realtimeCtrlRef.current) {
      realtimeCtrlRef.current.stopStreaming();
      realtimeCtrlRef.current.flushPlayback();
    }
    ttsQueueRef.current = [];
    ttsPlayingRef.current = false;
    ttsRequestIdRef.current = null;
    audioContextRef.current?.close();
    audioContextRef.current = null;
    setTtsAudioPlaying(false);
    setVoiceState("error");
    setTimeout(() => setVoiceState("idle"), 3000);
  }, []);

  // Safety timeout: processing → idle if TTS never arrives
  useEffect(() => {
    if (voiceState === "processing") {
      const timeout = setTimeout(() => {
        if (voiceStateRef.current === "processing") {
          console.warn("[Voice] Processing timeout (30s) — returning to idle");
          setVoiceState("idle");
        }
      }, 30000);
      return () => clearTimeout(timeout);
    }
  }, [voiceState]);

  // Safety timeout: speaking → idle if TTS end signal is lost
  useEffect(() => {
    if (voiceState === "speaking") {
      const timeout = setTimeout(() => {
        if (voiceStateRef.current === "speaking") {
          console.warn("[Voice] Speaking timeout (60s) — returning to idle");
          cancelTTS();
        }
      }, 60000);
      return () => clearTimeout(timeout);
    }
  }, [voiceState, cancelTTS]);

  // --- Send audio to server ---
  // If the browser SpeechRecognition produced a final transcript during the
  // recording, prefer it: send `voice_text` (skipping daemon Whisper) because
  // the browser STT is typically more accurate for short utterances and
  // matches what the user saw under the orb. Otherwise fall back to uploading
  // the WAV audio for daemon-side STT.
  const sendAudioToServer = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pcmChunksRef.current = [];
      finalBrowserTranscriptRef.current = "";
      return;
    }

    const browserText = finalBrowserTranscriptRef.current.trim();
    finalBrowserTranscriptRef.current = "";

    // Phase 6.7.C — include the user's current Room (or "home") so the
    // daemon's classifier can disambiguate utterances that read both as
    // chat questions and as room actions ("show me active tasks").
    const currentRoom = getCurrentRoom?.() ?? "home";

    if (browserText) {
      const requestId = crypto.randomUUID();
      ws.send(JSON.stringify({
        type: "voice_text",
        payload: { requestId, text: browserText, currentRoom },
        timestamp: Date.now(),
      }));
      pcmChunksRef.current = [];
      setVoiceState("processing");
      return;
    }

    if (pcmChunksRef.current.length === 0) {
      // Nothing to send — return to idle so we don't get stuck on processing.
      setVoiceState("idle");
      return;
    }

    const requestId = crypto.randomUUID();
    const wavBuffer = encodeWav(pcmChunksRef.current, sampleRateRef.current);

    // Signal start
    ws.send(JSON.stringify({
      type: "voice_start",
      payload: { requestId, currentRoom },
      timestamp: Date.now(),
    }));

    ws.send(wavBuffer);
    ws.send(JSON.stringify({
      type: "voice_end",
      payload: { requestId },
      timestamp: Date.now(),
    }));

    pcmChunksRef.current = [];
    setVoiceState("processing");
  }, [encodeWav, wsRef, getCurrentRoom]);

  // --- Stop recording ---
  const stopRecordingInternal = useCallback(() => {
    // Realtime path: stop streaming the mic (session stays open server-side).
    // Output may still arrive; playback callbacks drive the state to idle.
    if (realtimeActiveRef.current && realtimeCtrlRef.current?.isStreaming) {
      realtimeCtrlRef.current.stopStreaming();
      setVoiceState("processing");
      return;
    }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    recordingWorkletRef.current?.disconnect();
    recordingWorkletRef.current = null;
    recordingSourceRef.current?.disconnect();
    recordingSourceRef.current = null;
    recordingContextRef.current?.close().catch(() => {});
    recordingContextRef.current = null;
    // Disconnect and close silence detection audio graph
    silenceSourceRef.current?.disconnect();
    silenceSourceRef.current = null;
    analyserRef.current = null;
    silenceCtxRef.current?.close().catch(() => {});
    silenceCtxRef.current = null;
    if (silenceCheckRef.current) {
      clearInterval(silenceCheckRef.current);
      silenceCheckRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    sendAudioToServer();
  }, [sendAudioToServer]);

  // --- Start recording ---
  // autoStop: true = silence detection enabled (wake word mode), false = PTT (user controls stop)
  const startRecordingInternal = useCallback(async (autoStop = false) => {
    if (voiceStateRef.current === "recording") return;
    autoStopRef.current = autoStop;

    // Premium realtime path: stream continuous 24kHz PCM instead of buffering
    // a WAV. No client-side silence auto-stop — the server's VAD handles
    // turn-taking; the user ends the turn via stopRecording.
    if (realtimeActiveRef.current) {
      const ctrl = getRealtimeController();
      if (ctrl) {
        // Instant audible "I'm listening" — fires before the (brief) capture +
        // session setup, so the user knows to start talking and the opening
        // words (now buffered) land cleanly.
        playWakeChime();
        await ctrl.startStreaming();
        setVoiceState("recording");
        return;
      }
      // No controller (no WS) — fall through to the standard path.
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      pcmChunksRef.current = [];

      // Silence detection with speech gate: only start silence countdown
      // AFTER the user has spoken at least once (prevents premature stop)
      // Uses a separate AudioContext so it doesn't conflict with TTS or wake word mic
      if (autoStop) {
        const silenceCtx = new AudioContext();
        silenceCtxRef.current = silenceCtx;
        const source = silenceCtx.createMediaStreamSource(stream);
        silenceSourceRef.current = source;
        const analyser = silenceCtx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        analyserRef.current = analyser;

        let hasSpoken = false;

        silenceCheckRef.current = setInterval(() => {
          if (!analyserRef.current) return;
          const data = new Uint8Array(analyserRef.current.frequencyBinCount);
          analyserRef.current.getByteFrequencyData(data);
          const avg = data.reduce((a, b) => a + b, 0) / data.length;

          if (avg >= 15) {
            // Speech detected
            hasSpoken = true;
            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
              silenceTimerRef.current = null;
            }
          } else if (hasSpoken) {
            // Silence after speech — start countdown
            if (!silenceTimerRef.current) {
              silenceTimerRef.current = setTimeout(() => {
                stopRecordingInternal();
              }, 1500);
            }
          }
        }, 100);
      }

      const recordingContext = new AudioContext({ sampleRate: 16000 });
      recordingContextRef.current = recordingContext;
      sampleRateRef.current = recordingContext.sampleRate;

      await recordingContext.audioWorklet.addModule('/audio/pcm-capture-processor.js');
      const recordingSource = recordingContext.createMediaStreamSource(stream);
      recordingSourceRef.current = recordingSource;
      const workletNode = new AudioWorkletNode(recordingContext, 'pcm-capture-processor');
      recordingWorkletRef.current = workletNode;

      workletNode.port.onmessage = (event) => {
        pcmChunksRef.current.push(new Float32Array(event.data));
      };

      recordingSource.connect(workletNode);
      setVoiceState("recording");
    } catch (err) {
      console.error("[Voice] Mic access error:", err);
      setVoiceState("error");
      setTimeout(() => setVoiceState("idle"), 3000);
    }
  }, [stopRecordingInternal, sendAudioToServer, getRealtimeController, playWakeChime]);

  // Keep recording ref in sync for wake word callback
  useEffect(() => { startRecordingRef.current = startRecordingInternal; }, [startRecordingInternal]);

  // --- Public API ---
  const startRecording = useCallback(() => {
    if (mutedRef.current) return;
    if (voiceStateRef.current !== "idle" && voiceStateRef.current !== "wake_detected") return;
    // Stop wake word mic before starting our recording
    if (wakeEngineRef.current) {
      wakeEngineRef.current.stop().catch(() => {});
    }
    startRecordingInternal(true); // autoStop on silence for both click and wake word
  }, [startRecordingInternal]);

  const stopRecording = useCallback(() => {
    if (voiceStateRef.current !== "recording") return;
    stopRecordingInternal();
  }, [stopRecordingInternal]);

  /**
   * Snap the voice state back to idle, regardless of where it currently is.
   * Used when a non-streaming server response (e.g. Room navigation that
   * intercepts the chat path) means no `tts_start` will ever arrive to clear
   * the `processing` state via the normal lifecycle. Without this, the orb
   * stays in `thinking` until the 30s safety timeout fires.
   */
  const forceIdle = useCallback(() => {
    // Realtime: the session is independent of UI navigation/room actions. The
    // shell calls forceIdle on navigate/room/orb events; tearing the session
    // down here sent a spurious voice_end and killed conversations mid-sentence.
    // No-op in realtime — the session drives its own state.
    if (realtimeActiveRef.current) return;
    // Drain any in-flight TTS just in case
    ttsQueueRef.current = [];
    ttsPlayingRef.current = false;
    ttsRequestIdRef.current = null;
    setTtsAudioPlaying(false);
    setVoiceState("idle");
  }, []);

  useEffect(() => {
    forceIdleRef.current = forceIdle;
  }, [forceIdle]);

  // --- Mute toggle (Phase 4A) ---
  const setMuted = useCallback((next: boolean) => {
    setMutedState(next);
    if (next) {
      // Hard-stop anything in flight when muting.
      if (voiceStateRef.current === "recording") {
        stopRecordingInternal();
      }
      cancelTTSRef.current();
      setPartialTranscript("");
      setMicLevel(0);
    }
  }, [stopRecordingInternal]);

  // --- Live partial transcript (Phase 4A) ---
  // Runs a separate SpeechRecognition during `recording` state purely for
  // visual feedback under the orb. The daemon-side STT remains authoritative
  // for what lands in the thread; this is read-only echo.
  useEffect(() => {
    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) return;

    if (voiceState === "recording" && !mutedRef.current) {
      // Reset captured transcript at the start of each recording.
      finalBrowserTranscriptRef.current = "";
      try {
        const rec = new SpeechRecognitionCtor();
        rec.continuous = true;
        rec.interimResults = true;
        rec.lang = "en-US";
        rec.onresult = (event: any) => {
          // Build the full interim string (for the visual transcript) and
          // capture finals into the ref so stopRecording can use them as
          // the upload payload.
          let interim = "";
          let finalsAdded = "";
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            const text = String(result?.[0]?.transcript ?? "");
            if (!text) continue;
            if (result?.isFinal) {
              finalsAdded += (finalsAdded ? " " : "") + text.trim();
            } else {
              interim += text;
            }
          }
          if (finalsAdded) {
            finalBrowserTranscriptRef.current = (
              finalBrowserTranscriptRef.current
                ? finalBrowserTranscriptRef.current + " " + finalsAdded
                : finalsAdded
            ).trim();
          }
          const display = (finalBrowserTranscriptRef.current + " " + interim).trim();
          setPartialTranscript(display);
        };
        rec.onerror = () => {/* ignore — display path only */};
        rec.onend = () => {/* will be re-created on next recording */};
        transcriptRecognizerRef.current = rec;
        try { rec.start(); } catch {/* race with another recognizer */}
      } catch {/* ignore */}
    }

    return () => {
      const rec = transcriptRecognizerRef.current;
      if (rec) {
        try { rec.stop(); } catch {/* ignore */}
        transcriptRecognizerRef.current = null;
      }
      // Drop the partial when leaving recording — the final transcript will
      // appear in the thread shortly via the chat broadcast.
      setPartialTranscript("");
    };
  }, [voiceState]);

  // --- Mic level meter (Phase 4A) ---
  // Reuses the silence-detection analyser when present, otherwise zero.
  // Sampled at 60ms — fast enough to feel live, light enough not to thrash React.
  useEffect(() => {
    if (voiceState !== "recording") {
      setMicLevel(0);
      return;
    }
    const interval = setInterval(() => {
      const analyser = analyserRef.current;
      if (!analyser) return;
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      // Average magnitude → 0..1 (data is 0..255). Apply mild curve for
      // visual responsiveness; faint speech still nudges the meter.
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += (data[i] ?? 0);
      const avg = sum / data.length / 255;
      setMicLevel(Math.min(1, Math.max(0, Math.pow(avg, 0.7))));
    }, 60);
    return () => clearInterval(interval);
  }, [voiceState]);

  // --- Cleanup on unmount ---
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop());
      if (silenceCheckRef.current) clearInterval(silenceCheckRef.current);
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceSourceRef.current?.disconnect();
      silenceCtxRef.current?.close().catch(() => {});
      audioContextRef.current?.close();
      recordingWorkletRef.current?.disconnect();
      recordingSourceRef.current?.disconnect();
      recordingContextRef.current?.close().catch(() => {});
      if (wakeEngineRef.current) {
        wakeEngineRef.current.stop().catch(() => {});
        wakeEngineRef.current = null;
      }
      stopSpeechWakeIfNeeded();
    };
  }, [stopSpeechWakeIfNeeded]);

  return {
    voiceState,
    startRecording,
    stopRecording,
    isMicAvailable,
    isWakeWordReady,
    ttsAudioPlaying,
    cancelTTS,
    activeWakeEngine,
    handleTTSBinary,
    handleTTSStart,
    handleTTSContainsWake,
    handleTTSEnd,
    handleError,
    handleRealtimeClosed,
    muted,
    setMuted,
    micLevel,
    partialTranscript,
    forceIdle,
  };
}
