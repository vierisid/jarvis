import React, { useState, useRef, useEffect } from "react";
import type { VoiceState } from "../../hooks/useVoice";

type VoiceProps = {
  voiceState: VoiceState;
  startRecording: () => void;
  stopRecording: () => void;
  isMicAvailable: boolean;
  isWakeWordReady: boolean;
  ttsAudioPlaying: boolean;
  cancelTTS: () => void;
};

type Props = {
  onSend: (text: string) => void;
  disabled?: boolean;
  fastMode?: boolean;
  voice?: VoiceProps;
};

export function ChatInput({ onSend, disabled, fastMode, voice }: Props) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 150) + "px";
    }
  };

  const getMicTitle = () => {
    if (!voice) return "";
    if (voice.ttsAudioPlaying) return "Stop speaking";
    if (voice.voiceState === "recording") return "Click to send";
    if (voice.isWakeWordReady) return 'Say "Hey JARVIS" or click to speak';
    return "Click to speak";
  };

  const getMicIcon = () => {
    if (!voice) return "";
    if (voice.ttsAudioPlaying) return "\u23F9"; // stop
    if (voice.voiceState === "recording") return "\u25CF"; // filled circle
    if (voice.voiceState === "processing") return "\u23F3"; // hourglass
    return "\uD83C\uDFA4"; // microphone
  };

  const getMicClass = () => {
    if (!voice) return "chat-mic-btn";
    if (voice.voiceState === "recording") return "chat-mic-btn chat-mic-btn-recording";
    if (voice.ttsAudioPlaying) return "chat-mic-btn chat-mic-btn-speaking";
    return "chat-mic-btn";
  };

  const handleMicClick = () => {
    if (!voice) return;
    if (voice.ttsAudioPlaying) {
      voice.cancelTTS();
      return;
    }
    if (voice.voiceState === "recording") {
      voice.stopRecording();
    } else if (voice.voiceState === "idle" || voice.voiceState === "wake_detected") {
      voice.startRecording();
    }
  };

  return (
    <div className="chat-input-area">
      <div className="chat-input-row">
        <textarea
          ref={textareaRef}
          className="chat-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder={fastMode ? "Fast chat mode: direct answer, no tools..." : "Type a message..."}
          disabled={disabled}
          rows={1}
        />

        {/* Mic button */}
        {voice?.isMicAvailable && (
          <button
            className={getMicClass()}
            onClick={handleMicClick}
            title={getMicTitle()}
            disabled={voice.voiceState === "processing"}
          >
            {getMicIcon()}
          </button>
        )}

        {/* Send button */}
        <button
          className="chat-send-btn"
          onClick={handleSubmit}
          disabled={!text.trim() || disabled}
          title="Send message"
        >
          &#x2191;
        </button>
      </div>
      <div className="chat-hints">
        {fastMode ? "Fast Chat on" : "Agent mode on"} &middot; Enter to send &middot; Shift+Enter for new line
      </div>
    </div>
  );
}
