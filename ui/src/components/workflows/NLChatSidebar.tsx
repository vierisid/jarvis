import React, { useState, useRef, useEffect } from "react";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export default function NLChatSidebar({
  workflowId,
  onDefinitionUpdate,
}: {
  workflowId: string;
  onDefinitionUpdate: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput("");
    const userMsg: ChatMessage = { role: "user", content: text };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      const resp = await fetch("/api/workflows/nl-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflowId,
          message: text,
          history: messages.slice(-10),
        }),
      });

      if (resp.ok) {
        const data = await resp.json();
        setMessages(prev => [...prev, { role: "assistant", content: data.reply ?? data.message ?? "Done." }]);
        if (data.updated) {
          onDefinitionUpdate();
        }
      } else {
        setMessages(prev => [...prev, { role: "assistant", content: "Sorry, something went wrong." }]);
      }
    } catch {
      setMessages(prev => [...prev, { role: "assistant", content: "Failed to connect." }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="wf-chat">
      <div className="wf-chat-header">AI Assistant</div>

      <div ref={listRef} className="wf-chat-messages">
        {messages.length === 0 && (
          <div className="wf-chat-empty">
            Describe what you want to build or modify.
            <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "4px" }}>
              {[
                "Add a step that sends an email when done",
                "Connect the HTTP node to the filter",
                "Add error handling for the API call",
              ].map(hint => (
                <button
                  key={hint}
                  className="wf-chat-hint-btn"
                  onClick={() => setInput(hint)}
                >
                  "{hint}"
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`wf-chat-msg ${msg.role}`}>
            {msg.content}
          </div>
        ))}

        {loading && (
          <div className="wf-chat-msg thinking">Thinking...</div>
        )}
      </div>

      <div className="wf-chat-input-area">
        <input
          type="text"
          className="wf-chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") sendMessage(); }}
          placeholder="Describe a change..."
        />
        <button
          className="wf-chat-send"
          onClick={sendMessage}
          disabled={loading || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
