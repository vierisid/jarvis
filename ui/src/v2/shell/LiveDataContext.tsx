import React, { createContext, useContext } from "react";
import type {
  AgentActivityEvent,
  ContentEvent,
  PendingApproval,
  PendingClarifier,
  PendingRepeatBack,
  SystemNotice,
  TaskEvent,
} from "../../hooks/useWebSocket";

/**
 * Live event streams from useWebSocket, lifted into context so deeply
 * nested Room bodies (mounted by RoomBodyRegistry, far below AppShell)
 * can read them without duplicating WS connections or prop-drilling.
 *
 * Only event arrays that more than one Room consumes belong here. Pages
 * that need a single, narrow slice should still pull directly from props
 * — context exists to avoid prop drilling, not to replace props.
 */
export interface LiveData {
  approvals: PendingApproval[];
  clarifiers: PendingClarifier[];
  repeatBacks: PendingRepeatBack[];
  notices: SystemNotice[];
  taskEvents: TaskEvent[];
  contentEvents: ContentEvent[];
  agentActivity: AgentActivityEvent[];
  /**
   * Phase 6.5.5 — most-recent assistant reply, used by the RailReplyPreview
   * so users in a Room can see Jarvis's response without leaving. Null when
   * no assistant message exists yet. `isStreaming` lets the rail show a
   * caret/spinner while the reply is in-progress.
   */
  latestAssistantReply: { text: string; isStreaming: boolean; ts: number } | null;
}

const LiveDataContext = createContext<LiveData | null>(null);

export function LiveDataProvider({
  value,
  children,
}: {
  value: LiveData;
  children: React.ReactNode;
}) {
  return <LiveDataContext.Provider value={value}>{children}</LiveDataContext.Provider>;
}

/**
 * Read live event streams. Returns a stable empty default outside the
 * provider so Room bodies opened via direct URL on a fresh shell don't
 * crash before the provider mounts.
 */
export function useLiveData(): LiveData {
  const ctx = useContext(LiveDataContext);
  if (ctx) return ctx;
  return EMPTY;
}

const EMPTY: LiveData = {
  approvals: [],
  clarifiers: [],
  repeatBacks: [],
  notices: [],
  taskEvents: [],
  contentEvents: [],
  agentActivity: [],
  latestAssistantReply: null,
};
