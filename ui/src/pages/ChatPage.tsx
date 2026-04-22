import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "../hooks/useWebSocket";
import type { UseVoiceReturn } from "../hooks/useVoice";
import { MessageList } from "../components/chat/MessageList";
import { ChatInput } from "../components/chat/ChatInput";
import { useApiData } from "../hooks/useApi";
import "../styles/chat.css";

type PuterClient = {
  onAuth?: (() => void | Promise<void>) | null;
  getUser: () => Promise<unknown>;
  ui: {
    authenticateWithPuter: () => Promise<void>;
  };
  ai: {
    chat: (
      messages: Array<{ role: "user" | "assistant"; content: string }>,
      options: { model: string; stream: boolean },
    ) => Promise<unknown>;
  };
};

declare global {
  interface Window {
    puter?: PuterClient;
  }
}

type ChatPageProps = {
  messages: ChatMessage[];
  isConnected: boolean;
  sendMessage: (text: string) => void;
  voice?: UseVoiceReturn;
};

function extractPuterText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";

  const record = part as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (record.delta && typeof record.delta === "object") {
    const delta = record.delta as Record<string, unknown>;
    if (typeof delta.text === "string") return delta.text;
  }
  if (record.message && typeof record.message === "object") {
    const message = record.message as Record<string, unknown>;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      for (const entry of message.content) {
        if (entry && typeof entry === "object") {
          const text = (entry as Record<string, unknown>).text;
          if (typeof text === "string") {
            return text;
          }
        }
      }
    }
  }

  return "";
}

export default function ChatPage({ messages, isConnected, sendMessage, voice }: ChatPageProps) {
  const { data: llmConfig } = useApiData<{ anthropic: { model: string; use_puter: boolean } | null }>("/api/config/llm", []);
  const [puterMessages, setPuterMessages] = useState<ChatMessage[]>([]);
  const [puterBusy, setPuterBusy] = useState(false);
  const [puterUser, setPuterUser] = useState<string | null>(null);
  const puterRef = useRef<PuterClient | null>(null);
  const puterMode = !!llmConfig?.anthropic?.use_puter;

  const getPuter = useCallback(async () => {
    if (puterRef.current) return puterRef.current;
    if (window.puter) {
      puterRef.current = window.puter;
      return window.puter;
    }

    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-puter-sdk="true"]');
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Failed to load Puter SDK.")), { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = "https://js.puter.com/v2/";
      script.async = true;
      script.dataset.puterSdk = "true";
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", () => reject(new Error("Failed to load Puter SDK.")), { once: true });
      document.body.appendChild(script);
    });

    if (!window.puter) {
      throw new Error("Failed to load Puter SDK.");
    }

    puterRef.current = window.puter;
    return window.puter;
  }, []);

  const syncPuterUser = useCallback(async () => {
    const puter = await getPuter();
    try {
      const user = await puter.getUser();
      if (user && typeof user === "object") {
        const profile = user as Record<string, unknown>;
        setPuterUser(
          typeof profile.username === "string" ? profile.username
            : typeof profile.name === "string" ? profile.name
            : typeof profile.email === "string" ? profile.email
            : "Connected",
        );
        return true;
      }
    } catch {
      // Expected until the browser signs the user into Puter.
    }

    setPuterUser(null);
    return false;
  }, [getPuter]);

  useEffect(() => {
    if (!puterMode) return;

    let cancelled = false;
    (async () => {
      const puter = await getPuter();
      puter.onAuth = async () => {
        if (!cancelled) {
          await syncPuterUser();
        }
      };
      await syncPuterUser();
    })().catch(() => {
      if (!cancelled) {
        setPuterUser(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [getPuter, puterMode, syncPuterUser]);

  const ensurePuterAuth = useCallback(async () => {
    if (await syncPuterUser()) return;
    const puter = await getPuter();
    await puter.ui.authenticateWithPuter();
    await syncPuterUser();
  }, [getPuter, syncPuterUser]);

  const appendPuterChunk = useCallback((messageId: string, chunk: string) => {
    if (!chunk) return;
    setPuterMessages((prev) => prev.map((message) => (
      message.id === messageId
        ? { ...message, content: `${message.content}${chunk}`, isStreaming: true }
        : message
    )));
  }, []);

  const finalizePuterMessage = useCallback((messageId: string) => {
    setPuterMessages((prev) => prev.map((message) => (
      message.id === messageId
        ? { ...message, isStreaming: false }
        : message
    )));
  }, []);

  const handlePuterSend = useCallback(async (text: string) => {
    if (puterBusy) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: Date.now(),
      source: "puter",
    };
    const assistantMessageId = crypto.randomUUID();
    let historySnapshot: ChatMessage[] = [];

    setPuterMessages((prev) => {
      historySnapshot = [...prev, userMessage];
      return [
        ...historySnapshot,
        {
          id: assistantMessageId,
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          source: "puter",
          isStreaming: true,
        },
      ];
    });

    setPuterBusy(true);
    try {
      await ensurePuterAuth();
      const puter = await getPuter();
      const model = llmConfig?.anthropic?.model ?? "claude-sonnet-4-6";
      const response = await puter.ai.chat(
        historySnapshot
          .filter((message): message is ChatMessage & { role: "user" | "assistant" } => (
            message.role === "user" || message.role === "assistant"
          ))
          .map((message) => ({ role: message.role, content: message.content })),
        { model, stream: true },
      );

      if (response && typeof (response as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
        for await (const part of response as AsyncIterable<unknown>) {
          appendPuterChunk(assistantMessageId, extractPuterText(part));
        }
      } else {
        appendPuterChunk(assistantMessageId, extractPuterText(response));
      }

      finalizePuterMessage(assistantMessageId);
    } catch (err) {
      setPuterMessages((prev) => prev
        .filter((message) => message.id !== assistantMessageId)
        .concat({
          id: crypto.randomUUID(),
          role: "system",
          content: err instanceof Error ? err.message : "Puter Claude request failed.",
          timestamp: Date.now(),
          source: "error",
        }));
    } finally {
      setPuterBusy(false);
    }
  }, [appendPuterChunk, ensurePuterAuth, finalizePuterMessage, getPuter, llmConfig?.anthropic?.model, puterBusy]);

  const activeMessages = useMemo(
    () => (puterMode ? puterMessages : messages),
    [messages, puterMessages, puterMode],
  );

  const effectiveConnected = puterMode ? true : isConnected;
  const effectiveVoice = puterMode ? undefined : voice;
  const voiceStatus = voice
    ? voice.voiceState === "speaking" || voice.ttsAudioPlaying
      ? "JARVIS is speaking..."
      : voice.voiceState === "processing"
        ? "Transcribing..."
        : voice.voiceState === "recording"
          ? "Listening..."
          : null
    : null;

  return (
    <div className="chat-page">
      {/* Atmosphere — Three-layer living background */}
      <div className="chat-atmos">
        {/* Layer 1: Aurora gradients */}
        <div className="chat-atmos-aurora" />

        {/* Layer 2: Constellation dots + SVG connectors */}
        <div className="chat-atmos-constellation">
          <div className="chat-const-node drift" style={{ width: 3, height: 3, background: "rgba(139,92,246,0.15)", top: "12%", left: "18%", "--dur": "12s", "--delay": "0s" } as React.CSSProperties} />
          <div className="chat-const-node drift" style={{ width: 2, height: 2, background: "rgba(96,165,250,0.12)", top: "28%", left: "72%", "--dur": "15s", "--delay": "2s" } as React.CSSProperties} />
          <div className="chat-const-node drift" style={{ width: 2, height: 2, background: "rgba(52,211,153,0.10)", top: "65%", left: "35%", "--dur": "18s", "--delay": "4s" } as React.CSSProperties} />
          <div className="chat-const-node drift" style={{ width: 3, height: 3, background: "rgba(139,92,246,0.12)", top: "80%", left: "82%", "--dur": "14s", "--delay": "1s" } as React.CSSProperties} />
          <div className="chat-const-node" style={{ width: 2, height: 2, background: "rgba(96,165,250,0.08)", top: "45%", left: "55%" }} />

          <svg className="chat-const-svg">
            <line x1="18%" y1="12%" x2="72%" y2="28%" stroke="rgba(139,92,246,0.03)" strokeWidth="1" strokeDasharray="4 8" style={{ animation: "chat-flowPulse 4s linear infinite" }} />
            <line x1="35%" y1="65%" x2="82%" y2="80%" stroke="rgba(52,211,153,0.02)" strokeWidth="1" strokeDasharray="4 8" style={{ animation: "chat-flowPulse 5s linear infinite" }} />
          </svg>
        </div>

        {/* Layer 3: Data stream particles */}
        <div className="chat-stream-channel" style={{ left: "22%" }}>
          <div className="chat-stream-particle" style={{ background: "rgba(139,92,246,0.18)", "--dur": "8s", "--delay": "0s" } as React.CSSProperties} />
          <div className="chat-stream-particle" style={{ background: "rgba(139,92,246,0.12)", "--dur": "12s", "--delay": "3s" } as React.CSSProperties} />
        </div>
        <div className="chat-stream-channel" style={{ left: "68%" }}>
          <div className="chat-stream-particle" style={{ background: "rgba(96,165,250,0.14)", "--dur": "10s", "--delay": "1s" } as React.CSSProperties} />
          <div className="chat-stream-particle" style={{ background: "rgba(52,211,153,0.10)", "--dur": "14s", "--delay": "5s" } as React.CSSProperties} />
        </div>
        <div className="chat-stream-channel" style={{ left: "45%" }}>
          <div className="chat-stream-particle" style={{ background: "rgba(139,92,246,0.10)", "--dur": "11s", "--delay": "2s" } as React.CSSProperties} />
        </div>
      </div>

      {/* Connection status bar */}
      {!puterMode && !isConnected && (
        <div className="chat-status-bar chat-status-disconnected">
          <span className="chat-status-dot chat-status-dot-recording" />
          Disconnected from JARVIS. Reconnecting...
        </div>
      )}

      {/* Voice status bar */}
      {voiceStatus && !puterMode && (
        <div className="chat-status-bar chat-status-voice">
          <span className={`chat-status-dot ${voice?.voiceState === "recording" ? "chat-status-dot-recording" : "chat-status-dot-voice"}`} />
          {voiceStatus}
        </div>
      )}

      {puterMode && (
        <div className="chat-status-bar chat-status-voice" style={{ justifyContent: "space-between", gap: "12px" }}>
          <span>Free Version (Puter) is active. Claude replies stream directly to this page after browser sign-in.</span>
          <span style={{ color: "var(--j-text-dim)", whiteSpace: "nowrap" }}>
            {puterUser ? `Connected as ${puterUser}` : "Sign in on first message"}
          </span>
        </div>
      )}

      {/* Messages */}
      <MessageList messages={activeMessages} />

      {/* Input */}
      <ChatInput
        onSend={puterMode ? handlePuterSend : sendMessage}
        disabled={puterMode ? puterBusy : !effectiveConnected}
        voice={effectiveVoice ? {
          voiceState: effectiveVoice.voiceState,
          startRecording: effectiveVoice.startRecording,
          stopRecording: effectiveVoice.stopRecording,
          isMicAvailable: effectiveVoice.isMicAvailable,
          isWakeWordReady: effectiveVoice.isWakeWordReady,
          ttsAudioPlaying: effectiveVoice.ttsAudioPlaying,
          cancelTTS: effectiveVoice.cancelTTS,
        } : undefined}
      />
    </div>
  );
}
