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

// #1075: the waiting line opens the existing dashboard approval card for that
// approval id, filled from the dashboard's own pending list and decided through
// the existing /api/authority/approvals routes. Nothing new can approve.
test("a pending Brief approval shows the existing approval card, decided through the existing routes", async () => {
  const store = new ConversationStore();
  store.restoreTabs({ workspaceId: "northwind", activeConversationId: "a", revision: "1", tabs: [{ conversationId: "a", workspaceId: "northwind", title: "Deploy", revision: "1", tab: { open: true, order: 0 }, lastMessageAt: null }] });
  store.applySnapshot({ conversationId: "a", sequence: 0, nextSequence: 0, hasMore: false, subscribed: true, events: [],
    turns: [{ conversationId: "a", turnId: "turn-a", requestId: "request-a", state: "running", speak: false, attachments: [], userMessageId: "user-a", assistantMessageId: "answer", createdAt: 9 }],
    messages: { items: [{ id: "user-a", conversation_id: "a", role: "user", content: "Ship it.", created_at: 8, tool_calls: null }], nextCursor: null } });
  store.applyEvent(event(1, { kind: "approval", approvalId: "approval-1", status: "pending" }), 10);
  // Another turn's pending approval, known to both F-04 and the dashboard list, must not show on this turn.
  store.applyEvent({ ...event(2, { kind: "approval", approvalId: "other-turn", status: "pending" }), turnId: "turn-b", requestId: "request-b" }, 10);
  let approvals = [
    { id: "approval-1", intent: "On this Jarvis host, run: make deploy", intentReason: "execute_command requires user approval", category: "execute_command", impact: "write" as const },
    { id: "other-turn", intent: "Delete the archive", intentReason: "", category: "file_delete", impact: "destructive" as const },
  ];
  const owner = (): MessageOwner => ({ status: { mode: "scoped", connected: true, progressEnabled: true }, state: store.getSnapshot(), client: { store }, approvals });
  const calls: string[] = [];
  let reply: Response = Response.json({ error: "Jarvis is paused. Resume it to approve." }, { status: 409 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string, init?: RequestInit) => { calls.push(`${init?.method ?? "GET"} ${input}`); return reply; }) as unknown as typeof fetch;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const render = (source: "live" | "fixture" = "live") => React.act(async () => root.render(<div className="brief-root"><ConversationMessages mode={source === "live" ? "live" : "preview"} binding={bindConversationMessages(owner(), source)} panelId="thread" reducedMotion/></div>));
  try {
    await render();
    expect(host.textContent).toContain("Waiting for your approval");
    const cards = host.querySelectorAll(".v2-approval");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.getAttribute("aria-label")).toBe("Approval required: On this Jarvis host, run: make deploy");
    expect(host.textContent).toContain("execute_command requires user approval");
    expect(host.textContent).not.toContain("Delete the archive");
    const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".v2-approval button")].find(node => node.textContent?.includes(label))!;
    // A refused approve (Jarvis paused) keeps the card and says why, as the dashboard does.
    await React.act(async () => { button("approve").click(); await Promise.resolve(); });
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(calls).toEqual(["POST /api/authority/approvals/approval-1/approve"]);
    expect(host.querySelector(".v2-approval__note")?.textContent).toBe("Jarvis is paused. Resume it to approve.");
    reply = Response.json({ ok: true });
    await React.act(async () => { button("Cancel").click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(calls.at(-1)).toBe("POST /api/authority/approvals/approval-1/deny");
    // A decision that goes through clears the earlier refusal.
    expect(host.querySelector(".v2-approval__note")).toBeNull();
    // An unreachable daemon is said on the card, not swallowed.
    globalThis.fetch = (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    await React.act(async () => { button("approve").click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(host.querySelector(".v2-approval__note")?.textContent).toBe("Jarvis could not be reached. Try again.");
    globalThis.fetch = (async (input: string, init?: RequestInit) => { calls.push(`${init?.method ?? "GET"} ${input}`); return reply; }) as unknown as typeof fetch;
    // A fixture owner renders the card but never decides anything.
    await render("fixture");
    calls.length = 0;
    await React.act(async () => { button("approve").click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(calls).toEqual([]);
    // Unknown to the dashboard list: the line stays, no card is invented.
    approvals = approvals.filter(row => row.id !== "approval-1");
    await render();
    expect(host.textContent).toContain("Waiting for your approval");
    expect(host.querySelectorAll(".v2-approval")).toHaveLength(0);
    // Settled: the line and the card both go.
    approvals = [{ id: "approval-1", intent: "On this Jarvis host, run: make deploy", intentReason: "", category: "execute_command", impact: "write" }];
    store.applyEvent(event(3, { kind: "approval", approvalId: "approval-1", status: "approved" }), 10);
    await render();
    expect(host.textContent).not.toContain("Waiting for your approval");
    expect(host.querySelectorAll(".v2-approval")).toHaveLength(0);
  } finally { globalThis.fetch = originalFetch; }
});
