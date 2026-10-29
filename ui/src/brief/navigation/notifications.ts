import type { NotificationItem } from "../../hooks/useNotificationCenter";
import type { BriefRoute } from "../contracts";
import { destination, type Resolution, type RoomAvailability } from "./destinations";
import type { NavigationCompatibility } from "./controller";

export type AttentionItem = NotificationItem & {
  source: "approval" | "clarifier" | "repeat-back" | "system" | "failure" | "update";
  refs?: { taskId?: string; flowId?: string; versionId?: string; runId?: string };
};
export type AttentionIdentity = Readonly<Pick<AttentionItem, "source" | "id">>;
export type AttentionSnapshot =
  | { status: "ready"; items: readonly AttentionItem[] }
  | { status: "loading" | "stale" | "unavailable" | "unsupported" };
export const attentionKey = (item: AttentionIdentity) => `${item.source}:${item.id}`;

/** Consume the existing notification owner's rows; no text heuristics or synthetic timestamps. */
export const fromNotificationCenter = (items: readonly NotificationItem[]): AttentionItem[] =>
  items.map(item => ({ ...item, source: item.kind }));

/**
 * The rows the dashboard's Notifications list shows. Clarifiers and
 * repeat-backs always have their own cards beside it. Approvals have theirs
 * (the pending decisions list) only while the decisions capability is on;
 * without it they stay in this list, so a pending approval is never hidden.
 */
export function dashboardAttentionItems(items: readonly NotificationItem[], decisionsShown: boolean): AttentionItem[] {
  return fromNotificationCenter(items.filter(item => item.kind !== "clarifier" && item.kind !== "repeat-back"
    && !(decisionsShown && item.kind === "approval")));
}

/** The notice the dashboard toasts: the newest unread one Jarvis sent on its own, never a client warning. */
export const dashboardToastNotice = (items: readonly NotificationItem[]): NotificationItem | undefined =>
  items.find(item => item.kind === "system" && item.proactive === true && item.unread);

export function notificationTarget(item: AttentionItem, available: RoomAvailability): Resolution {
  const brief = (route: BriefRoute): Resolution => ({ target: { kind: "brief", route }, message: null });
  if (item.source === "approval") return available("needs-you")
    ? brief({ room: "needs-you", selection: { approvalId: item.id } })
    : destination("advanced-authority", available);
  if (item.source === "clarifier" || item.source === "repeat-back") return {
    target: { kind: "conversation", itemId: item.id }, message: null,
  };
  if (item.source === "update") return destination("devices", available);
  if (item.source === "failure") {
    const refs = item.refs;
    if (refs?.flowId || refs?.versionId || refs?.runId) {
      // A workflow run is not a commitment or an agent task. Keep its identity
      // and unread state until its inspection destination can actually open.
      if (!refs.flowId || !refs.versionId || !refs.runId || !available("workflow-runs"))
        throw new Error("Workflow run history is unavailable");
      return brief({
        room: "workflow-runs", selection: { flowId: refs.flowId, versionId: refs.versionId, runId: refs.runId },
      });
    }
    if (refs?.taskId && /^[a-zA-Z0-9_-]+$/.test(refs.taskId)) return { target: { kind: "legacy", hash: `#/_task_${refs.taskId}` }, message: "Opening task recovery in the current dashboard." };
    return destination("tasks", available);
  }
  return destination("logs", available);
}

/** Pending critical rows stay discoverable after being read, independently of conversation visibility. */
export function attentionView(snapshot: AttentionSnapshot) {
  return snapshot.status === "ready"
    ? { status: "ready" as const, items: [...new Map(snapshot.items.map(item => [attentionKey(item), item])).values()], count: new Set(snapshot.items.map(attentionKey)).size }
    : { status: snapshot.status, items: [] as readonly AttentionItem[], count: null };
}

export async function openNotification(
  key: string,
  host: { snapshot(): AttentionSnapshot; roomAvailable: RoomAvailability; markRead(identity: AttentionIdentity): void },
  navigation: NavigationCompatibility,
) {
  let selected: AttentionItem | undefined;
  const result = await navigation.open(() => {
    const fresh = host.snapshot();
    selected = fresh.status === "ready" ? attentionView(fresh).items.find(item => attentionKey(item) === key) : undefined;
    if (!selected) throw new Error("Notification is no longer available");
    return notificationTarget(selected, host.roomAvailable);
  });
  if (result.state === "opened" && selected) host.markRead({ source: selected.source, id: selected.id });
  return result;
}
