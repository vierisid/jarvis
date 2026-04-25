import { useCallback, useMemo } from "react";
import {
  useWebSocket,
  type ChatMessage,
  type PendingApproval,
} from "../../hooks/useWebSocket";
import type { Impact, ThreadItem } from "./types";

/**
 * useLiveThread — Phase 3B adapter.
 *
 * Wraps `useWebSocket` and merges its streams into the v2 `ThreadItem[]`:
 *
 *   - user-voice / user-text  ← role="user" messages
 *   - jarvis-speech           ← role="assistant" (status from isStreaming)
 *   - result                  ← role="system"
 *   - approval                ← notification.source="approval_request"
 *                               (3B-2: includes daemon-computed impact + intent)
 *
 * Approvals are merged chronologically with chat messages so they land
 * at the right spot in the conversation. `approve()` / `cancel()` POST
 * to `/api/authority/approvals/:id/approve|deny`.
 */
export function useLiveThread() {
  const ws = useWebSocket();

  const items = useMemo<ThreadItem[]>(() => {
    const chatItems = ws.messages
      .map(messageToThreadItem)
      .filter((x): x is ThreadItem & { __ts: number } => x !== null);

    const approvalItems: (ThreadItem & { __ts: number })[] = ws.approvals.map(
      (a) => ({
        __ts: a.timestamp,
        kind: "approval",
        id: a.id,
        intent: a.intent,
        category: a.category,
        impact: a.impact as Impact,
        t: formatTime(a.timestamp),
      }),
    );

    // Merge by timestamp; stable sort keeps insertion order on ties.
    const merged = [...chatItems, ...approvalItems].sort(
      (a, b) => a.__ts - b.__ts,
    );

    return merged.map(({ __ts: _ts, ...rest }) => rest as ThreadItem);
  }, [ws.messages, ws.approvals]);

  const approve = useCallback(async (id: string) => {
    const resp = await fetch(`/api/authority/approvals/${encodeURIComponent(id)}/approve`, {
      method: "POST",
    });
    if (!resp.ok) {
      throw new Error(`approve failed: ${resp.status}`);
    }
  }, []);

  const cancel = useCallback(async (id: string) => {
    const resp = await fetch(`/api/authority/approvals/${encodeURIComponent(id)}/deny`, {
      method: "POST",
    });
    if (!resp.ok) {
      throw new Error(`deny failed: ${resp.status}`);
    }
  }, []);

  return {
    items,
    isConnected: ws.isConnected,
    send: ws.sendMessage,
    notices: ws.notices,
    dismissNotice: ws.dismissNotice,
    approve,
    cancel,
    /** Exposed so the v2 shell can pass the same WS to `useVoice`. */
    wsRef: ws.wsRef,
    /** Exposed so the v2 shell can wire TTS callbacks from `useVoice`. */
    voiceCallbacksRef: ws.voiceCallbacksRef,
    /** Pending approvals (kept for components that need raw access). */
    approvals: ws.approvals,
  };
}

function messageToThreadItem(msg: ChatMessage): (ThreadItem & { __ts: number }) | null {
  const t = formatTime(msg.timestamp);

  if (msg.role === "user") {
    if (msg.source === "voice") {
      return { __ts: msg.timestamp, kind: "user-voice", id: msg.id, text: msg.content, t };
    }
    return { __ts: msg.timestamp, kind: "user-text", id: msg.id, text: msg.content, t };
  }

  if (msg.role === "assistant") {
    return {
      __ts: msg.timestamp,
      kind: "jarvis-speech",
      id: msg.id,
      text: msg.content,
      t,
      status: msg.isStreaming ? "speaking" : "done",
    };
  }

  if (msg.role === "system") {
    const trimmed = msg.content?.trim();
    if (!trimmed) return null;
    return {
      __ts: msg.timestamp,
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

// Re-export for callers that want to build their own ThreadItem view.
export type { PendingApproval };
