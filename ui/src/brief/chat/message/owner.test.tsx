import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type { BriefChatEvent, BriefChatPayload } from "../../../../../src/brief/contracts";
import type { useBriefConversation } from "../provider";
import { ConversationStore } from "../store";
import { bindConversationMessages, type MessageOwner } from "./model";

// Compile-time guard: the F-04 provider's value must satisfy the structural port,
// so bindConversationMessages(useBriefConversation(), "live") keeps type-checking.
const ownerFromProvider = (thread: ReturnType<typeof useBriefConversation>): MessageOwner => thread;
void ownerFromProvider;

let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let ConversationMessages: typeof import("./ConversationMessages").ConversationMessages;
let root: Root, host: HTMLDivElement;
beforeAll(async () => {
  GlobalRegistrator.register(); (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react"); ({ createRoot } = await import("react-dom/client")); ({ ConversationMessages } = await import("./ConversationMessages"));
});
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());

const event = (sequence: number, payload: BriefChatPayload): BriefChatEvent => ({ conversationId: "a", turnId: "turn-a", requestId: "request-a", eventId: `event-${sequence}`, sequence, payload });

// Drives the real F-04 store; no socket, model or approval runs.
test("the real F-04 store's activity, approval and answer state render through the port", async () => {
  const store = new ConversationStore();
  store.restoreTabs({ workspaceId: "northwind", activeConversationId: "a", revision: "1", tabs: [{ conversationId: "a", workspaceId: "northwind", title: "Alex Morgan call", revision: "1", tab: { open: true, order: 0 }, lastMessageAt: null }] });
  store.applySnapshot({ conversationId: "a", sequence: 0, nextSequence: 0, hasMore: false, subscribed: true, events: [],
    turns: [{ conversationId: "a", turnId: "turn-a", requestId: "request-a", state: "running", speak: false, attachments: [], userMessageId: "user-a", assistantMessageId: "answer", createdAt: 9 }],
    messages: { items: [{ id: "user-a", conversation_id: "a", role: "user", content: "Prepare my call with Jordan.", created_at: 8, tool_calls: null }], nextCursor: null } });
  store.applyEvent(event(1, { kind: "activity", activity: { activityId: "lookup", kind: "tool", phase: "started", summary: "Looking up saved context.", refs: [] } }), 10);
  store.applyEvent(event(2, { kind: "approval", approvalId: "approval-1", status: "pending" }), 10);
  const owner = (): MessageOwner => ({ status: { mode: "scoped", connected: true, progressEnabled: true }, state: store.getSnapshot(), client: { store } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const render = () => React.act(async () => root.render(<div className="brief-root"><ConversationMessages mode="live" binding={bindConversationMessages(owner(), "live")} panelId="thread" reducedMotion/></div>));
  await render();
  expect(host.querySelector(".brief-user-message")?.textContent).toBe("Prepare my call with Jordan.");
  expect(host.textContent).toContain("Looking up saved context.");
  expect(host.textContent).toContain("Waiting for your approval");
  store.applyEvent(event(3, { kind: "approval", approvalId: "approval-1", status: "approved" }), 10);
  await render();
  expect(host.textContent).not.toContain("Waiting for your approval");
});
