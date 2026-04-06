import React, { useEffect, useState } from "react";
import type { ChatMessage } from "../hooks/useWebSocket";
import type { UseVoiceReturn, VoiceState } from "../hooks/useVoice";
import { MessageList } from "../components/chat/MessageList";
import { ChatInput } from "../components/chat/ChatInput";
import "../styles/chat.css";

type ChatPageProps = {
  messages: ChatMessage[];
  isConnected: boolean;
  sendMessage: (text: string, opts?: { fastMode?: boolean }) => void;
  voice?: UseVoiceReturn;
};

type ChatMode = "off" | "fast" | "auto";

export default function ChatPage({ messages, isConnected, sendMessage, voice }: ChatPageProps) {
  const [chatMode, setChatMode] = useState<ChatMode>(() => {
    try {
      const saved = localStorage.getItem("jarvis.chatMode");
      if (saved === "fast" || saved === "auto" || saved === "off") return saved;
      return localStorage.getItem("jarvis.fastChatMode") === "true" ? "fast" : "off";
    } catch {
      return "off";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("jarvis.chatMode", chatMode);
    } catch {
      // ignore storage failures
    }
  }, [chatMode]);

  const voiceStatus = voice
    ? voice.voiceState === "speaking" || voice.ttsAudioPlaying
      ? "JARVIS is speaking..."
      : voice.voiceState === "processing"
        ? "Transcribing..."
        : voice.voiceState === "recording"
          ? "Listening..."
          : null
    : null;

  const chatModeLabel = chatMode === "fast" ? "Fast Chat" : chatMode === "auto" ? "Auto Chat" : "Chat";
  const chatModeState = chatMode === "fast" ? "No tools" : chatMode === "auto" ? "Tools on" : "Off";
  const chatModeClass = chatMode === "fast"
    ? "chat-fast-toggle-fast"
    : chatMode === "auto"
      ? "chat-fast-toggle-auto"
      : "chat-fast-toggle-off";

  const cycleChatMode = () => {
    setChatMode((prev) => (prev === "off" ? "fast" : prev === "fast" ? "auto" : "off"));
  };

  const prevVoiceStateRef = React.useRef<VoiceState>("idle");
  useEffect(() => {
    if (!voice) return;
    const prev = prevVoiceStateRef.current;
    if (prev === "speaking" && voice.voiceState === "idle") {
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      if (lastAssistant?.content.trim().endsWith("?")) {
        voice.startRecording();
      }
    }
    prevVoiceStateRef.current = voice.voiceState;
  }, [voice, messages]);

  return (
    <div className="chat-page">
      <div className="chat-atmos">
        <div className="chat-atmos-aurora" />

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

      {!isConnected && (
        <div className="chat-status-bar chat-status-disconnected">
          <span className="chat-status-dot chat-status-dot-recording" />
          Disconnected from JARVIS. Reconnecting...
        </div>
      )}

      {voiceStatus && (
        <div className="chat-status-bar chat-status-voice">
          <span className={`chat-status-dot ${voice?.voiceState === "recording" ? "chat-status-dot-recording" : "chat-status-dot-voice"}`} />
          {voiceStatus}
        </div>
      )}

      <MessageList messages={messages} />

      <button
        className={`chat-fast-toggle ${chatMode !== "off" ? "chat-fast-toggle-active" : ""} ${chatModeClass}`}
        type="button"
        role="switch"
        aria-checked={chatMode !== "off"}
        onClick={cycleChatMode}
        title={`${chatModeLabel} mode`}
      >
        <span className="chat-fast-toggle-labels">
          <span className="chat-fast-toggle-title">{chatModeLabel}</span>
          <span className="chat-fast-toggle-state">{chatModeState}</span>
        </span>
        <span className="chat-fast-toggle-switch" aria-hidden="true">
          <span className="chat-fast-toggle-thumb" />
        </span>
      </button>

      <ChatInput
        onSend={(text) => sendMessage(text, { fastMode: chatMode === "fast" })}
        disabled={!isConnected}
        fastMode={chatMode === "fast"}
        voice={voice ? {
          voiceState: voice.voiceState,
          startRecording: voice.startRecording,
          stopRecording: voice.stopRecording,
          isMicAvailable: voice.isMicAvailable,
          isWakeWordReady: voice.isWakeWordReady,
          ttsAudioPlaying: voice.ttsAudioPlaying,
          cancelTTS: voice.cancelTTS,
        } : undefined}
      />
    </div>
  );
}
