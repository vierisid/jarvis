import { useState, useEffect, useRef, useCallback } from "react";

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
  if (voiceState !== "idle" && voiceState !== "speaking") return false;
  if (wakeEngine === "openwakeword") return false;
  return true; // "webspeech" or "auto" with the API available
}

export type UseVoiceOptions = {
  wsRef: React.MutableRefObject<WebSocket | null>;
  wakeWordEnabled?: boolean;
  /** Default "openwakeword" (local). "webspeech" uses Chromium's cloud STT. */
  wakeEngine?: WakeEngineChoice;
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
  handleTTSStart: (requestId: string) => void;
  handleTTSEnd: () => void;
  handleError: (message?: string) => void;
};

export function useVoice({ wsRef, wakeWordEnabled = true, wakeEngine = "openwakeword" }: UseVoiceOptions): UseVoiceReturn {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [isMicAvailable, setIsMicAvailable] = useState(false);
  const [isWakeWordReady, setIsWakeWordReady] = useState(false);
  const [ttsAudioPlaying, setTtsAudioPlaying] = useState(false);
  const [activeWakeEngine, setActiveWakeEngine] = useState<ActiveWakeEngine>("none");
  const [speechWakeFatal, setSpeechWakeFatal] = useState(false);

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
  const startRecordingRef = useRef<(autoStop?: boolean) => void>(() => {});
  const autoStopRef = useRef(false);
  const cancelTTSRef = useRef<() => void>(() => {});

  // Keep refs in sync with state for use inside callbacks
  useEffect(() => { voiceStateRef.current = voiceState; }, [voiceState]);
  useEffect(() => { wakeWordEnabledRef.current = wakeWordEnabled; }, [wakeWordEnabled]);
  useEffect(() => { isMicAvailableRef.current = isMicAvailable; }, [isMicAvailable]);
  useEffect(() => { configuredWakeEngineRef.current = wakeEngine; }, [wakeEngine]);
  useEffect(() => { speechWakeFatalRef.current = speechWakeFatal; }, [speechWakeFatal]);

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
        if (voiceStateRef.current === "recording" || voiceStateRef.current === "processing") return;

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
          if (voiceStateRef.current === "speaking") cancelTTSRef.current();
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
        // Chrome ends continuous sessions ~every 30s; retry if we still need to run.
        if (!shouldSpeechWakeRun()) return;
        speechWakeRestartTimerRef.current = setTimeout(() => {
          speechWakeRestartTimerRef.current = null;
          startSpeechWakeIfNeeded();
        }, 300);
      };

      speechWakeRef.current = recognition;
    }

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
  // recognizer is driven by the reconcile effect below.
  useEffect(() => {
    const active = selectActiveWakeEngine({
      isMicAvailable,
      wakeWordEnabled,
      wakeEngine,
      speechRecognitionAvailable: isSpeechRecognitionAvailable(),
      speechWakeFatal,
    });
    setActiveWakeEngine(active);
    if (active === "openwakeword") startWakeWordEngine();
    else stopWakeWordEngine();
  }, [isMicAvailable, wakeWordEnabled, wakeEngine, speechWakeFatal, startWakeWordEngine, stopWakeWordEngine, isSpeechRecognitionAvailable]);

  // Single reconcile effect for the Web Speech recognizer. Computes desired
  // running state from inputs and nudges the state machine toward it. Has no
  // cleanup function — transitions are idempotent and the dedicated unmount
  // effect tears the recognizer down.
  useEffect(() => {
    const shouldRun = shouldSpeechWakeBeRunning({
      isMicAvailable,
      wakeWordEnabled,
      voiceState,
      wakeEngine,
      speechRecognitionAvailable: isSpeechRecognitionAvailable(),
      speechWakeFatal,
    });
    if (shouldRun) startSpeechWakeIfNeeded();
    else stopSpeechWakeIfNeeded();
  }, [isMicAvailable, wakeWordEnabled, voiceState, wakeEngine, speechWakeFatal, startSpeechWakeIfNeeded, stopSpeechWakeIfNeeded, isSpeechRecognitionAvailable]);

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
    ttsQueueRef.current.push(data);
    if (!ttsPlayingRef.current) {
      playNextTTSChunk();
    }
  }, [playNextTTSChunk]);

  const handleTTSStart = useCallback((requestId: string) => {
    console.log("[Voice] TTS start:", requestId);
    // Stop any lingering playback from a previous TTS session
    if (ttsPlayingRef.current || ttsQueueRef.current.length > 0) {
      audioContextRef.current?.close();
      audioContextRef.current = null;
    }
    ttsRequestIdRef.current = requestId;
    ttsQueueRef.current = [];
    ttsPlayingRef.current = false;
    setVoiceState("speaking");
    setTtsAudioPlaying(true);
    // Pre-warm AudioContext so it's ready for binary chunks
    getAudioContext();
  }, [getAudioContext]);

  const handleTTSEnd = useCallback(() => {
    ttsRequestIdRef.current = null;
    // If nothing is playing and queue is empty, transition now
    if (!ttsPlayingRef.current && ttsQueueRef.current.length === 0) {
      setVoiceState("idle");
      setTtsAudioPlaying(false);
    }
    // Otherwise playNextTTSChunk will transition when queue drains
  }, []);

  const cancelTTS = useCallback(() => {
    ttsQueueRef.current = [];
    ttsPlayingRef.current = false;
    ttsRequestIdRef.current = null;
    // Close and recreate AudioContext to stop current playback
    audioContextRef.current?.close();
    audioContextRef.current = null;
    setVoiceState("idle");
    setTtsAudioPlaying(false);
  }, []);

  useEffect(() => {
    cancelTTSRef.current = cancelTTS;
  }, [cancelTTS]);

  const handleError = useCallback(() => {
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
  const sendAudioToServer = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (pcmChunksRef.current.length === 0) return;

    const requestId = crypto.randomUUID();
    const wavBuffer = encodeWav(pcmChunksRef.current, sampleRateRef.current);

    // Signal start
    ws.send(JSON.stringify({
      type: "voice_start",
      payload: { requestId },
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
  }, [encodeWav, wsRef]);

  // --- Stop recording ---
  const stopRecordingInternal = useCallback(() => {
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
  }, [stopRecordingInternal, sendAudioToServer]);

  // Keep recording ref in sync for wake word callback
  useEffect(() => { startRecordingRef.current = startRecordingInternal; }, [startRecordingInternal]);

  // --- Public API ---
  const startRecording = useCallback(() => {
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
    handleTTSEnd,
    handleError,
  };
}
