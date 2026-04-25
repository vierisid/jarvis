import { useCallback, useMemo } from "react";
import {
  useWebSocket,
  type ChatMessage,
  type PendingApproval,
  type PendingClarifier,
  type PendingRepeatBack,
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

    const clarifierItems: (ThreadItem & { __ts: number })[] = ws.clarifiers.map(
      (c: PendingClarifier) => ({
        __ts: c.timestamp,
        kind: "clarifier",
        id: c.id,
        transcript: c.transcript,
        primary: c.primary,
        alternatives: c.alternatives,
        confidence: c.confidence,
        t: formatTime(c.timestamp),
      }),
    );

    const repeatBackItems: (ThreadItem & { __ts: number })[] = ws.repeatBacks.map(
      (r: PendingRepeatBack) => ({
        __ts: r.timestamp,
        kind: "repeat-back",
        id: r.id,
        transcript: r.transcript,
        confidence: r.confidence,
        t: formatTime(r.timestamp),
      }),
    );

    // Merge by timestamp; stable sort keeps insertion order on ties.
    const merged = [...chatItems, ...approvalItems, ...clarifierItems, ...repeatBackItems].sort(
      (a, b) => a.__ts - b.__ts,
    );

    return merged.map(({ __ts: _ts, ...rest }) => rest as ThreadItem);
  }, [ws.messages, ws.approvals, ws.clarifiers, ws.repeatBacks]);

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

  const resolveClarifier = useCallback(async (id: string, decision: "confirm" | "cancel") => {
    const resp = await fetch(
      `/api/voice/clarifier/${encodeURIComponent(id)}/${decision}`,
      { method: "POST" },
    );
    if (!resp.ok) throw new Error(`clarifier ${decision} failed: ${resp.status}`);
  }, []);

  const resolveRepeatBack = useCallback(async (id: string, decision: "confirm" | "cancel") => {
    const resp = await fetch(
      `/api/voice/repeat-back/${encodeURIComponent(id)}/${decision}`,
      { method: "POST" },
    );
    if (!resp.ok) throw new Error(`repeat-back ${decision} failed: ${resp.status}`);
  }, []);

  return {
    items,
    isConnected: ws.isConnected,
    send: ws.sendMessage,
    notices: ws.notices,
    dismissNotice: ws.dismissNotice,
    approve,
    cancel,
    resolveClarifier,
    resolveRepeatBack,
    /** Daemon-emitted thinking flag (between STT-final and stream/tts start). */
    thinking: ws.thinking,
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
