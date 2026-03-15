import React from "react";
import type { SubAgentEvent } from "../../hooks/useWebSocket";

type Props = {
  event: SubAgentEvent;
};

function getClassName(type: string): string {
  switch (type) {
    case "done": return "chat-sa chat-sa-done";
    case "tool_call": return "chat-sa chat-sa-tool";
    default: return "chat-sa chat-sa-active";
  }
}

function getIcon(type: string): string {
  switch (type) {
    case "done": return "\u2713";     // checkmark
    case "tool_call": return "\u2699"; // gear
    default: return "\u25C6";          // diamond
  }
}

export function SubAgentTag({ event }: Props) {
  const label =
    event.type === "done"
      ? `${event.agentName} completed`
      : event.type === "tool_call"
        ? `${event.agentName} > ${(event.data as any)?.name ?? "tool"}`
        : event.agentName;

  return (
    <span className={getClassName(event.type)}>
      <span style={{ fontSize: "9px" }}>{getIcon(event.type)}</span>
      {label}
    </span>
  );
}
