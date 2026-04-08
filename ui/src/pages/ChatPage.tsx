import React, { useEffect } from "react";
import type { ChatMessage, ChatSendOptions } from "../hooks/useWebSocket";
import type { UseVoiceReturn, VoiceState } from "../hooks/useVoice";
import { MessageList } from "../components/chat/MessageList";
import { ChatInput } from "../components/chat/ChatInput";
import "../styles/chat.css";

type ChatPageProps = {
  messages: ChatMessage[];
  isConnected: boolean;
  sendMessage: (text: string, options?: ChatSendOptions) => void;
  voice?: UseVoiceReturn;
};

type ChatMode = "off" | "fast" | "auto";

export default function ChatPage({ messages, isConnected, sendMessage, voice }: ChatPageProps) {
  // Available LLM providers for the dropdown
  const providers = ["anthropic", "openai", "groq", "gemini", "ollama", "openrouter"];
  const models: Record<string, string[]> = {
    anthropic: ["claude-opus", "claude-sonnet-4", "claude-3-5-sonnet"],
    openai: ["gpt-4o", "gpt-4-turbo", "gpt-4"],
    groq: ["llama-3.3-70b", "mixtral-8x7b"],
    gemini: ["gemini-2-flash", "gemini-pro"],
    ollama: ["llama2", "llama3", "mistral"],
    openrouter: ["anthropic/claude-3-5-sonnet", "openai/gpt-4-turbo"],
  };

  const [chatMode, setChatMode] = React.useState<ChatMode>(() => {
    try {
      const saved = localStorage.getItem("jarvis.chatMode");
      if (saved === "fast" || saved === "auto" || saved === "off") return saved;
      return localStorage.getItem("jarvis.fastChatMode") === "true" ? "fast" : "off";
    } catch {
      return "off";
    }
  });

  const [selectedProvider, setSelectedProvider] = React.useState<string>(() => {
    try {
      return localStorage.getItem("jarvis.selectedProvider") || "";
    } catch {
      return "";
    }
  });

  const [selectedModel, setSelectedModel] = React.useState<string>(() => {
    try {
      const savedProvider = localStorage.getItem("jarvis.selectedProvider") || "";
      const savedPreset = localStorage.getItem("jarvis.selectedModelPreset");
      const legacySaved = localStorage.getItem("jarvis.selectedModel");
      const candidate = savedPreset || legacySaved || "";
      const providerModels = models[savedProvider] ?? [];
      return providerModels.includes(candidate) ? candidate : "";
    } catch {
      return "";
    }
  });

  const [customModel, setCustomModel] = React.useState<string>(() => {
    try {
      const savedProvider = localStorage.getItem("jarvis.selectedProvider") || "";
      const savedCustom = localStorage.getItem("jarvis.selectedModelCustom");
      const legacySaved = localStorage.getItem("jarvis.selectedModel");
      const candidate = savedCustom || legacySaved || "";
      const providerModels = models[savedProvider] ?? [];
      return candidate && !providerModels.includes(candidate) ? candidate : "";
    } catch {
      return "";
    }
  });

  const [llmPickerExpanded, setLlmPickerExpanded] = React.useState<boolean>(false);

  useEffect(() => {
    try {
      localStorage.setItem("jarvis.chatMode", chatMode);
    } catch {
      // ignore storage failures
    }
  }, [chatMode]);

  useEffect(() => {
    try {
      localStorage.setItem("jarvis.selectedProvider", selectedProvider);
    } catch {
      // ignore storage failures
    }
  }, [selectedProvider]);

  useEffect(() => {
    try {
      localStorage.setItem("jarvis.selectedModelPreset", selectedModel);
    } catch {
      // ignore storage failures
    }
  }, [selectedModel]);

  useEffect(() => {
    try {
      localStorage.setItem("jarvis.selectedModelCustom", customModel);
    } catch {
      // ignore storage failures
    }
  }, [customModel]);

  const voiceStatus = voice
    ? voice.voiceState === "speaking" || voice.ttsAudioPlaying
      ? "JARVIS is speaking..."
      : voice.voiceState === "processing"
        ? "Transcribing..."
        : voice.voiceState === "recording"
          ? "Listening..."
          : null
    : null;

  const chatModeLabel = chatMode === "fast" ? "Fast Chat" : chatMode === "auto" ? "Auto Chat" : "Standard Chat";
  const chatModeState = chatMode === "fast" ? "No tools" : chatMode === "auto" ? "Smart route" : "Tools on";
  const chatModeClass = chatMode === "fast"
    ? "chat-fast-toggle-fast"
    : chatMode === "auto"
      ? "chat-fast-toggle-auto"
      : "chat-fast-toggle-off";

  const cycleChatMode = () => {
    setChatMode((prev) => (prev === "off" ? "fast" : prev === "fast" ? "auto" : "off"));
  };

  const providerModels = selectedProvider ? (models[selectedProvider] ?? []) : [];
  const effectiveModel = customModel.trim() || selectedModel;
  const llmSummary = selectedProvider
    ? `${selectedProvider}${effectiveModel ? ` / ${effectiveModel}` : " / auto"}`
    : "auto";

  const handleProviderChange = (provider: string) => {
    setSelectedProvider(provider);
    if (!provider) {
      setSelectedModel("");
      setCustomModel("");
      return;
    }

    const nextModels = models[provider] ?? [];
    if (!nextModels.includes(selectedModel)) {
      setSelectedModel("");
    }
  };

  const isLikelyQuestion = (text: string) => {
    const normalized = text.trim();
    if (!normalized) return false;
    if (/[?]["')\]]*$/.test(normalized)) return true;
    return /\b(can|could|would|will|should|do|does|did|are|is|want|need|which|what|when|where|why|how)\b/i.test(normalized)
      && /\b(you|your)\b/i.test(normalized);
  };

  const prevVoiceStateRef = React.useRef<VoiceState>("idle");
  const lastAutoFollowupRef = React.useRef<string | null>(null);
  useEffect(() => {
    if (!voice) return;
    const prev = prevVoiceStateRef.current;
    if (prev === "speaking" && voice.voiceState === "idle") {
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      if (lastAssistant && isLikelyQuestion(lastAssistant.content) && lastAutoFollowupRef.current !== lastAssistant.id) {
        lastAutoFollowupRef.current = lastAssistant.id;
        // Retry in short bursts because browser mic/wake recognizer handoff can race right after TTS ends.
        const retryDelays = [120, 420, 920];
        retryDelays.forEach((delay) => {
          window.setTimeout(() => {
            if (!voice.ttsAudioPlaying && voice.voiceState === "idle") {
              voice.startRecording();
            }
          }, delay);
        });
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
        aria-label={`Chat mode: ${chatModeLabel}. Click to cycle mode.`}
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

      <div className={`chat-llm-selector ${llmPickerExpanded ? "chat-llm-selector-expanded" : ""}`}>
        <button
          type="button"
          className="chat-llm-toggle"
          onClick={() => setLlmPickerExpanded((prev) => !prev)}
          aria-expanded={llmPickerExpanded}
          title="LLM routing"
        >
          <span className="chat-llm-toggle-label">Agent</span>
          <span className="chat-llm-toggle-value">{llmSummary}</span>
          <span className="chat-llm-toggle-caret" aria-hidden="true">▾</span>
        </button>

        {llmPickerExpanded && (
          <div className="chat-llm-popover">
            <div className="llm-selector-group">
              <label htmlFor="provider-select" className="llm-selector-label">Provider</label>
              <select
                id="provider-select"
                value={selectedProvider}
                onChange={(e) => handleProviderChange(e.target.value)}
                className="llm-selector-input"
              >
                <option value="">Auto</option>
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            <div className="llm-selector-group">
              <label htmlFor="model-select" className="llm-selector-label">Preset model</label>
              <select
                id="model-select"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="llm-selector-input"
                disabled={!selectedProvider}
              >
                <option value="">Auto</option>
                {providerModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <div className="llm-selector-group llm-selector-group-wide">
              <label htmlFor="custom-model" className="llm-selector-label">Custom model</label>
              <input
                id="custom-model"
                type="text"
                className="llm-selector-input"
                placeholder="optional: provider-specific model id"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                disabled={!selectedProvider}
              />
            </div>
          </div>
        )}
      </div>

      <ChatInput
        onSend={(text) => sendMessage(text, { 
          chatMode,
          fastMode: chatMode === "fast",
          llmProvider: selectedProvider || undefined,
          llmModel: effectiveModel || undefined,
        })}
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
