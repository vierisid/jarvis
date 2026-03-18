import { useState, useEffect, useRef, useCallback } from "react";

export type VoiceState =
  | "idle"           // listening for wake word (if enabled) or waiting for PTT
  | "wake_detected"  // brief visual feedback before recording starts
  | "recording"      // capturing mic audio
  | "processing"     // audio sent, waiting for STT + LLM
  | "speaking"       // receiving and playing TTS audio
  | "error";         // recoverable — returns to idle after timeout

export type UseVoiceOptions = {
  wsRef: React.MutableRefObject<WebSocket | null>;
  wakeWordEnabled?: boolean;
};

export type UseVoiceReturn = {
  voiceState: VoiceState;
  startRecording: () => void;
  stopRecording: () => void;
  isMicAvailable: boolean;
  isWakeWordReady: boolean;
  ttsAudioPlaying: boolean;
  cancelTTS: () => void;
  // Called by useWebSocket for TTS events
  handleTTSBinary: (data: ArrayBuffer) => void;
  handleTTSStart: (requestId: string) => void;
  handleTTSEnd: () => void;
  handleError: (message?: string) => void;
};

export function useVoice({ wsRef, wakeWordEnabled = true }: UseVoiceOptions): UseVoiceReturn {
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [isMicAvailable, setIsMicAvailable] = useState(false);
  const [isWakeWordReady, setIsWakeWordReady] = useState(false);
  const [ttsAudioPlaying, setTtsAudioPlaying] = useState(false);

  const recordingContextRef = useRef<AudioContext | null>(null);
  const recordingSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const recordingProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const recordingMuteRef = useRef<GainNode | null>(null);
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
  const startRecordingRef = useRef<(autoStop?: boolean) => void>(() => {});
  const autoStopRef = useRef(false);

  // Keep refs in sync with state for use inside callbacks
  useEffect(() => { voiceStateRef.current = voiceState; }, [voiceState]);
  useEffect(() => { wakeWordEnabledRef.current = wakeWordEnabled; }, [wakeWordEnabled]);

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

  // Initialize wake word engine when mic available and enabled
  useEffect(() => {
    if (isMicAvailable && wakeWordEnabled) {
      startWakeWordEngine();
    }
    return () => { stopWakeWordEngine(); };
  }, [isMicAvailable, wakeWordEnabled, startWakeWordEngine, stopWakeWordEngine]);

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
    recordingProcessorRef.current?.disconnect();
    recordingProcessorRef.current = null;
    recordingSourceRef.current?.disconnect();
    recordingSourceRef.current = null;
    recordingMuteRef.current?.disconnect();
    recordingMuteRef.current = null;
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
      const recordingSource = recordingContext.createMediaStreamSource(stream);
      recordingSourceRef.current = recordingSource;
      const processor = recordingContext.createScriptProcessor(4096, 1, 1);
      recordingProcessorRef.current = processor;
      const mute = recordingContext.createGain();
      mute.gain.value = 0;
      recordingMuteRef.current = mute;

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        pcmChunksRef.current.push(new Float32Array(input));
      };

      recordingSource.connect(processor);
      processor.connect(mute);
      mute.connect(recordingContext.destination);
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
      recordingProcessorRef.current?.disconnect();
      recordingSourceRef.current?.disconnect();
      recordingMuteRef.current?.disconnect();
      recordingContextRef.current?.close().catch(() => {});
      if (wakeEngineRef.current) {
        wakeEngineRef.current.stop().catch(() => {});
        wakeEngineRef.current = null;
      }
    };
  }, []);

  return {
    voiceState,
    startRecording,
    stopRecording,
    isMicAvailable,
    isWakeWordReady,
    ttsAudioPlaying,
    cancelTTS,
    handleTTSBinary,
    handleTTSStart,
    handleTTSEnd,
    handleError,
  };
}
