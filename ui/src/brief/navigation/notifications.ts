import type { NotificationItem } from "../../hooks/useNotificationCenter";
import type { BriefRoute } from "../contracts";
import { destination, type Resolution, type RoomAvailability } from "./destinations";
import type { NavigationCompatibility } from "./controller";

export type AttentionItem = NotificationItem & {
  source: "approval" | "clarifier" | "repeat-back" | "system" | "failure" | "update";
  refs?: { taskId?: string; flowId?: string; versionId?: string; runId?: string };
};
export type AttentionSnapshot =
  | { status: "ready"; items: readonly AttentionItem[] }
  | { status: "loading" | "stale" | "unavailable" | "unsupported" };
export const attentionKey = (item: AttentionItem) => `${item.source}:${item.id}`;

/** Consume the existing notification owner's rows; no text heuristics or synthetic timestamps. */
export const fromNotificationCenter = (items: readonly NotificationItem[]): AttentionItem[] =>
  items.map(item => ({ ...item, source: item.kind }));

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
    if (refs?.flowId && refs.versionId && refs.runId && available("workflow-runs")) return brief({
      room: "workflow-runs", selection: { flowId: refs.flowId, versionId: refs.versionId, runId: refs.runId },
    });
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
  host: { snapshot(): AttentionSnapshot; roomAvailable: RoomAvailability; markRead(id: string): void },
  navigation: NavigationCompatibility,
) {
  let selected: AttentionItem | undefined;
  const result = await navigation.open(() => {
    const fresh = host.snapshot();
    selected = fresh.status === "ready" ? attentionView(fresh).items.find(item => attentionKey(item) === key) : undefined;
    if (!selected) throw new Error("Notification is no longer available");
    return notificationTarget(selected, host.roomAvailable);
  });
  if (result.state === "opened" && selected) host.markRead(selected.id);
  return result;
}
