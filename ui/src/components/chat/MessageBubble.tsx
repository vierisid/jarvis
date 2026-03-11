import React from "react";
import type { ChatMessage } from "../../hooks/useWebSocket";
import { ToolCallBadge } from "./ToolCallBadge";
import { SubAgentTag } from "./SubAgentTag";
import { MarkdownContent } from "./MarkdownContent";

type Props = {
  message: ChatMessage;
};

export function MessageBubble({ message }: Props) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  // System messages (heartbeat, proactive, errors)
  if (isSystem) {
    const isError = message.source === "error";
    const isHeartbeat = message.source === "heartbeat";
    const isUrgent = message.priority === "urgent";

    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          padding: "4px 20px",
        }}
      >
        <div
          style={{
            maxWidth: "600px",
            padding: "8px 14px",
            borderRadius: "6px",
            background: isError
              ? "rgba(239, 68, 68, 0.1)"
              : isUrgent
                ? "rgba(239, 68, 68, 0.1)"
                : "rgba(0, 212, 255, 0.05)",
            border: `1px solid ${
              isError
                ? "rgba(239, 68, 68, 0.3)"
                : isUrgent
                  ? "rgba(239, 68, 68, 0.3)"
                  : "var(--j-border)"
            }`,
            fontSize: "12px",
            color: isError
              ? "var(--j-error)"
              : isUrgent
                ? "var(--j-error)"
                : "var(--j-text-dim)",
          }}
        >
          {isHeartbeat && (
            <span style={{ color: "var(--j-accent-dim)", marginRight: "6px" }}>
              [heartbeat]
            </span>
          )}
          <MarkdownContent content={message.content} />
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        padding: "4px 20px",
      }}
    >
      <div
        style={{
          maxWidth: "75%",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
        }}
      >
        {/* Sub-agent tags */}
        {message.subAgentEvents && message.subAgentEvents.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "4px",
              paddingBottom: "2px",
            }}
          >
            {message.subAgentEvents.map((evt, i) => (
              <SubAgentTag key={i} event={evt} />
            ))}
          </div>
        )}

        {/* Main bubble */}
        <div
          style={{
            padding: "10px 14px",
            borderRadius: isUser ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
            background: isUser
              ? "rgba(0, 212, 255, 0.15)"
              : "var(--j-surface)",
            border: `1px solid ${
              isUser ? "rgba(0, 212, 255, 0.3)" : "var(--j-border)"
            }`,
            fontSize: "14px",
            lineHeight: "1.6",
            whiteSpace: isUser ? "pre-wrap" : undefined,
            wordBreak: "break-word",
            color: "var(--j-text)",
          }}
        >
          {isUser ? message.content : <MarkdownContent content={message.content} />}
          {message.isStreaming && (
            <span
              style={{
                display: "inline-block",
                width: "6px",
                height: "14px",
                background: "var(--j-accent)",
                marginLeft: "2px",
                animation: "blink 1s step-end infinite",
                verticalAlign: "text-bottom",
              }}
            />
          )}
        </div>

        {/* Tool calls */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "4px",
              paddingTop: "2px",
            }}
          >
            {message.toolCalls.map((tc, i) => (
              <ToolCallBadge key={i} toolCall={tc} />
            ))}
          </div>
        )}

        {/* Timestamp */}
        <div
          style={{
            fontSize: "10px",
            color: "var(--j-text-muted)",
            textAlign: isUser ? "right" : "left",
            paddingTop: "1px",
          }}
        >
          {new Date(message.timestamp).toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}
