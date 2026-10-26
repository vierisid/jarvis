import { useState, useEffect, useRef, useCallback } from "react";
import { uuid } from "../lib/uuid";
import { isPresentationRoomAction } from "../../../src/daemon/room-actions";
import { ROOM_ACTION_QUEUE_TTL_MS, roomActionExpiry } from "../../../src/daemon/room-action-results";
import { isUserFailure, type UserFailure } from "../v2/ui/FailureNotice";

export type MessageRole = "user" | "assistant" | "system";

export type ToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};

export type SubAgentEvent = {
  type: "text" | "tool_call" | "done";
  agentName: string;
  agentId: string;
  data: unknown;
};

export type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  subAgentEvents?: SubAgentEvent[];
  source?: string; // 'heartbeat', 'proactive', 'sub-agent'
  priority?: string;
  isStreaming?: boolean;
  detail?: string; // raw error/debug payload, rendered collapsed in the chat
  /** Q-19: a failed turn, as the daemon projected it. Rendered as is, never re-classified. */
  failure?: UserFailure;
};

/** Socket events seen while one pending-approvals read is in flight (#1087). */
export type ApprovalRehydrateWindow = { added: Set<string>; settled: Set<string> };

/**
 * Fold a pending-approvals read into the live list. The server answer replaces
 * cards that predate the read (they may have been settled while the socket was
 * down), but it was taken at some instant inside the window, so it cannot drop a
 * card the socket added after that instant or bring back one the socket settled.
 */
export function mergeRehydratedApprovals(
  server: PendingApproval[],
  live: PendingApproval[],
  seen: ApprovalRehydrateWindow,
): PendingApproval[] {
  const merged = server.filter((a) => !seen.settled.has(a.id));
  const known = new Set(merged.map((a) => a.id));
  for (const a of live) {
    if (seen.added.has(a.id) && !seen.settled.has(a.id) && !known.has(a.id)) {
      merged.push(a);
      known.add(a.id);
    }
  }
  return merged;
}

/** The card for an approval_request, or for an approval_update that still says pending. */
export function pendingApprovalFrom(payload: unknown, timestamp: number): PendingApproval | null {
  const p = payload as {
    request?: {
      id: string;
      agent_name: string;
      tool_name: string;
      action_category: string;
      urgency: "urgent" | "normal";
      reason: string;
    };
    shortId?: string;
    impact?: ApprovalImpact;
    intent?: string;
    intent_action?: string;
    intent_reason?: string;
  };
  if (!p.request?.id) return null;
  return {
    id: p.request.id,
    shortId: p.shortId ?? p.request.id.slice(0, 8),
    ...approvalSentence(p.intent_action, p.intent_reason, p.intent ?? p.request.reason ?? p.request.tool_name),
    category: p.request.action_category,
    impact: p.impact ?? "write",
    agentName: p.request.agent_name,
    toolName: p.request.tool_name,
    urgency: p.request.urgency,
    reason: p.request.reason,
    timestamp,
  };
}

/**
 * Merge vault history into whatever already landed in the chat list.
 *
 * `ws.onopen` awaits the history fetch, but `ws.onmessage` keeps firing during
 * that await — a turn that completes inside the fetch window appends its
 * message first. Replacing the list would drop that message; skipping the
 * restore because the list is "not empty" would drop the entire conversation.
 * So restored history goes first and only the live messages it does not
 * already account for are kept after it.
 *
 * Vault rows carry their own ids, so the live copy of a persisted message
 * never matches by id — role + text is the only usable identity here. Matches
 * are consumed one-for-one so a genuinely repeated answer keeps both copies.
 */
export function mergeRestoredHistory(
  restored: ChatMessage[],
  live: ChatMessage[],
): ChatMessage[] {
  if (live.length === 0) return restored;

  const key = (message: ChatMessage) => `${message.role}\u0000${message.content.trim()}`;
  const available = new Map<string, number>();
  for (const message of restored) {
    const messageKey = key(message);
    available.set(messageKey, (available.get(messageKey) ?? 0) + 1);
  }

  const unmatched = live.filter((message) => {
    const messageKey = key(message);
    const remaining = available.get(messageKey) ?? 0;
    if (remaining === 0) return true;
    available.set(messageKey, remaining - 1);
    return false;
  });

  return [...restored, ...unmatched];
}

export function finalizeStreamMessage(
  messages: ChatMessage[],
  options: {
    id: string;
    fullText?: string;
    timestamp: number;
    toolCalls: ToolCall[];
    subAgentEvents: SubAgentEvent[];
  },
): ChatMessage[] {
  const index = messages.findIndex((message) => message.id === options.id);
  if (index < 0) {
    if (!options.fullText) return messages;
    return [...messages, {
      id: options.id,
      role: "assistant",
      content: options.fullText,
      timestamp: options.timestamp,
      isStreaming: false,
      ...(options.toolCalls.length ? { toolCalls: options.toolCalls } : {}),
      ...(options.subAgentEvents.length ? { subAgentEvents: options.subAgentEvents } : {}),
    }];
  }

  return messages.map((message, messageIndex) => messageIndex === index
    ? {
        ...message,
        content: options.fullText || message.content,
        isStreaming: false,
        toolCalls: options.toolCalls.length ? options.toolCalls : message.toolCalls,
        subAgentEvents: options.subAgentEvents.length ? options.subAgentEvents : message.subAgentEvents,
      }
    : message);
}

/**
 * Next value of the local stream buffer for an incoming text chunk.
 *
 * Chunks are broadcast to every dashboard, so a client that opens, reloads, or
 * reconnects mid-turn starts with an empty buffer and would render the answer
 * with its opening cut off. The relay stamps every chunk with `accumulated` —
 * its own running total for the request, already including this chunk — so the
 * first chunk a late client sees carries everything it missed. Prefer it and
 * the answer is whole from the first render instead of staying truncated until
 * the terminal frame repairs it.
 *
 * Falls back to local accumulation when `accumulated` is absent, so a daemon
 * that predates the field still streams correctly.
 */
export function nextStreamBuffer(
  buffer: string,
  payload: { text?: string; accumulated?: unknown },
): string {
  if (typeof payload.accumulated === "string") return payload.accumulated;
  return buffer + (payload.text ?? "");
}

export type TaskEvent = {
  action: "created" | "updated" | "deleted";
  task: {
    id: string;
    what: string;
    when_due: number | null;
    context: string | null;
    priority: string;
    status: string;
    assigned_to: string | null;
    created_from: string | null;
    created_at: number;
    completed_at: number | null;
    result: string | null;
    sort_order: number;
  };
  timestamp: number;
};

export type ContentEvent = {
  action: "created" | "updated" | "deleted";
  item: {
    id: string;
    title: string;
    body: string;
    content_type: string;
    stage: string;
    tags: string[];
    scheduled_at: number | null;
    published_at: number | null;
    published_url: string | null;
    created_by: string;
    sort_order: number;
    created_at: number;
    updated_at: number;
  };
  timestamp: number;
};

export type WSMessage = {
  type: string;
  payload: any;
  id?: string;
  priority?: string;
  timestamp: number;
};

export type AgentActivityEvent = {
  id: string;
  agentName: string;
  agentId: string;
  eventType: "text" | "tool_call" | "done";
  data: unknown;
  timestamp: number;
};

/**
 * Daemon broadcast after DB-backed settings were hot-applied (per-section
 * save, POST /api/config/reload, or SIGHUP). Carries section names and
 * error strings only — never setting values.
 */
export type SettingsAppliedEvent = {
  sections: string[];
  ok: boolean;
  errors?: { section: string; error: string }[];
  timestamp: number;
};

export type VoiceCallbacks = {
  onTTSBinary: (data: ArrayBuffer) => void;
  /** `containsWake` — true if the TTS sentence about to play contains
   *  "Jarvis". UI uses it to suppress the wake-word recognizer for the
   *  duration of the playback so TTS doesn't self-trigger via mic echo.
   *  `containsStop` — the sentence contains a spoken stop phrase
   *  ("Jarvis, stop"), so the UI must also suppress its stop-phrase
   *  bypass or the echo cancels the playback. */
  onTTSStart: (requestId: string, containsWake: boolean, containsStop?: boolean) => void;
  /** Mid-turn flip: a later sentence in the same turn contains "Jarvis"
   *  (and possibly a stop phrase). */
  onTTSContainsWake?: (containsStop?: boolean) => void;
  /** `bargeIn` — realtime voice sends tts_end{bargeIn:true} when the user
   *  starts speaking, so the player can flush queued output immediately. */
  onTTSEnd: (requestId?: string, bargeIn?: boolean) => void;
  /**
   * `requestId` is set when the error ended a turn this tab did not send as
   * text (another tab's, or a voice turn): the voice hook reacts only to its own.
   */
  onError: (message?: string, requestId?: string) => void;
  /** Realtime session ended server-side (max_session_minutes timeout or
   *  server close). The client must stop the mic — it's otherwise streaming
   *  into a session that no longer exists. */
  onRealtimeClosed?: (reason?: string) => void;
  /** Realtime session failed (`realtime_status` error). Falls back to
   *  `onError` when absent. */
  onRealtimeError?: (message?: string) => void;
  /** The socket dropped; nothing the daemon had in flight on it will finish. */
  onDisconnect?: () => void;
};

/**
 * Route a realtime_status frame to the voice hook. An error goes to the
 * realtime handler when there is one: the generic onError also serves chat and
 * STT failures, and one of those must not be what ends a live realtime session.
 */
export function dispatchRealtimeStatus(
  payload: { state?: string; reason?: string; message?: string } | undefined,
  callbacks: VoiceCallbacks | null | undefined,
): void {
  if (payload?.state === "error") {
    if (callbacks?.onRealtimeError) callbacks.onRealtimeError(payload.message);
    else callbacks?.onError(payload.message);
  } else if (payload?.state === "closed") {
    // Server tore the session down (timeout/close/refusal): stop the hot mic.
    callbacks?.onRealtimeClosed?.(payload.reason);
  }
}

export type WorkflowEvent = {
  type: string;
  workflowId: string;
  executionId?: string;
  nodeId?: string;
  data: Record<string, unknown>;
  timestamp: number;
};

export type GoalEvent = {
  eventId?: string;
  sequence?: number;
  type: string;
  goalId?: string;
  data: Record<string, unknown>;
  timestamp: number;
};

export type SiteEvent = {
  type: string;
  projectId: string;
  data: Record<string, unknown>;
  timestamp: number;
};

export type SystemNotice = {
  id: string;
  title: string;
  text: string;
  level: "warning";
};

export type ApprovalImpact = "read" | "write" | "destructive" | "external";

export type PendingApproval = {
  id: string;
  shortId: string;
  /** What will happen: the card's headline. */
  intent: string;
  /** Why approval was needed, shown in its own element (#792); "" when none. */
  intentReason: string;
  category: string;
  impact: ApprovalImpact;
  agentName: string;
  toolName: string;
  urgency: "urgent" | "normal";
  reason: string;
  timestamp: number;
};

/**
 * The sentence and the reason apart (#792). A daemon that sends
 * `intent_action` sends `intent_reason` beside it; one that predates them
 * sends only the joined `intent`, which is then shown whole as before.
 */
export function approvalSentence(action: string | undefined, reason: string | undefined, joined: string): { intent: string; intentReason: string } {
  return typeof action === "string" && action ? { intent: action, intentReason: reason ?? "" } : { intent: joined, intentReason: "" };
}

export type VoiceIntentLite = {
  label: string;
  verb: string;
  impact: ApprovalImpact;
};

export type PendingClarifier = {
  id: string;
  transcript: string;
  primary: VoiceIntentLite;
  alternatives: VoiceIntentLite[];
  confidence: number;
  timestamp: number;
};

export type PendingRepeatBack = {
  id: string;
  transcript: string;
  confidence: number;
  timestamp: number;
  /**
   * Set when the daemon held a room action for the person to confirm (#973):
   * what confirming runs, as the classifier read it.
   */
  action?: string;
};

type SidecarEventPayload = {
  source?: string;
  event?: {
    type?: string;
    reason?: string;
  };
};

function createSidecarNotice(payload: SidecarEventPayload, timestamp?: number): ChatMessage & { notice?: SystemNotice } {
  const reason = payload.event?.reason?.trim();
  const notice: SystemNotice = {
    id: uuid(),
    title: "Sidecar offline",
    text: reason
      ? `Jarvis sidecar disconnected: ${reason}. Dashboard features may be delayed until it reconnects.`
      : "Jarvis sidecar disconnected. Dashboard features may be delayed until it reconnects.",
    level: "warning",
  };

  return {
    id: uuid(),
    role: "system",
    content: notice.text,
    timestamp: timestamp ?? Date.now(),
    source: "system_notification",
    notice,
  };
}

export function extractNestedMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
  if (record.error && typeof record.error === "object") {
    return extractNestedMessage(record.error);
  }
  return null;
}

export type ProviderErrorFormatted = {
  summary: string;
  detail: string;
};

/**
 * Mirror of `IMPACT_MAP` from `src/roles/authority.ts`. Used only during the
 * REST rehydration path where the server response doesn't carry impact.
 * If you change the daemon mapping, change this too.
 */
function deriveImpactFromCategory(category: string): ApprovalImpact {
  switch (category) {
    case "read_data":
      return "read";
    case "write_data":
    case "send_message":
    case "spawn_agent":
    case "control_app":
      return "write";
    case "access_browser":
    case "send_email":
      return "external";
    case "execute_command":
    case "install_software":
    case "make_payment":
    case "modify_settings":
    case "delete_data":
    case "terminate_agent":
      return "destructive";
    default:
      return "write";
  }
}

/**
 * Canonical error codes emitted by the server. Keep in sync with
 * `LLMErrorCode` in src/llm/provider.ts.
 */
export type ProviderErrorCode =
  | "auth"
  | "forbidden"
  | "rate_limit"
  | "network"
  | "bad_request"
  | "not_found"
  | "server"
  | "quota_exhausted"
  | "content_policy"
  | "restricted"
  | "unsupported_tools"
  | "setup_required"
  | "unknown";

/** The structured `forbidden` code's copy. */
const FORBIDDEN_SUMMARY =
  "Your AI provider accepted the API key but won't allow this model. Check that your plan or organization has access to it, or pick a different model.";

function summaryForCode(code: ProviderErrorCode | undefined): string | null {
  switch (code) {
    case "auth":
      return "Couldn't reach your AI provider. Check your API key and model settings.";
    case "forbidden":
      return FORBIDDEN_SUMMARY;
    case "rate_limit":
      return "Your AI provider is rate-limiting requests. Wait a moment, or check your usage and billing.";
    case "network":
      return "Couldn't reach your AI provider right now. Check your connection, provider status, or fallback settings.";
    case "bad_request":
      return "The AI provider rejected the request. The model or parameters may be invalid.";
    case "not_found":
      return "The AI provider couldn't find the requested resource. Check your model settings.";
    case "server":
      return "The AI provider had a server error. Try again in a moment.";
    // Hosted outcomes a retry cannot change; the detail carries the specifics
    // (the resume time, where to appeal).
    case "quota_exhausted":
      return "Your included AI usage is used up for this window. It resumes automatically.";
    case "content_policy":
      return "This request was blocked by the Usejarvis AI content policy.";
    case "restricted":
      return "Usejarvis AI is restricted on this account. The details say how to appeal.";
    case "unsupported_tools":
      return "The selected model can't use tools. Pick a model that supports tools.";
    case "setup_required":
      return "Finish first-run setup before chatting with Jarvis.";
    default:
      return null;
  }
}

export function formatProviderErrorMessage(
  raw: string | undefined,
  code?: ProviderErrorCode,
): ProviderErrorFormatted {
  const fallbackSummary = "Your request failed. The details say what went wrong.";
  if (!raw && !code) return { summary: fallbackSummary, detail: "" };

  const original = (raw ?? "").trim();
  let normalized = original;
  try {
    const parsed = JSON.parse(normalized) as unknown;
    normalized = extractNestedMessage(parsed) ?? normalized;
  } catch {
    const jsonMatch = normalized.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as unknown;
        normalized = extractNestedMessage(parsed) ?? normalized;
      } catch {
        // Keep the original string when embedded JSON is malformed.
      }
    }
  }

  // The server-supplied structured code decides the summary (Q-19): the
  // emission site knows the HTTP status and error type. The wording is never
  // read for a category; without a code the message is only shown as detail.
  const codeSummary = summaryForCode(code);
  return { summary: codeSummary ?? fallbackSummary, detail: normalized };
}

/**
 * Q-19: how an error frame lands in this tab. A turn's error is broadcast to
 * every tab, which all mirror the thread, so every tab shows it; only the tab
 * that asked reacts. `voiceRequestId` is passed to the voice hook when the
 * turn was not a text turn this tab sent (the voice hook knows its own voice
 * turns). `endsTurn`: whether it ends the turn this tab is in or following.
 * An error with no request id was sent to this socket alone.
 */
export function routeErrorFrame(
  frame: { id?: string | null; requestId?: unknown },
  tab: { sentAsText: (id: string) => boolean; followingTurn: string | null },
): { askedHere: boolean; voiceRequestId: string | undefined; endsTurn: boolean } {
  const requestId = String(frame.requestId ?? frame.id ?? "");
  const askedHere = frame.id != null && tab.sentAsText(frame.id);
  const notSentHere = requestId !== "" && !askedHere;
  return { askedHere, voiceRequestId: notSentHere ? requestId : undefined,
    endsTurn: !notSentHere || requestId === tab.followingTurn };
}

/** The thread message for an error frame: the daemon's failure when it sent one, never re-classified here. */
export function errorFrameContent(
  payload: { message?: unknown; code?: unknown; failure?: unknown } | undefined,
  askedHere: boolean,
): { content: string; detail?: string; failure?: UserFailure } {
  if (isUserFailure(payload?.failure)) return { content: payload.failure.headline, failure: payload.failure };
  const rawMessage = typeof payload?.message === "string" ? payload.message : undefined;
  if (askedHere) {
    const formatted = formatProviderErrorMessage(rawMessage, typeof payload?.code === "string" ? payload.code as ProviderErrorCode : undefined);
    return { content: formatted.summary,
      ...(formatted.detail && formatted.detail !== formatted.summary ? { detail: formatted.detail } : {}) };
  }
  // Other errors (protocol, config, STT) are already human-readable.
  return { content: rawMessage?.trim() ? rawMessage : "An unexpected error occurred." };
}

/** Optional scoped chat owner. The connection and non-chat notifications stay shared. */
export interface WebSocketChatAdapter {
  onOpen(socket: WebSocket): void;
  onClose(): void;
  onMessage(message: WSMessage): boolean;
}

/** Read-only hints share the socket without consuming chat/voice frames or opening another one. */
export interface WebSocketObserver {
  onOpen(): void;
  onClose(): void;
  onMessage(message: WSMessage): void;
}
function notifyObserver(observer: WebSocketObserver | undefined, event: 'onOpen' | 'onClose'): void;
function notifyObserver(observer: WebSocketObserver | undefined, event: 'onMessage', message: WSMessage): void;
function notifyObserver(observer: WebSocketObserver | undefined, event: keyof WebSocketObserver, message?: WSMessage) {
  try { if (event === 'onMessage') observer?.onMessage(message!); else observer?.[event](); }
  catch { /* An optional projection cannot interrupt chat or voice delivery. */ }
}

export function useWebSocket({ enabled = true, chat, observer }: { enabled?: boolean; chat?: WebSocketChatAdapter; observer?: WebSocketObserver } = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [taskEvents, setTaskEvents] = useState<TaskEvent[]>([]);
  const [contentEvents, setContentEvents] = useState<ContentEvent[]>([]);
  const [agentActivity, setAgentActivity] = useState<AgentActivityEvent[]>([]);
  const [workflowEvents, setWorkflowEvents] = useState<WorkflowEvent[]>([]);
  const [goalEvents, setGoalEvents] = useState<GoalEvent[]>([]);
  const [siteEvents, setSiteEvents] = useState<SiteEvent[]>([]);
  const [settingsEvents, setSettingsEvents] = useState<SettingsAppliedEvent[]>([]);
  const [notices, setNotices] = useState<SystemNotice[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [clarifiers, setClarifiers] = useState<PendingClarifier[]>([]);
  const [repeatBacks, setRepeatBacks] = useState<PendingRepeatBack[]>([]);
  const [thinking, setThinking] = useState(false);
  const [isResponding, setIsResponding] = useState(false);
  const [roomNavRequest, setRoomNavRequest] = useState<{ key: string; ts: number } | null>(null);
  const [windowControlRequest, setWindowControlRequest] = useState<{
    action: "close" | "minimize" | "expand" | "restore" | "reorder";
    target: string; // RoomKey or "most_recent"
    ts: number;
  } | null>(null);
  // A queue, not one slot (#1024): two actions handled before a render, or
  // stamped in the same millisecond, used to run only one. The bridge runs
  // each by its `seq` and acks it, which takes it off.
  const [roomActionRequests, setRoomActionRequests] = useState<readonly QueuedRoomActionRequest[]>([]);
  const roomActionSeqRef = useRef(0);
  /** Claims sent and not yet answered, by resultId (#1025). */
  const roomActionClaimsRef = useRef(new Map<string, (granted: boolean) => void>());
  const ackRoomActionRequests = useCallback((upToSeq: number) => {
    setRoomActionRequests((prev) => (prev.some((r) => r.seq <= upToSeq) ? prev.filter((r) => r.seq > upToSeq) : prev));
  }, []);
  const wsRef = useRef<WebSocket | null>(null);
  const observerRef = useRef<WebSocketObserver | undefined>(undefined);
  useEffect(() => {
    observerRef.current = observer;
    if (wsRef.current?.readyState === WebSocket.OPEN) notifyObserver(observer, 'onOpen');
    return () => { observerRef.current = undefined; notifyObserver(observer, 'onClose'); };
  }, [observer]);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumped when a socket closes; tells a queued room action its asker is gone (#1010). */
  const socketGenerationRef = useRef(0);
  // History is authoritative only for the first successful load. After that the
  // client holds messages the vault never persists (system notices, errors,
  // workflow lines), so a reconnect must not re-seed from the vault.
  const historyHydratedRef = useRef(false);
  const streamBufferRef = useRef<string>("");
  const streamIdRef = useRef<string | null>(null);
  const toolCallsRef = useRef<ToolCall[]>([]);
  const subAgentEventsRef = useRef<SubAgentEvent[]>([]);
  const voiceCallbacksRef = useRef<VoiceCallbacks | null>(null);
  const pendingChatIdsRef = useRef<Set<string>>(new Set());
  /** Request whose chunks currently own the single foreground composer turn. */
  const currentChatRequestIdRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  /** Open while this socket's pending-approvals read is in flight (#1087). */
  const approvalWindowRef = useRef<ApprovalRehydrateWindow | null>(null);

  const connect = useCallback(() => {
    if (!enabled || !mountedRef.current) return;
    // A manual "Retry now" or the scheduled backoff can fire while a socket is
    // already opening/open; clear any pending backoff and don't stack sockets.
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    if (wsRef.current && (wsRef.current.readyState === WebSocket.CONNECTING || wsRef.current.readyState === WebSocket.OPEN)) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.binaryType = "arraybuffer";

    ws.onopen = async () => {
      if (wsRef.current !== ws || !mountedRef.current) return;
      setIsConnected(true);
      notifyObserver(observerRef.current, 'onOpen');
      chat?.onOpen(ws);
      console.log("[WS] Connected");
      // Load chat history from backend on the first connect that gets an answer.
      if (!chat && !historyHydratedRef.current) {
        try {
          const resp = await fetch("/api/vault/conversations/active?channel=websocket");
          if (resp.ok) {
            const data = await resp.json();
            if (wsRef.current !== ws || !mountedRef.current) return;
            historyHydratedRef.current = true;
            if (data.messages && data.messages.length > 0) {
              const restored: ChatMessage[] = data.messages.map((m: any) => ({
                id: m.id,
                role: m.role as MessageRole,
                content: m.content,
                timestamp: m.created_at,
                toolCalls: m.tool_calls ?? undefined,
              }));
              setMessages((prev) => mergeRestoredHistory(restored, prev));
            }
          }
        } catch (err) {
          console.warn("[WS] Failed to load history:", err);
        }
      }

      // Rehydrate any pending approval requests so a daemon restart (or a
      // dashboard reload mid-approval) doesn't strand the user with no
      // visible card. Server is authoritative.
      // Phase 5B: REST now includes `intent` + `impact` directly (matches
      // WS broadcast shape), so no more client-side derivation.
      const approvalWindow: ApprovalRehydrateWindow = { added: new Set(), settled: new Set() };
      approvalWindowRef.current = approvalWindow;
      try {
        const resp = await fetch("/api/authority/approvals?status=pending");
        if (resp.ok) {
          const rows = (await resp.json()) as Array<{
            id: string;
            agent_name: string;
            tool_name: string;
            action_category: string;
            urgency: "urgent" | "normal";
            reason: string;
            created_at: number;
            intent?: string;
            intent_action?: string;
            intent_reason?: string;
            impact?: ApprovalImpact;
          }>;
          if (wsRef.current !== ws || !mountedRef.current) return;
          const rehydrated: PendingApproval[] = rows.map((r) => ({
            id: r.id,
            shortId: r.id.slice(0, 8),
            ...approvalSentence(r.intent_action, r.intent_reason, r.intent ?? r.reason ?? r.tool_name),
            category: r.action_category,
            impact: r.impact ?? deriveImpactFromCategory(r.action_category),
            agentName: r.agent_name,
            toolName: r.tool_name,
            urgency: r.urgency,
            reason: r.reason,
            timestamp: r.created_at,
          }));
          setApprovals((prev) => mergeRehydratedApprovals(rehydrated, prev, approvalWindow));
        }
      } catch (err) {
        console.warn("[WS] Failed to rehydrate approvals:", err);
      } finally {
        if (approvalWindowRef.current === approvalWindow) approvalWindowRef.current = null;
      }

      // Take down every voice card that ended while this socket was down
      // (#1011): the notices went out while it could not hear them, and its
      // own holds were dropped when it went. A click on one would 404.
      try {
        const resp = await fetch("/api/voice/confirmations");
        if (resp.ok) {
          const keep = stillPendingVoiceConfirmations(await resp.json());
          if (keep) {
            setClarifiers((prev) => prev.filter(keep));
            setRepeatBacks((prev) => prev.filter(keep));
          }
        }
      } catch (err) {
        console.warn("[WS] Failed to recheck voice confirmations:", err);
      }
    };

    ws.onclose = () => {
      if (wsRef.current !== ws || !mountedRef.current) return;
      // Every room action this socket was asked to answer is now unanswerable,
      // and no claim sent on it will be granted (#1025).
      socketGenerationRef.current += 1;
      refuseRoomActionClaims(roomActionClaimsRef.current);
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      wsRef.current = null;
      notifyObserver(observerRef.current, 'onClose');
      chat?.onClose();
      setIsConnected(false);
      setIsResponding(false);
      currentChatRequestIdRef.current = null;
      // The daemon ends this socket's realtime session and any TTS turn with
      // it, and can no longer say so: tell the voice hook directly.
      voiceCallbacksRef.current?.onDisconnect?.();
      console.log("[WS] Disconnected, reconnecting in 2s...");
      reconnectTimerRef.current = setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      if (wsRef.current !== ws || !mountedRef.current) return;
      notifyObserver(observerRef.current, 'onClose');
      setIsConnected(false);
    };

    ws.onmessage = (event) => {
      if (wsRef.current !== ws || !mountedRef.current) return;
      // Binary frame = TTS audio chunk from server
      if (event.data instanceof ArrayBuffer) {
        if (chat) return;
        voiceCallbacksRef.current?.onTTSBinary(event.data);
        return;
      }

      try {
        const msg: WSMessage = JSON.parse(event.data);
        notifyObserver(observerRef.current, 'onMessage', msg);
        // The daemon's answer to a room action claim (#1025). Only `true`
        // grants it; anything else, or a claim never answered before the
        // socket closes, runs nothing.
        if (msg.type === "room_action_claim_result") {
          const resultId = msg.payload?.resultId;
          const settle = typeof resultId === "string" ? roomActionClaimsRef.current.get(resultId) : undefined;
          if (settle) {
            roomActionClaimsRef.current.delete(resultId);
            settle(msg.payload?.granted === true);
          }
          return;
        }
        if (chat?.onMessage(msg)) return;

        // Voice signal messages → route to voice hook
        if (msg.type === "tts_start") {
          voiceCallbacksRef.current?.onTTSStart(
            msg.payload?.requestId,
            Boolean(msg.payload?.containsWake),
            Boolean(msg.payload?.containsStop),
          );
          setThinking(false); // speaking supersedes thinking
          return;
        }
        if (msg.type === "tts_text") {
          // Mid-turn signal that an upcoming sentence contains "Jarvis" —
          // UI must suppress the wake recognizer so TTS playback doesn't
          // self-trigger.
          if (msg.payload?.containsWake) {
            voiceCallbacksRef.current?.onTTSContainsWake?.(
              Boolean(msg.payload?.containsStop),
            );
          }
          return;
        }
        if (msg.type === "tts_end") {
          voiceCallbacksRef.current?.onTTSEnd(
            msg.payload?.requestId,
            Boolean(msg.payload?.bargeIn),
          );
          return;
        }
        // Premium realtime voice (gpt-realtime-2) status + live captions.
        if (msg.type === "realtime_status") {
          // Surface any human-readable reason (e.g. budget reached) as a
          // persistent system line — the v2 orb collapses error→idle and shows
          // no text, so without this the message would be invisible.
          if (msg.payload?.message) {
            setMessages((prev) => [
              ...prev,
              {
                id: uuid(),
                role: "system" as MessageRole,
                content: msg.payload.message,
                timestamp: msg.timestamp,
              },
            ]);
          }
          dispatchRealtimeStatus(msg.payload, voiceCallbacksRef.current);
          return;
        }
        if (msg.type === "realtime_transcript") {
          // Only surface completed utterances as chat messages.
          if (msg.payload?.final && msg.payload?.text) {
            setMessages((prev) => [
              ...prev,
              {
                id: uuid(),
                role: (msg.payload.role === "assistant" ? "assistant" : "user") as MessageRole,
                content: msg.payload.text,
                timestamp: msg.timestamp,
              },
            ]);
          }
          return;
        }
        if (msg.type === "thinking_start") {
          // thinking_start is a broadcast (voice pipeline), so it can arrive
          // for a turn other than the one this client owns. Never overwrite
          // an active turn's id — a stale broadcast would make the gate drop
          // the active response's stream chunks and strand the composer in
          // its Stop state.
          if (
            currentChatRequestIdRef.current
            && msg.id
            && msg.id !== currentChatRequestIdRef.current
          ) return;
          setThinking(true);
          setIsResponding(true);
          if (msg.id && !currentChatRequestIdRef.current) {
            currentChatRequestIdRef.current = msg.id;
          }
          return;
        }
        if (msg.type === "thinking_end") {
          const requestId = String(msg.payload?.requestId ?? msg.id ?? "");
          if (
            currentChatRequestIdRef.current
            && requestId
            && requestId !== currentChatRequestIdRef.current
          ) return;
          setThinking(false);
          return;
        }

        // Voice transcript → show as user message
        if (msg.type === "chat" && msg.payload?.source === "voice_transcript") {
          setMessages((prev) => [
            ...prev,
            {
              id: msg.id ?? uuid(),
              role: "user" as MessageRole,
              content: msg.payload.text,
              timestamp: msg.timestamp,
              source: "voice",
            },
          ]);
          return;
        }

        handleMessage(msg);
      } catch (err) {
        console.error("[WS] Parse error:", err);
      }
    };

    wsRef.current = ws;
  }, [enabled, chat]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === "chat" && msg.payload?.source) {
      // Proactive message (heartbeat or reactor notification)
      setMessages((prev) => [
        ...prev,
        {
          id: uuid(),
          role: "system" as MessageRole,
          content: msg.payload.text,
          timestamp: msg.timestamp,
          source: msg.payload.source,
          priority: msg.priority,
        },
      ]);
    } else if (msg.type === "stream") {
      const requestId = String(msg.payload?.requestId ?? msg.id ?? "");
      const currentRequestId = currentChatRequestIdRef.current;
      // A cancelled/superseded provider can deliver one final network chunk
      // while its async iterator unwinds. Never append it to the replacement
      // response (the old single-buffer behavior caused overlapping answers).
      if (currentRequestId && requestId && requestId !== currentRequestId) return;
      if (!currentRequestId && requestId) currentChatRequestIdRef.current = requestId;
      setIsResponding(true);
      if (msg.payload?.source === "sub-agent") {
        // Sub-agent progress event
        const event: SubAgentEvent = {
          type: msg.payload.type,
          agentName: msg.payload.agentName,
          agentId: msg.payload.agentId,
          data: msg.payload.data,
        };
        subAgentEventsRef.current = [...subAgentEventsRef.current, event];

        // Add to agent activity feed
        const activityEvent: AgentActivityEvent = {
          id: uuid(),
          agentName: msg.payload.agentName,
          agentId: msg.payload.agentId,
          eventType: msg.payload.type,
          data: msg.payload.data,
          timestamp: msg.timestamp || Date.now(),
        };
        setAgentActivity((prev) => [activityEvent, ...prev].slice(0, 50));

        // Update the current streaming message with sub-agent events
        if (streamIdRef.current) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamIdRef.current
                ? { ...m, subAgentEvents: [...subAgentEventsRef.current] }
                : m
            )
          );
        }
      } else if (msg.payload?.tool_call) {
        // Tool call event
        const tc: ToolCall = {
          name: msg.payload.tool_call.name,
          arguments: msg.payload.tool_call.arguments,
        };
        toolCallsRef.current = [...toolCallsRef.current, tc];

        // Update the current streaming message
        if (streamIdRef.current) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamIdRef.current
                ? { ...m, toolCalls: [...toolCallsRef.current] }
                : m
            )
          );
        }
      } else if (msg.payload?.text) {
        // Text chunk
        streamBufferRef.current = nextStreamBuffer(streamBufferRef.current, msg.payload);

        if (!streamIdRef.current) {
          // Start a new assistant message
          const id = requestId ? `assistant:${requestId}` : uuid();
          streamIdRef.current = id;
          setMessages((prev) => [
            ...prev,
            {
              id,
              role: "assistant",
              content: streamBufferRef.current,
              timestamp: Date.now(),
              isStreaming: true,
            },
          ]);
        } else {
          // Update existing streaming message
          const currentContent = streamBufferRef.current;
          const currentId = streamIdRef.current;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === currentId ? { ...m, content: currentContent } : m
            )
          );
        }
      }
    } else if (
      msg.type === "status"
      && (msg.payload?.status === "done" || msg.payload?.status === "cancelled")
    ) {
      const requestId = String(msg.payload?.requestId ?? msg.id ?? "");
      if (
        currentChatRequestIdRef.current
        && requestId
        && requestId !== currentChatRequestIdRef.current
      ) return;
      // Stream complete or explicitly stopped. Keep partial text visible but
      // remove its speaking/streaming state immediately.
      const finalId = streamIdRef.current || (requestId ? `assistant:${requestId}` : "");
      if (finalId) {
        const fullText = typeof msg.payload?.fullText === "string" ? msg.payload.fullText : undefined;
        setMessages((prev) => finalizeStreamMessage(prev, {
          id: finalId,
          fullText,
          timestamp: msg.timestamp || Date.now(),
          toolCalls: toolCallsRef.current,
          subAgentEvents: subAgentEventsRef.current,
        }));
      }
      // Reset stream state
      streamBufferRef.current = "";
      streamIdRef.current = null;
      toolCallsRef.current = [];
      subAgentEventsRef.current = [];
      // A successful completion ends any in-flight chat request correlation.
      pendingChatIdsRef.current.clear();
      currentChatRequestIdRef.current = null;
      setIsResponding(false);
      setThinking(false);
    } else if (msg.type === "goal_event") {
      const goalEvent = msg.payload as GoalEvent;
      setGoalEvents((prev) => goalEvent.eventId && prev.some(event => event.eventId === goalEvent.eventId)
        ? prev : [...prev.slice(-99), goalEvent]);
    } else if (msg.type === "workflow_event") {
      const wfEvent = msg.payload as WorkflowEvent;
      setWorkflowEvents((prev) => [...prev.slice(-100), wfEvent]);

      // If it's a workflow_message, show it in the chat
      if (wfEvent.type === "workflow_message" && wfEvent.data?.message) {
        setMessages((prev) => [
          ...prev,
          {
            id: uuid(),
            role: "system" as MessageRole,
            content: String(wfEvent.data.message),
            timestamp: wfEvent.timestamp,
            source: "workflow",
          },
        ]);
      }
    } else if (msg.type === "site_event") {
      const siteEvent = msg.payload as SiteEvent;
      setSiteEvents((prev) => [...prev.slice(-100), siteEvent]);
    } else if (msg.type === "settings_applied") {
      const payload = msg.payload as Omit<SettingsAppliedEvent, "timestamp">;
      const event: SettingsAppliedEvent = { ...payload, timestamp: msg.timestamp };
      setSettingsEvents((prev) => [...prev.slice(-20), event]);
    } else if (msg.type === "notification") {
      const payload = msg.payload as {
        source?: string;
        action?: string;
        task?: TaskEvent["task"];
        item?: ContentEvent["item"];
        event?: any;
        text?: string;
      };
      if (payload.source === "task_update" && payload.task && payload.action) {
        const event: TaskEvent = {
          action: payload.action as TaskEvent["action"],
          task: payload.task,
          timestamp: msg.timestamp,
        };
        setTaskEvents((prev) => [...prev, event]);
      } else if (payload.source === "content_update" && payload.item && payload.action) {
        const event: ContentEvent = {
          action: payload.action as ContentEvent["action"],
          item: payload.item,
          timestamp: msg.timestamp,
        };
        setContentEvents((prev) => [...prev, event]);
      } else if (payload.source === "awareness_event") {
        // Awareness events (context changes, suggestions, etc.)
        const awarenessEvent = payload.event as { type: string; data: Record<string, unknown> };
        if (awarenessEvent?.type === "suggestion_ready") {
          // Inbox/card events must not become chat messages here. Quiet awareness
          // deliberately delivers these without a proactive chat announcement.
          console.log("[WS] Awareness suggestion:", awarenessEvent.data.title);
        }
      } else if (payload.source === "sidecar_event" && payload.event?.type === "sidecar_disconnect") {
        const noticeMessage = createSidecarNotice(payload, msg.timestamp);
        if (noticeMessage.notice) {
          setNotices((prev) => [noticeMessage.notice!, ...prev.filter((item) => item.text !== noticeMessage.notice!.text)].slice(0, 3));
        }
        setMessages((prev) => [...prev, noticeMessage]);
      } else if (payload.source === "assistant_message" && payload.text) {
        setMessages((prev) => [
          ...prev,
          {
            id: msg.id ?? uuid(),
            role: "assistant",
            content: String(payload.text),
            timestamp: msg.timestamp,
          },
        ]);
      } else if (payload.source === "approval_request") {
        const pending = pendingApprovalFrom(payload, msg.timestamp);
        if (pending) {
          approvalWindowRef.current?.added.add(pending.id);
          setApprovals((prev) =>
            prev.some((a) => a.id === pending.id) ? prev : [...prev, pending],
          );
        }
      } else if (payload.source === "approval_update") {
        const request = (payload as { request?: { id: string; status?: string } }).request;
        const requestId = request?.id;
        if (requestId && request.status === "pending") {
          // A Brief document save re-files its approval and announces the new
          // row, still pending, only as an update: show or refresh its card (#1087).
          const pending = pendingApprovalFrom(payload, msg.timestamp);
          if (pending) {
            approvalWindowRef.current?.added.add(pending.id);
            setApprovals((prev) =>
              prev.some((a) => a.id === pending.id) ? prev.map((a) => (a.id === pending.id ? pending : a)) : [...prev, pending],
            );
          }
        } else if (requestId) {
          approvalWindowRef.current?.settled.add(requestId);
          setApprovals((prev) => prev.filter((a) => a.id !== requestId));
        }
      } else if (payload.source === "clarifier_request") {
        const p = payload as {
          id?: string;
          transcript?: string;
          intent?: {
            verb?: string;
            impact?: string;
            confidence?: number;
            object?: { type?: string; query?: string } | null;
            alternatives?: Array<{ label?: string; verb?: string; impact?: string }>;
          };
        };
        if (!p.id || !p.transcript || !p.intent) return;
        const primaryLabel = buildIntentLabel(p.intent.verb ?? "ask", p.intent.object ?? null, p.transcript);
        const primary: VoiceIntentLite = {
          label: primaryLabel,
          verb: p.intent.verb ?? "ask",
          impact: (p.intent.impact as ApprovalImpact) ?? "read",
        };
        const alternatives: VoiceIntentLite[] = (p.intent.alternatives ?? [])
          .map((a) => ({
            label: typeof a.label === "string" && a.label.length > 0 ? a.label : `${a.verb ?? "ask"}`,
            verb: a.verb ?? "ask",
            impact: (a.impact as ApprovalImpact) ?? "read",
          }))
          .slice(0, 2);
        const pending: PendingClarifier = {
          id: p.id,
          transcript: p.transcript,
          primary,
          alternatives,
          confidence: typeof p.intent.confidence === "number" ? p.intent.confidence : 0.7,
          timestamp: msg.timestamp,
        };
        setClarifiers((prev) =>
          prev.some((c) => c.id === pending.id) ? prev : [...prev, pending],
        );
      } else if (payload.source === "repeat_back_request") {
        const pending = repeatBackFrom(payload, msg.timestamp);
        if (!pending) return;
        setRepeatBacks((prev) =>
          prev.some((r) => r.id === pending.id) ? prev : [...prev, pending],
        );
      } else if (payload.source === "voice_confirmation_resolved" || payload.source === "voice_confirmation_expired") {
        // Resolved anywhere, expired, or its dashboard gone (#1011): the
        // card is dead on every dashboard that was shown it.
        const id = retiredVoiceConfirmationId(payload);
        if (id) {
          setClarifiers((prev) => prev.filter((c) => c.id !== id));
          setRepeatBacks((prev) => prev.filter((r) => r.id !== id));
        }
      } else if (payload.source === "navigate_room") {
        // Daemon-driven Room navigation (voice "open workflows" etc.).
        // Bumping `ts` on every emit guarantees React sees a new value
        // even if the user navigates to the same Room twice in a row.
        const key = (payload as { key?: string }).key;
        if (typeof key === "string") {
          setRoomNavRequest({ key, ts: msg.timestamp });
        }
      } else if (payload.source === "navigate_home") {
        // Daemon-driven home/back navigation (voice "back to thread", etc.).
        // Reuses the same channel as Room nav so AppShell only watches one
        // signal — distinguished by key === "home".
        setRoomNavRequest({ key: "home", ts: msg.timestamp });
      } else if (payload.source === "room_action") {
        // Phase 6.3.5 — Room control via voice. Daemon broadcasts a
        // structured action; the UI's action bus dispatches to whichever
        // Room is currently registered. Each one is queued under its own
        // `seq`, so the same action repeated, or two at once, all run (#1024).
        const req = roomActionRequestFrom(payload, msg.timestamp);
        if (req?.resultId) {
          // The daemon stops waiting the moment this socket closes, and says
          // it got no answer, so an action still queued then must not run
          // on the next socket (#1010).
          const socket = socketGenerationRef.current;
          req.stillAsked = () => socketGenerationRef.current === socket;
          // The daemon decides whether it is still waiting, not this page's
          // clock (#1025): ask it, on this socket, just before running.
          if (req.needsClaim) {
            const resultId = req.resultId;
            req.claim = () => new Promise<boolean>((resolve) => {
              const ws = wsRef.current;
              if (socketGenerationRef.current !== socket || ws?.readyState !== WebSocket.OPEN) {
                resolve(false);
                return;
              }
              const claims = roomActionClaimsRef.current;
              claims.get(resultId)?.(false);
              claims.set(resultId, resolve);
              try {
                ws.send(JSON.stringify({ type: "room_action_claim", payload: { resultId }, timestamp: Date.now() }));
              } catch {
                claims.delete(resultId);
                resolve(false);
              }
            });
          }
        }
        if (req) {
          const queued: QueuedRoomActionRequest = { ...req, seq: ++roomActionSeqRef.current, receivedAt: performance.now() };
          // Nothing is lost to the slot any more, so nothing may pile up in
          // it either: what no bridge has taken by the time the bus would
          // have dropped it goes, as it would have there.
          setRoomActionRequests((prev) => [...prev.filter((r) => stillDeliverable(r, queued.receivedAt)), queued]);
        }
      } else if (payload.source === "window_control") {
        // Phase 6.1.5 follow-up: voice window-control ("close", "expand",
        // "minimize" etc.) — daemon regex-matches and broadcasts here so
        // the UI can drive RoomWindow chrome without an LLM round-trip.
        const action = (payload as { action?: string }).action;
        const target = (payload as { target?: string }).target;
        if (
          (action === "close" || action === "minimize" || action === "expand" || action === "restore" || action === "reorder") &&
          typeof target === "string"
        ) {
          setWindowControlRequest({ action, target, ts: msg.timestamp });
        }
      }
    } else if (msg.type === "error") {
      const route = routeErrorFrame({ id: msg.id, requestId: msg.payload?.requestId },
        { sentAsText: (id) => pendingChatIdsRef.current.has(id), followingTurn: currentChatRequestIdRef.current });
      voiceCallbacksRef.current?.onError(msg.payload?.message, route.voiceRequestId);

      // Always preserve the raw payload in the console for debugging.
      console.error("[WS] Error frame:", msg.payload);
      if (msg.id != null) pendingChatIdsRef.current.delete(msg.id);

      const { content, detail, failure } = errorFrameContent(msg.payload, route.askedHere);
      setMessages((prev) => [
        ...prev,
        {
          id: uuid(),
          role: "system",
          content,
          detail,
          timestamp: msg.timestamp,
          source: "error",
          ...(failure ? { failure } : {}),
        },
      ]);
      // A turn this tab was not following ended; this tab's own turn goes on.
      if (!route.endsTurn) return;
      // Reset stream state on error
      streamBufferRef.current = "";
      streamIdRef.current = null;
      toolCallsRef.current = [];
      subAgentEventsRef.current = [];
      currentChatRequestIdRef.current = null;
      setIsResponding(false);
      setThinking(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    // "Retry now" on the offline system-state forces an immediate reconnect
    // instead of waiting out the 2s backoff (recovery is automatic either way).
    const onManualRetry = () => connect();
    window.addEventListener("jarvis:ws-reconnect", onManualRetry);
    return () => {
      mountedRef.current = false;
      // Cleanup disables onclose below, so invalidate queued room actions here too.
      socketGenerationRef.current += 1;
      refuseRoomActionClaims(roomActionClaimsRef.current);
      window.removeEventListener("jarvis:ws-reconnect", onManualRetry);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      const socket = wsRef.current;
      wsRef.current = null;
      // Closing during unmount/mode change must not schedule a second connection.
      if (socket) {
        socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
        socket.close();
      }
      chat?.onClose();
      notifyObserver(observerRef.current, 'onClose');
      setIsConnected(false);
    };
  }, [connect, chat]);

  const cancelResponse = useCallback(() => {
    if (chat) return;
    const requestId = currentChatRequestIdRef.current;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "cancel",
        payload: requestId ? { requestId } : {},
        id: requestId ?? undefined,
        timestamp: Date.now(),
      }));
    }

    if (streamIdRef.current) {
      const finalId = streamIdRef.current;
      setMessages((prev) => prev.map((message) =>
        message.id === finalId ? { ...message, isStreaming: false } : message
      ));
    }
    streamBufferRef.current = "";
    streamIdRef.current = null;
    toolCallsRef.current = [];
    subAgentEventsRef.current = [];
    pendingChatIdsRef.current.clear();
    currentChatRequestIdRef.current = null;
    setThinking(false);
    setIsResponding(false);
  }, [chat]);

  const sendMessage = useCallback(
    (text: string, options?: { projectId?: string; currentRoom?: string }) => {
      if (chat) return;
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

      // Typed barge-in: the replacement turn owns the composer immediately.
      // The daemon also enforces this, but doing it here prevents even a single
      // late chunk from the old request flashing into the new response. The ref
      // is set before isResponding in every path, so it alone is a sufficient
      // (and render-stable) guard.
      if (currentChatRequestIdRef.current) cancelResponse();

      const id = uuid();
      currentChatRequestIdRef.current = id;
      setIsResponding(true);

      // Add user message to local state
      setMessages((prev) => [
        ...prev,
        {
          id,
          role: "user",
          content: text,
          timestamp: Date.now(),
          source: options?.projectId ? `site:${options.projectId}` : undefined,
        },
      ]);

      // Track this request ID so we can correlate any incoming error frame
      // with the chat request that provoked it.
      pendingChatIdsRef.current.add(id);

      // Send to server. `currentRoom` lets the daemon's intent classifier
      // (run on text submissions for nav/room_action interception) bias
      // toward in-room actions when the user is already inside a Room.
      const msg: WSMessage = {
        type: "chat",
        payload: {
          text,
          ...(options?.projectId ? { projectId: options.projectId } : {}),
          ...(options?.currentRoom ? { currentRoom: options.currentRoom } : {}),
        },
        id,
        timestamp: Date.now(),
      };
      try {
        wsRef.current.send(JSON.stringify(msg));
      } catch (err) {
        // Never fail a submit silently (issue #260): surface a notice so the
        // composer doesn't look alive while nothing reaches the daemon.
        console.error("Failed to send chat message:", err);
        pendingChatIdsRef.current.delete(id);
        const notice: SystemNotice = {
          id: uuid(),
          title: "Message not sent",
          text: `Could not send your message: ${err instanceof Error ? err.message : String(err)}`,
          level: "warning",
        };
        setNotices((prev) => [notice, ...prev.filter((item) => item.text !== notice.text)].slice(0, 3));
      }
    },
    [cancelResponse, chat]
  );

  const dismissNotice = useCallback((noticeId: string) => {
    setNotices((prev) => prev.filter((notice) => notice.id !== noticeId));
  }, []);

  return {
    messages, isConnected, sendMessage, cancelResponse, isResponding, taskEvents, contentEvents, agentActivity, workflowEvents, goalEvents, siteEvents, settingsEvents, notices, dismissNotice,
    approvals,
    clarifiers,
    repeatBacks,
    thinking,
    roomNavRequest,
    windowControlRequest,
    roomActionRequests,
    ackRoomActionRequests,
    wsRef,
    voiceCallbacksRef,
  };
}

/**
 * Render a short imperative label for a voice intent. The classifier emits
 * structured fields (verb + object); we synthesize a sentence good enough
 * for the clarifier card heading. Falls back to the raw transcript when
 * structure is missing.
 */
function buildIntentLabel(
  verb: string,
  object: { type?: string; query?: string } | null,
  transcript: string,
): string {
  const obj = object?.query ?? object?.type ?? "";
  const verbLabel: Record<string, string> = {
    ask: "Answer about",
    show: "Open",
    run: "Run",
    create: "Create",
    update: "Update",
    delete: "Delete",
    grant: "Grant authority for",
    revoke: "Revoke authority for",
    pause: "Pause",
    resume: "Resume",
    unknown: "Handle",
  };
  const head = verbLabel[verb] ?? "Handle";
  if (obj) return `${head} ${obj}`;
  // No object — echo the user's words as the most informative thing we can say.
  const trimmed = transcript.trim();
  return trimmed.length > 0 ? `${head}: "${trimmed}"` : head;
}

/**
 * A daemon-driven room action, as the dashboard dispatches it. `resultId` is
 * set only when the daemon asked THIS dashboard to say whether the room ran it
 * (`resultFrom: "dashboard"`, #965); the pebble's requests carry a resultId
 * for the native panels to answer, and the dashboard must not answer those.
 * Null for a malformed action, and for one that is not presentation and was
 * not addressed to this dashboard (#974).
 */
export type DashboardRoomActionRequest = {
  room: string;
  action: string;
  args: Record<string, unknown>;
  ts: number;
  resultId?: string;
  /**
   * On this dashboard's monotonic clock (performance.now), when the daemon
   * stops waiting for the answer (#1010). The bus does not run the action
   * after this.
   */
  expiresAt?: number;
  /** False once the socket the action came on has closed (#1010). */
  stillAsked?: () => boolean;
  /**
   * The daemon asked for a claim before the action runs (#1025): it is run
   * only if the daemon, asked just before, says it is still waiting.
   */
  needsClaim?: true;
  /** Asks the daemon for that go-ahead on the socket the action came on. */
  claim?: () => Promise<boolean>;
};

/** Refuse every claim still waiting for the daemon's answer (#1025). */
function refuseRoomActionClaims(claims: Map<string, (granted: boolean) => void>): void {
  const waiting = [...claims.values()];
  claims.clear();
  for (const settle of waiting) settle(false);
}

/**
 * A room action as the dashboard queues it for its bridge (#1024): `seq` is
 * this page's own count, so two actions never share a key the way two
 * messages stamped in the same millisecond did, and `receivedAt` is when it
 * arrived, on the monotonic clock `expiresAt` uses.
 */
export type QueuedRoomActionRequest = DashboardRoomActionRequest & { seq: number; receivedAt: number };

/**
 * Whether a queued room action could still run at `now`: the bus would drop
 * it otherwise (its asker gone, past its deadline, or older than the bus's
 * own queue TTL), so the queue need not keep it for a bridge.
 */
export function stillDeliverable(req: QueuedRoomActionRequest, now: number): boolean {
  if (req.stillAsked?.() === false) return false;
  if (req.expiresAt !== undefined && now >= req.expiresAt) return false;
  return now - req.receivedAt < ROOM_ACTION_QUEUE_TTL_MS;
}

/**
 * The clarifier or repeat-back card a daemon notification takes down, or
 * null: `voice_confirmation_resolved` (answered, on any dashboard) and
 * `voice_confirmation_expired` (timed out, or the dashboard it was for has
 * closed, #1011).
 */
export function retiredVoiceConfirmationId(payload: unknown): string | null {
  const p = (payload ?? {}) as { source?: unknown; id?: unknown };
  if (p.source !== "voice_confirmation_resolved" && p.source !== "voice_confirmation_expired") return null;
  return typeof p.id === "string" && p.id ? p.id : null;
}

/**
 * Which voice cards to keep, from `/api/voice/confirmations` (#1011): those
 * still waiting, and any that arrived after the list was read (`at`, on the
 * daemon clock the cards' timestamps use). Null when the body is not that
 * shape: a card is never dropped on a reply this cannot read.
 */
export function stillPendingVoiceConfirmations(body: unknown): ((card: { id: string; timestamp: number }) => boolean) | null {
  const b = (body ?? {}) as { ids?: unknown; at?: unknown };
  if (!Array.isArray(b.ids) || typeof b.at !== "number") return null;
  const ids = new Set(b.ids.filter((id): id is string => typeof id === "string"));
  const at = b.at;
  // >= not >: a card stamped in the same millisecond the list was read was
  // not in it, and dropping it would hide a hold that is still waiting.
  return (card) => ids.has(card.id) || card.timestamp >= at;
}

/** A daemon `repeat_back_request`, or null when malformed. */
export function repeatBackFrom(payload: unknown, timestamp: number): PendingRepeatBack | null {
  const p = (payload ?? {}) as { id?: unknown; transcript?: unknown; confidence?: unknown; action?: unknown };
  if (typeof p.id !== "string" || !p.id || typeof p.transcript !== "string" || !p.transcript) return null;
  return {
    id: p.id,
    transcript: p.transcript,
    confidence: typeof p.confidence === "number" ? p.confidence : 0.4,
    timestamp,
    ...(typeof p.action === "string" && p.action ? { action: p.action } : {}),
  };
}

export function roomActionRequestFrom(payload: unknown, ts: number, receivedAt: number = performance.now()): DashboardRoomActionRequest | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { room?: unknown; action?: unknown; args?: unknown; resultId?: unknown; resultFrom?: unknown; expiresInMs?: unknown; claim?: unknown };
  if (typeof p.room !== "string" || typeof p.action !== "string") return null;
  const req: DashboardRoomActionRequest = {
    room: p.room,
    action: p.action,
    args: p.args && typeof p.args === "object" ? (p.args as Record<string, unknown>) : {},
    ts,
  };
  if (p.resultFrom === "dashboard" && typeof p.resultId === "string" && p.resultId) {
    req.resultId = p.resultId;
    // Taken here, as the message arrives, not when React gets round to
    // dispatching it: the daemon's wait has been running since it sent it.
    const expiresAt = roomActionExpiry(p.expiresInMs, receivedAt);
    if (expiresAt !== undefined) req.expiresAt = expiresAt;
    // A daemon from before #1025 sends no `claim`, and its actions run as
    // they did then.
    if (p.claim === true) req.needsClaim = true;
  }
  // An action that changes more than the screen is run only by the dashboard
  // the daemon addressed (#974); the daemon sends it nowhere else, and this
  // keeps it so if one ever reaches another dashboard.
  if (!req.resultId && !isPresentationRoomAction(req.room, req.action)) return null;
  return req;
}
