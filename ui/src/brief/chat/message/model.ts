/** Structural F-04/F-06 view port. The existing owner retains transport/history. */
export interface ReadingPosition { top: number; atBottom: boolean }
export interface Activity {
  activityId: string; conversationId: string; turnId: string; requestId: string;
  firstSequence: number; sequence: number; live: boolean;
  kind?: "tool" | "agent" | "task"; order?: number;
  phase: "started" | "completed" | "failed"; summary: string;
  refs: readonly { kind: string; id: string }[];
}
export interface Message { id: string; conversation_id: string; role: string; content: string; created_at: number }
export interface ReplyTurn {
  conversationId: string; turnId: string; requestId: string; createdAt: number;
  state: string; assistantMessageId?: string;
}
export interface MessageChat {
  messages: readonly Message[]; turns: Readonly<Record<string, ReplyTurn>>;
  activity?: Readonly<Record<string, Activity>>; scroll: ReadingPosition;
  history: { state: "idle" | "loading" | "ready" | "error"; cursor: string | null };
}
export interface MessageOwner {
  status: { mode: "disabled" | "loading" | "scoped" | "legacy" | "unavailable"; connected: boolean; progressEnabled?: boolean };
  state: { workspaceId: string | null; activeId: string | null; order: readonly string[]; conversations: Readonly<Record<string, MessageChat>> };
  client: { store: { setScroll(id: string, position: ReadingPosition): void }; loadOlder?(id: string): Promise<unknown> };
}
export interface MessageBinding {
  source: "fixture" | "live"; scopeId: string | null; conversationId: string | null;
  mode: MessageOwner["status"]["mode"]; connected: boolean; progressEnabled: boolean;
  chat?: MessageChat; saveScroll(position: ReadingPosition): void; loadOlder?(): Promise<unknown>;
}
export function bindConversationMessages(owner: MessageOwner, source: MessageBinding["source"]): MessageBinding {
  const id = owner.state.activeId;
  const chat = id && owner.state.order.includes(id) ? owner.state.conversations[id] : undefined;
  return { source, scopeId: owner.state.workspaceId, conversationId: chat ? id : null,
    mode: owner.status.mode, connected: owner.status.connected, progressEnabled: owner.status.progressEnabled === true,
    chat, saveScroll: position => { if (chat && id) owner.client.store.setScroll(id, position); },
    loadOlder: chat && id && owner.client.loadOlder ? () => owner.client.loadOlder!(id) : undefined };
}
export type ThreadItem = { key: string; time: number } & (
  { kind: "user"; message: Message } |
  { kind: "reply"; message?: Message; turn?: ReplyTurn; activities: Activity[] }
);
export const running = (turn?: ReplyTurn) => turn?.state === "running" || turn?.state === "queued";

/** Match IDs, never array positions. Tool/system messages and foreign events are not prose. */
export function threadItems(binding: MessageBinding): ThreadItem[] {
  const { chat, conversationId } = binding;
  if (!chat || !conversationId) return [];
  const turns = Object.values(chat.turns).filter(t => t.conversationId === conversationId);
  const seen = new Set<string>(), matched = new Set<string>(), items: ThreadItem[] = [];
  const activities = (turn: ReplyTurn) => Object.values(chat.activity ?? {})
    .filter(a => a.conversationId === conversationId && a.turnId === turn.turnId && a.requestId === turn.requestId
      && ["started", "completed", "failed"].includes(a.phase))
    .sort((a,b) => a.firstSequence - b.firstSequence || a.activityId.localeCompare(b.activityId));
  for (const message of chat.messages) {
    if (message.conversation_id !== conversationId || seen.has(message.id)) continue;
    seen.add(message.id);
    if (message.role === "user") items.push({ key: `message:${message.id}`, time: message.created_at, kind: "user", message });
    if (message.role === "assistant") {
      const turn = turns.find(t => t.assistantMessageId === message.id);
      if (turn) matched.add(turn.turnId);
      items.push({ key: turn ? `turn:${turn.turnId}` : `message:${message.id}`, time: turn ? turn.createdAt + .5 : message.created_at,
        kind: "reply", message, turn, activities: turn ? activities(turn) : [] });
    }
  }
  for (const turn of turns) if (!matched.has(turn.turnId)) items.push({ key: `turn:${turn.turnId}`, time: turn.createdAt + .5,
    kind: "reply", turn, activities: activities(turn) });
  return items.sort((a,b) => a.time - b.time || a.key.localeCompare(b.key));
}

// F-06's public summaries. Unknown future labels use a safe generic, never raw tool data.
const publicSummaries = new Set([
  "Reading a file.", "File read finished.", "File could not be read.",
  "Listing files.", "File listing finished.", "Files could not be listed.",
  "Searching the web.", "Web search finished.", "Web search could not finish.",
  "Opening a web page.", "Page navigation finished.", "Page could not be opened.",
  "Reading the web page.", "Page read finished.", "Page could not be read.",
  "Running a command.", "Command returned.", "Command could not finish.",
  "Looking up saved context.", "Context lookup finished.", "Context lookup could not finish.",
  "Running a tool.", "Tool returned.", "Tool could not finish.",
  "Agent work started.", "Agent work finished.", "Agent work could not finish.",
  "Task started.", "Task finished.", "Task could not finish.",
]);
export function activityText(activity: Activity) {
  return publicSummaries.has(activity.summary) ? activity.summary
    : activity.phase === "failed" ? "Activity could not finish." : activity.phase === "completed" ? "Activity finished." : "Activity in progress.";
}
export function activityCategory(activity: Activity) {
  if (activity.refs.some(ref => ref.kind === "goal")) return { label: "Goal", tone: "goal" };
  if (activity.refs.some(ref => ref.kind === "fact")) return { label: "Memory", tone: "memory" };
  return { label: activity.kind === "agent" ? "Agent" : activity.kind === "task" ? "Task" : "Tool", tone: "tool" };
}
