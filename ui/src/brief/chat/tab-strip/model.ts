/** A structural view port for F-04. No transport, persistence or close policy lives here. */
export interface ConversationTabsOwner {
  status: { mode: "disabled" | "loading" | "scoped" | "legacy" | "unavailable"; pending: number; error: string | null };
  state: { workspaceId: string | null; order: readonly string[]; activeId: string | null; conversations: Readonly<Record<string, { conversation: { title: string } }>> };
  client: { add(): Promise<unknown>; select(id: string): Promise<unknown>; close(id: string): Promise<unknown> };
}
export interface ChatTab { id: string; title: string }
export interface ConversationTabsBinding {
  source: "live" | "fixture";
  scopeId: string | null;
  status: ConversationTabsOwner["status"];
  tabs: readonly ChatTab[];
  activeId: string | null;
  actions: ConversationTabsOwner["client"];
}
/** Pass the useBriefConversation() result, not a second provider or socket. */
export function bindConversationTabs(owner: ConversationTabsOwner, source: ConversationTabsBinding["source"]): ConversationTabsBinding {
  return { source, scopeId: owner.state.workspaceId, status: owner.status, activeId: owner.state.activeId,
    tabs: owner.state.order.map(id => ({ id, title: owner.state.conversations[id]?.conversation.title || "New chat" })),
    actions: { add: () => owner.client.add(), select: id => owner.client.select(id), close: id => owner.client.close(id) } };
}
export const MIN_CHAT_TAB_WIDTH = 112;
export const CHAT_TAB_GAP = 4;
export const chatTabWidth = (viewport: number, count: number) => Math.max(MIN_CHAT_TAB_WIDTH, (viewport - CHAT_TAB_GAP * Math.max(0, count - 1)) / Math.max(1, count));
export const chatTabId = (panelId: string, id: string) => `${panelId}-tab-${encodeURIComponent(id)}`;
export function tabsMode(mode: "live" | "preview", binding?: ConversationTabsBinding) {
  if (!binding || binding.source !== (mode === "live" ? "live" : "fixture")) return "disabled";
  if (binding.status.mode === "scoped" && !binding.scopeId) return "unavailable";
  return binding.status.mode;
}
