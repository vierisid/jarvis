import React, { useEffect, useRef } from "react";
import type { ChatMessage } from "../../hooks/useWebSocket";
import { MessageBubble } from "./MessageBubble";

type Props = {
  messages: ChatMessage[];
};

function formatTimeDivider(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (isToday) return `Today  ${time}`;
  if (isYesterday) return `Yesterday  ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}  ${time}`;
}

function shouldShowTimeDivider(current: ChatMessage, previous: ChatMessage | undefined): boolean {
  if (!previous) return true;
  const gap = current.timestamp - previous.timestamp;
  return gap > 10 * 60 * 1000; // 10 minutes
}

export function MessageList({ messages }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="chat-empty">
        <div className="chat-empty-orb" />
        <div className="chat-empty-title">Ready to assist</div>
        <div className="chat-empty-sub">
          Type a message below to start a conversation with JARVIS.
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="chat-messages-scroll">
      <div className="chat-messages-center">
        {messages.map((msg, i) => (
          <React.Fragment key={msg.id}>
            {shouldShowTimeDivider(msg, messages[i - 1]) && (
              <div className="chat-time-divider">
                <span className="chat-time-label">{formatTimeDivider(msg.timestamp)}</span>
              </div>
            )}
            <MessageBubble message={msg} />
          </React.Fragment>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
