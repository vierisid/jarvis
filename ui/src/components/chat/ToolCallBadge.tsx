import React from "react";
import type { ToolCall } from "../../hooks/useWebSocket";

type Props = {
  toolCall: ToolCall;
};

export function ToolCallBadge({ toolCall }: Props) {
  return (
    <span className="chat-tool">
      <span style={{ fontSize: "9px", color: "var(--emerald)", opacity: 0.6 }}>&#10003;</span>
      {toolCall.name}
    </span>
  );
}
