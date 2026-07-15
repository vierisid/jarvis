import React, { useState, useRef, useEffect } from "react";
import { SiteFileTree } from "./SiteFileTree";
import type { ChatMessage } from "../../hooks/useWebSocket";

type Props = {
  leftTab: "chat" | "files";
  setLeftTab: (tab: "chat" | "files") => void;
  projectId: string | null;
  onFileSelect: (path: string) => void;
  sendMessage: (msg: string, options?: { projectId?: string }) => void;
  isConnected: boolean;
  messages: ChatMessage[];
};

export function SiteLeftPanel({ leftTab, setLeftTab, projectId, onFileSelect, sendMessage, isConnected, messages }: Props) {
  const [chatInput, setChatInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Filter messages for this project — show messages with matching source, plus assistant responses that follow them
  const projectMessages = React.useMemo(() => {
    if (!projectId) return [];
    const filtered: ChatMessage[] = [];
    let includeNext = false;
    for (const msg of messages) {
      if (msg.source === `site:${projectId}`) {
        filtered.push(msg);
        includeNext = true;
      } else if (includeNext && msg.role === "assistant") {
        filtered.push(msg);
        includeNext = false;
      } else {
        includeNext = false;
      }
    }
    return filtered;
  }, [messages, projectId]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [projectMessages.length]);

  const handleSend = () => {
    const text = chatInput.trim();
    if (!text || !isConnected || !projectId) return;
    sendMessage(text, { projectId });
    setChatInput("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Tab bar */}
      <div style={tabBarStyle}>
        <button
          onClick={() => setLeftTab("chat")}
          style={leftTab === "chat" ? activeTabBtnStyle : tabBtnStyle}
        >
          Chat
        </button>
        <button
          onClick={() => setLeftTab("files")}
          style={leftTab === "files" ? activeTabBtnStyle : tabBtnStyle}
        >
          Files
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {leftTab === "chat" ? (
          <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            {/* Chat messages area */}
            <div style={{ flex: 1, padding: "8px", overflow: "auto" }}>
              {!projectId ? (
                <div style={emptyStyle}>Open a project to start chatting</div>
              ) : projectMessages.length === 0 ? (
                <div style={emptyStyle}>
                  Chat with JARVIS about this project. Your messages will be scoped to the active project.
                </div>
              ) : (
                projectMessages.map((msg) => (
                  <div key={msg.id} style={{
                    marginBottom: 8,
                    padding: "6px 10px",
                    borderRadius: "6px",
                    fontSize: "12px",
                    lineHeight: 1.5,
                    background: msg.role === "user" ? "rgba(0,212,255,0.08)" : "var(--panel)",
                    color: "var(--ink)",
                    borderLeft: msg.role === "user" ? "2px solid var(--ink)" : "2px solid var(--rule)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}>
                    <div style={{ fontSize: "10px", color: "var(--ink3)", marginBottom: 2, fontWeight: 600 }}>
                      {msg.role === "user" ? "You" : "JARVIS"}
                    </div>
                    {msg.content}
                    {msg.isStreaming && <span style={{ color: "var(--ink)" }}> ▍</span>}
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Chat input */}
            <div style={{ padding: "8px", borderTop: "1px solid var(--rule)" }}>
              <div style={{ display: "flex", gap: "6px" }}>
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                  placeholder={projectId ? "Ask JARVIS to build..." : "Select a project first"}
                  disabled={!projectId || !isConnected}
                  style={inputStyle}
                />
                <button onClick={handleSend} disabled={!chatInput.trim() || !projectId} style={sendBtnStyle}>
                  Send
                </button>
              </div>
            </div>
          </div>
        ) : (
          <SiteFileTree projectId={projectId} onFileSelect={onFileSelect} />
        )}
      </div>
    </div>
  );
}

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  borderBottom: "1px solid var(--rule)",
  background: "var(--bg)",
};

const tabBtnStyle: React.CSSProperties = {
  flex: 1,
  padding: "8px",
  background: "none",
  border: "none",
  borderBottom: "2px solid transparent",
  color: "var(--ink3)",
  fontSize: "12px",
  fontWeight: 600,
  cursor: "pointer",
};

const activeTabBtnStyle: React.CSSProperties = {
  ...tabBtnStyle,
  color: "var(--ink)",
  borderBottom: "2px solid var(--ink)",
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "6px 10px",
  fontSize: "12px",
  background: "var(--panel)",
  border: "1px solid var(--rule)",
  borderRadius: "4px",
  color: "var(--ink)",
  outline: "none",
};

const sendBtnStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: "11px",
  background: "rgba(0, 212, 255, 0.15)",
  border: "1px solid rgba(0, 212, 255, 0.3)",
  borderRadius: "4px",
  color: "var(--ink)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const emptyStyle: React.CSSProperties = {
  color: "var(--ink3)",
  fontSize: "12px",
  textAlign: "center",
  padding: "20px",
};
