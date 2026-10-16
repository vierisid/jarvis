import { afterAll, afterEach, beforeAll, test } from "bun:test";
import { strict as assert } from "node:assert";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { initDatabase, getDb, closeDb } from "../../../../../src/vault/schema";
import { ConversationRepository } from "../../../../../src/vault/conversation-lifecycle";
import { ChatTurnRepository } from "../../../../../src/vault/chat-turns";
import { BriefCapabilities } from "../../../../../src/brief/capabilities";
import type { useBriefConversation } from "../provider";
import { BriefConversationClient } from "../client";
import type { ConversationApi } from "../api";
import { bindConversationComposer, type ComposerOwner } from "./model";

// Compile-time guard: the F-04 provider's value must satisfy the structural port,
// so bindConversationComposer(useBriefConversation(), "live") keeps type-checking.
const ownerFromProvider = (thread: ReturnType<typeof useBriefConversation>): ComposerOwner => thread;
void ownerFromProvider;

GlobalRegistrator.register({ url: "http://localhost:4394/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let ConversationComposer: typeof import("./ConversationComposer").ConversationComposer;
beforeAll(async () => { React = await import("react"); ({ createRoot } = await import("react-dom/client")); ({ ConversationComposer } = await import("./ConversationComposer")); });
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); closeDb(); });
afterAll(() => GlobalRegistrator.unregister());

// Drives the real F-04 client and store with in-memory repositories. No real socket, model or message.
test("the composer drives the real F-04 client: acceptance, replay, exact-turn stop, failures and retained drafts", async () => {
  initDatabase(":memory:", { quiet: true });
  const repository = new ConversationRepository(getDb()), turns = new ChatTurnRepository(getDb());
  const enabled = ["conversations", "chatTransport", "chatState"] as const;
  const capabilities = new BriefCapabilities(enabled.map(id => ({ id, provider: { readiness: () => "ready" as const } })), enabled).snapshot();
  const api: ConversationApi = {
    capabilities: async () => capabilities, tabs: async () => repository.tabs(),
    create: async () => repository.create(), tab: async (id, open) => repository.setOpen(id, open),
    select: async id => repository.activate(id), history: async (id, cursor) => repository.messages(id, { cursor: cursor ?? undefined, limit: 50 }),
  };
  const client = new BriefConversationClient(api);
  cleanups.push(() => client.stop());
  const sent: any[] = [], socket = { readyState: 1, send: (data: string) => sent.push(JSON.parse(data)) };
  const receive = (type: string, payload: unknown, id?: string) => client.adapter.onMessage({ type, payload, id, timestamp: 10 } as never);
  const emit = (event: unknown) => { if (event) receive("brief_chat_event", event); };
  function sync(id: string) {
    const request = sent.findLast(frame => frame.type === "brief_chat_subscribe" && frame.payload.conversationId === id);
    const snapshot = turns.snapshot(id, request.payload.afterSequence);
    receive("brief_chat_sync", { ...snapshot, subscribed: !snapshot.hasMore }, request.id);
  }
  async function open() {
    client.adapter.onOpen(socket as never);
    for (let i = 0; !client.getSnapshot().connected && i < 1000; i++) await Bun.sleep(1);
    assert.equal(client.getSnapshot().connected, true);
    for (const id of client.store.getSnapshot().order) sync(id);
  }
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  cleanups.push(async () => { await React.act(async () => root.unmount()); host.remove(); });
  function Harness() {
    const status = React.useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
    const state = React.useSyncExternalStore(client.store.subscribe, client.store.getSnapshot, client.store.getSnapshot);
    return <ConversationComposer mode="live" binding={bindConversationComposer({ status, state, client }, "live")} reducedMotion />;
  }
  const input = () => host.querySelector("textarea")!;
  const frames = (type: string) => sent.filter(frame => frame.type === type);
  const lastSend = () => frames("brief_chat_send").at(-1).payload;
  async function change(action: () => unknown) { await React.act(async () => { await action(); }); }
  async function click(name: string) {
    const button = host.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`); assert.ok(button, name);
    await change(() => button.click());
  }
  await client.start(); const a = await client.add(), b = await client.add(); await client.select(a); await open();
  await change(() => root.render(<Harness />));
  await change(() => client.store.setDraft(a, "Question A")); await click("Send");
  const first = lastSend(); assert.equal(first.conversationId, a); assert.equal(first.text, "Question A");
  assert.equal(input().value, "Question A"); assert.ok(host.querySelector('[aria-label="Stop response"]'));
  await change(() => { client.adapter.onClose(); }); assert.equal(input().value, "Question A");
  await change(open); assert.equal(frames("brief_chat_send").length, 2); assert.deepEqual(lastSend(), first);
  await change(() => client.store.setDraft(a, "Newer draft A"));
  await change(() => { turns.accept(first).events.forEach(emit); emit(turns.start(first)); });
  assert.equal(input().value, "Newer draft A");
  await change(() => client.select(b)); await change(() => client.store.setDraft(b, "Question B")); await click("Send");
  const second = lastSend(); assert.equal(second.conversationId, b);
  await change(() => { turns.accept(second).events.forEach(emit); emit(turns.start(second)); });
  assert.equal(input().value, "");
  await change(() => client.select(a)); await click("Stop response");
  assert.deepEqual(frames("brief_chat_cancel").at(-1).payload, { conversationId: a, turnId: first.turnId, requestId: first.requestId });
  assert.equal(client.store.getSnapshot().conversations[b]?.turns[second.turnId]?.state, "running");
  // The real client returned void above. Feedback must outlive dispatch.
  await Bun.sleep(50);
  assert.equal(host.querySelector('[role="status"]')!.textContent, "Stopping response…");
  assert.ok(host.querySelector('[aria-label="Retry stop"]'));
  await change(() => receive("brief_chat_error", { ...first, code: "unavailable", message: "Stop unavailable" }, first.requestId));
  assert.equal(host.querySelector('[role="status"]')!.textContent, "Stop unavailable");
  await click("Stop response");
  assert.equal(host.querySelector('[role="status"]')!.textContent, "Stopping response…");
  await change(() => receive("brief_chat_error", { ...first, code: "unavailable", message: "Stop unavailable" }, first.requestId));
  assert.equal(host.querySelector('[role="status"]')!.textContent, "Stop unavailable");
  await click("Stop response");
  assert.equal(host.querySelector('[role="status"]')!.textContent, "Stopping response…");
  assert.deepEqual(frames("brief_chat_cancel").at(-1).payload, { conversationId: a, turnId: first.turnId, requestId: first.requestId });
  await change(() => emit(turns.finish(first, "cancelled"))); assert.equal(input().value, "Newer draft A");
  assert.ok(host.querySelector('[aria-label="Send"]')); assert.equal(frames("brief_chat_cancel").length, 3);
  assert.notEqual(host.querySelector('[role="status"]')!.textContent, "Stopping response…");
  await click("Send"); const rejected = lastSend();
  await change(() => receive("brief_chat_error", { ...rejected, code: "unavailable", message: "Unavailable" }));
  assert.equal(input().value, "Newer draft A"); assert.ok(host.querySelector('[aria-label="Send"]'));
  await click("Send"); const retry = lastSend(); assert.notEqual(retry.turnId, rejected.turnId);
  await change(() => { turns.accept(retry).events.forEach(emit); emit(turns.finish(retry, "completed")); });
  assert.equal(input().value, "");
  await change(() => client.store.setDraft(a, "Retained on return"));
  await change(() => client.close(a)); assert.equal(client.store.getSnapshot().activeId, b); assert.ok(host.querySelector('[aria-label="Stop response"]'));
  await change(async () => { await client.reopen(a); sync(a); }); assert.equal(input().value, "Retained on return");
  assert.equal(frames("brief_chat_cancel").length, 3);
  // Stop is a request, not a dismissal of a later failure of this same turn.
  await change(() => client.select(b));
  await change(() => client.store.setDraft(b, "Keep B's next question"));
  await click("Stop response");
  assert.deepEqual(frames("brief_chat_cancel").at(-1).payload, { conversationId: b, turnId: second.turnId, requestId: second.requestId });
  assert.equal(host.querySelector('[role="status"]')!.textContent, "Stopping response…");
  const terminalError = "The response failed before it could stop.";
  await change(() => emit(turns.finish(second, "failed", { code: "provider_failed", message: terminalError })));
  assert.equal(client.store.getSnapshot().conversations[b]?.error, terminalError);
  assert.equal(host.querySelector('[role="status"]')!.textContent, terminalError);
  assert.equal(input().value, "Keep B's next question");
  assert.ok(host.querySelector('[aria-label="Send"]'));
  await change(() => client.select(a)); assert.equal(input().value, "Retained on return");
  await change(() => client.select(b));
  assert.equal(host.querySelector('[role="status"]')!.textContent, terminalError);
  assert.equal(input().value, "Keep B's next question");
  assert.equal(frames("brief_chat_cancel").length, 4);
});
