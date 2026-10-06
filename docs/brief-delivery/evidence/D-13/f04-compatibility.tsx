/** Explicit optional cross-branch check, using the actual F-04 owner and in-memory repositories.
 * No production mount, real WebSocket, model, or external message. */
import { strict as assert } from "node:assert";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { bindConversationComposer } from "../../../../ui/src/brief/chat/composer/model";
const other = process.env.F04_WORKTREE;
if (!other) throw Error("Set F04_WORKTREE to the reviewed F-04 checkout.");
const { initDatabase, getDb, closeDb } = await import(`${other}/src/vault/schema.ts`);
const { ConversationRepository } = await import(`${other}/src/vault/conversation-lifecycle.ts`);
const { ChatTurnRepository } = await import(`${other}/src/vault/chat-turns.ts`);
const { BriefConversationClient } = await import(`${other}/ui/src/brief/chat/client.ts`);
const { BriefCapabilities } = await import(`${other}/src/brief/capabilities.ts`);
GlobalRegistrator.register({ url: "http://localhost:4393" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react"), { createRoot } = await import("react-dom/client");
const { ConversationComposer } = await import("../../../../ui/src/brief/chat/composer/ConversationComposer");
initDatabase(":memory:", { quiet: true });
const repository = new ConversationRepository(getDb()), turns = new ChatTurnRepository(getDb());
const enabled = ["conversations", "chatTransport", "chatState"];
const capabilities = new BriefCapabilities(enabled.map(id => ({ id, provider: { readiness: () => "ready" } })), enabled).snapshot();
const client = new BriefConversationClient({
  capabilities: async () => capabilities, tabs: async () => repository.tabs(), create: async () => repository.create(),
  select: async (id: string | null) => repository.activate(id), tab: async (id: string, open: boolean) => repository.setOpen(id, open),
  history: async (id: string, cursor?: string) => repository.messages(id, { cursor, limit: 50 }),
});
const sent: any[] = [], socket = { readyState: 1, send: (data: string) => sent.push(JSON.parse(data)) };
const receive = (type: string, payload: unknown, id?: string) => client.adapter.onMessage({ type, payload, id, timestamp: 10 });
const emit = (event: unknown) => { if (event) receive("brief_chat_event", event); };
function sync(id: string) {
  const request = sent.findLast(frame => frame.type === "brief_chat_subscribe" && frame.payload.conversationId === id);
  const snapshot = turns.snapshot(id, request.payload.afterSequence);
  receive("brief_chat_sync", { ...snapshot, subscribed: !snapshot.hasMore }, request.id);
}
async function open() {
  client.adapter.onOpen(socket);
  for (let i = 0; !client.getSnapshot().connected && i < 1000; i++) await Bun.sleep(1);
  assert.equal(client.getSnapshot().connected, true);
  for (const id of client.store.getSnapshot().order) sync(id);
}
const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
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
try {
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
  assert.equal(client.store.getSnapshot().conversations[b].turns[second.turnId].state, "running");
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
  console.log("PASS actual F-04 client/store + mounted D-13 composer: pending acceptance, same-ID reconnect replay, newer-draft retention, unchanged-draft clearing, two concurrent chats, exact turn cancellation, persistent stopping after synchronous dispatch, delayed failure/retry/terminal, rejected send/retry, close/reopen retention; no real transport or model.");
} finally {
  await change(() => root.unmount()); client.stop(); closeDb(); host.remove(); GlobalRegistrator.unregister();
}
