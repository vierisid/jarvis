import { useMemo } from "react";
import { useWebSocket, type ChatMessage } from "../../hooks/useWebSocket";
import type { ThreadItem } from "./types";

/**
 * useLiveThread — Phase 3B-1 adapter.
 *
 * Wraps the existing `useWebSocket` hook and transforms its flat
 * `ChatMessage[]` into the v2 `ThreadItem[]` union. No daemon changes
 * required — this uses only events that are already broadcast today:
 *
 *   - user-voice / user-text  ← role="user" (source="voice" → voice)
 *   - jarvis-speech           ← role="assistant" (status from isStreaming)
 *   - result                  ← role="system"  (errors, sidecar notices, workflow)
 *
 * The richer kinds (approval, card, jarvis-thought) arrive in Phase 3B-2
 * once the daemon emits the extra fields.
 */
export function useLiveThread() {
  const ws = useWebSocket();

  const items = useMemo<ThreadItem[]>(
    () => ws.messages.map(messageToThreadItem).filter((x): x is ThreadItem => x !== null),
    [ws.messages],
  );

  return {
    items,
    isConnected: ws.isConnected,
    send: ws.sendMessage,
    notices: ws.notices,
    dismissNotice: ws.dismissNotice,
  };
}

function messageToThreadItem(msg: ChatMessage): ThreadItem | null {
  const t = formatTime(msg.timestamp);

  if (msg.role === "user") {
    if (msg.source === "voice") {
      return { kind: "user-voice", id: msg.id, text: msg.content, t };
    }
    return { kind: "user-text", id: msg.id, text: msg.content, t };
  }

  if (msg.role === "assistant") {
    return {
      kind: "jarvis-speech",
      id: msg.id,
      text: msg.content,
      t,
      status: msg.isStreaming ? "speaking" : "done",
    };
  }

  // role === "system" — surface as a result bubble in the thread.
  // Empty system messages are dropped to avoid visual noise.
  if (msg.role === "system") {
    const trimmed = msg.content?.trim();
    if (!trimmed) return null;
    return {
      kind: "result",
      id: msg.id,
      summary: trimmed,
      t,
    };
  }

  return null;
}

function formatTime(ts: number): string {
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
