import { useCallback, useMemo, useState } from "react";
import {
  useWebSocket,
  type ChatMessage,
  type PendingApproval,
  type PendingClarifier,
  type PendingRepeatBack,
} from "../../hooks/useWebSocket";
import type { Impact, ObjectType, ThreadItem } from "./types";

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
/**
 * Synthetic `card` ThreadItem injected by the palette. Lives in component
 * state because the daemon doesn't yet have a "card_event" broadcast — when
 * it does (Phase 6), this falls away and cards arrive via WS like everything
 * else.
 */
type InjectedCard = Extract<ThreadItem, { kind: "card" }>;
type RoomWindowItem = Extract<ThreadItem, { kind: "room-window" }>;

import type { RoomKey } from "../router";
import { useRoomLayout, type LayoutRect } from "../rooms/useRoomLayout";

export function useLiveThread() {
  const ws = useWebSocket();
  const [injectedCards, setInjectedCards] = useState<InjectedCard[]>([]);
  const [roomWindows, setRoomWindows] = useState<RoomWindowItem[]>([]);
  const layoutStore = useRoomLayout();

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

    // Palette-injected synthetic cards (Phase 5A). `__ts` is the moment the
    // user picked the result, so they sort to the bottom of the thread as
    // intended ("previews → InlineCard first").
    const injected: (ThreadItem & { __ts: number })[] = injectedCards.map((c) => ({
      __ts: tsFromInjectedId(c.id),
      ...c,
    }));

    // Phase 6.1.5 — inline Room windows. Same insertion model as cards.
    const windows: (ThreadItem & { __ts: number })[] = roomWindows.map((w) => ({
      __ts: tsFromInjectedId(w.id),
      ...w,
    }));

    // Merge by timestamp; stable sort keeps insertion order on ties.
    const merged = [
      ...chatItems,
      ...approvalItems,
      ...clarifierItems,
      ...repeatBackItems,
      ...injected,
      ...windows,
    ].sort((a, b) => a.__ts - b.__ts);

    return merged.map(({ __ts: _ts, ...rest }) => rest as ThreadItem);
  }, [ws.messages, ws.approvals, ws.clarifiers, ws.repeatBacks, injectedCards, roomWindows]);

  /**
   * Inject a synthetic `card` ThreadItem at the bottom of the thread.
   * Used by the palette when the user picks a specific object.
   * Phase 6 will replace this with a daemon-driven `card_event` broadcast.
   */
  const injectCard = useCallback(
    (card: {
      objectType: ObjectType;
      ref: string;
      title: string;
      summary?: string;
      meta?: string;
      status?: { label: string; tone: "ok" | "warn" | "neutral" | "accent" };
    }) => {
      const now = Date.now();
      const item: InjectedCard = {
        kind: "card",
        id: `palette-${now}-${Math.random().toString(36).slice(2, 8)}`,
        objectType: card.objectType,
        ref: card.ref,
        title: card.title,
        summary: card.summary,
        meta: card.meta,
        status: card.status,
        t: formatTime(now),
      };
      setInjectedCards((prev) => [...prev, item]);
    },
    [],
  );

  /**
   * Phase 6.1.5 / 6.1.6 — open a Room as a browser-window-style card.
   * Layout (inline vs floating + rect) is restored from per-room
   * localStorage so re-opening a Room remembers where the user last placed
   * it. If the Room is already open, focus it (move to bottom of items,
   * restore from minimized) and keep its current layout instead of
   * resetting to the saved one.
   */
  const openRoomWindow = useCallback(
    (key: RoomKey) => {
      const savedLayout = layoutStore.getLayout(key);
      setRoomWindows((prev) => {
        const existing = prev.find((w) => w.roomKey === key);
        if (existing) {
          const others = prev.filter((w) => w.roomKey !== key);
          const now = Date.now();
          return [
            ...others,
            {
              ...existing,
              id: `room-${now}-${Math.random().toString(36).slice(2, 8)}`,
              state: "inline",
              layout: existing.layout,
              t: formatTime(now),
            },
          ];
        }
        const now = Date.now();
        return [
          ...prev,
          {
            kind: "room-window",
            id: `room-${now}-${Math.random().toString(36).slice(2, 8)}`,
            roomKey: key,
            state: "inline",
            layout: savedLayout,
            t: formatTime(now),
          },
        ];
      });
    },
    [layoutStore],
  );

  /**
   * Phase 6.1.6 — set a Room window's layout (inline vs floating + rect).
   * Persists to per-room localStorage so the next open restores it.
   */
  const setRoomWindowLayout = useCallback(
    (id: string, layout: { mode: "inline" } | { mode: "floating"; rect: LayoutRect }) => {
      let key: RoomKey | null = null;
      setRoomWindows((prev) =>
        prev.map((w) => {
          if (w.id !== id) return w;
          key = w.roomKey;
          return { ...w, layout };
        }),
      );
      if (key) layoutStore.setLayout(key, layout);
    },
    [layoutStore],
  );

  /**
   * Phase 6.1.6 — voice "reorder" / "tidy up": bring every floating window
   * back to inline placement and clear the persisted layouts.
   */
  const reorderAllToInline = useCallback(() => {
    setRoomWindows((prev) =>
      prev.map((w) =>
        w.layout.mode === "floating" ? { ...w, layout: { mode: "inline" as const } } : w,
      ),
    );
    layoutStore.resetAllLayouts();
  }, [layoutStore]);

  const closeRoomWindow = useCallback((id: string) => {
    setRoomWindows((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const setRoomWindowStateById = useCallback((id: string, state: "inline" | "minimized") => {
    setRoomWindows((prev) => prev.map((w) => (w.id === id ? { ...w, state } : w)));
  }, []);

  /** Close the most-recently opened inline Room window. Used by voice "close the room". */
  const closeMostRecentRoomWindow = useCallback((): boolean => {
    let closed = false;
    setRoomWindows((prev) => {
      if (prev.length === 0) return prev;
      closed = true;
      return prev.slice(0, -1);
    });
    return closed;
  }, []);

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
    /** Daemon-driven Room navigation request (voice "open workflows" etc.). */
    roomNavRequest: ws.roomNavRequest,
    /** Daemon-driven RoomWindow chrome control (voice "close", "expand", "minimize"). */
    windowControlRequest: ws.windowControlRequest,
    /** Phase 6.3.5 — daemon-driven Room action (voice "switch to orbital view" etc.). */
    roomActionRequest: ws.roomActionRequest,
    /** Exposed so the v2 shell can pass the same WS to `useVoice`. */
    wsRef: ws.wsRef,
    /** Exposed so the v2 shell can wire TTS callbacks from `useVoice`. */
    voiceCallbacksRef: ws.voiceCallbacksRef,
    /** Pending approvals (kept for components that need raw access). */
    approvals: ws.approvals,
    /** Pending clarifiers (raw — drives the notification center bell). */
    clarifiers: ws.clarifiers,
    /** Pending repeat-back confirmations (raw — drives the notification center bell). */
    repeatBacks: ws.repeatBacks,
    /** Live task lifecycle events (drives Logs Room live tail). */
    taskEvents: ws.taskEvents,
    /** Live content pipeline events (drives Content Room live tail). */
    contentEvents: ws.contentEvents,
    /** Live agent delegation events (drives Logs Room live tail). */
    agentActivity: ws.agentActivity,
    /** Phase 5A: palette pushes synthetic cards into the thread via this. */
    injectCard,
    /** Phase 6.1.5: room-window helpers. */
    openRoomWindow,
    closeRoomWindow,
    setRoomWindowStateById,
    closeMostRecentRoomWindow,
    /** Phase 6.1.6: layout helpers (floating + reorder). */
    setRoomWindowLayout,
    reorderAllToInline,
    /** Currently open room windows (read-only). */
    roomWindows,
  };
}

/** Recover the timestamp embedded in a palette-injected card id. */
function tsFromInjectedId(id: string): number {
  if (!id.startsWith("palette-")) return Date.now();
  const num = Number(id.split("-")[1]);
  return Number.isFinite(num) ? num : Date.now();
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
