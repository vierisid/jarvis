/** Optional cross-branch check. Invoke explicitly with F04_WORKTREE; no import/merge prerequisite.
 * Uses the inspected F-04 client, store and real in-memory lifecycle repository. No network/model.
 */
import { strict as assert } from "node:assert";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { bindConversationTabs } from "../../../../ui/src/brief/chat/tab-strip/model";

const other = process.env.F04_WORKTREE;
if (!other) throw Error("Set F04_WORKTREE to the reviewed F-04 checkout; this is not part of ordinary D-only CI.");
const { initDatabase, getDb, closeDb } = await import(`${other}/src/vault/schema.ts`);
const { ConversationRepository } = await import(`${other}/src/vault/conversation-lifecycle.ts`);
const { ChatTurnRepository } = await import(`${other}/src/vault/chat-turns.ts`);
const { BriefConversationClient } = await import(`${other}/ui/src/brief/chat/client.ts`);
const { BriefCapabilities } = await import(`${other}/src/brief/capabilities.ts`);
GlobalRegistrator.register({ url: "http://localhost:4392" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react"), { createRoot } = await import("react-dom/client");
const { ConversationTabStrip } = await import("../../../../ui/src/brief/chat/tab-strip/ConversationTabStrip");
initDatabase(":memory:", { quiet: true });
const repository = new ConversationRepository(getDb()), turns = new ChatTurnRepository(getDb());
const enabled = ["conversations", "chatTransport", "chatState"];
const capabilities = new BriefCapabilities(enabled.map(id => ({ id, provider: { readiness: () => "ready" } })), enabled).snapshot();
const client = new BriefConversationClient({
  capabilities: async () => capabilities, tabs: async () => repository.tabs(), create: async () => repository.create(),
  select: async (id: string | null) => repository.activate(id), tab: async (id: string, open: boolean) => repository.setOpen(id, open),
  history: async (id: string) => repository.messages(id),
});
const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
let cancelCalls = 0; client.cancel = () => { cancelCalls++; };
function Harness() {
  const status = React.useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const state = React.useSyncExternalStore(client.store.subscribe, client.store.getSnapshot, client.store.getSnapshot);
  const binding = bindConversationTabs({ status, state, client }, "live");
  return <ConversationTabStrip mode="live" binding={binding} panelId="compatibility-panel" reducedMotion/>;
}
async function click(selector: string) {
  const element = host.querySelector<HTMLButtonElement>(selector); assert.ok(element, selector);
  await React.act(async () => { element.click(); for(let i=0;i<10;i++) await Bun.sleep(1); });
}
function assertRetained(id: string, expected: unknown) {
  const chat = client.store.getSnapshot().conversations[id];
  assert.deepEqual({ draft: chat.draft, messages: chat.messages.map((m: { content: string }) => m.content), scroll: chat.scroll, attachments: chat.attachments }, expected);
}
try {
  await client.start(); const left = await client.add(), right = await client.add();
  const input = { conversationId: left, turnId: "turn-existing", requestId: "request-existing", text: "Original question", speak: false };
  turns.accept(input); turns.start(input); turns.text(input, "Original retained answer"); turns.finish(input, "completed");
  await client.loadOlder(left); client.store.setDraft(left, "Unsaved General draft");
  client.store.setScroll(left, { top: 140, atBottom: false });
  const attachments = [{ attachmentId: "reference", name: "notes.txt", size: 123, mediaType: "text/plain" }];
  client.store.setAttachments(left, attachments); await client.select(left);
  const expected = { draft: "Unsaved General draft", messages: ["Original question", "Original retained answer"], scroll: { top: 140, atBottom: false }, attachments };
  await React.act(async () => root.render(<Harness/>));
  for(let i=0;i<10;i++) {
    await click('[aria-label="New conversation"]'); const added=client.store.getSnapshot().activeId;
    assert.notEqual(added,left); assert.notEqual(added,right);
    await React.act(async () => client.store.setDraft(added,`New draft ${i}`));
    await click(`[data-chat-id="${added}"] .brief-chat-tab-close`);
    assert.equal(client.store.getSnapshot().activeId,right); assert.equal(client.store.getSnapshot().conversations[added].draft,`New draft ${i}`);
    assertRetained(left,expected);
  }
  await click(`[data-chat-id="${left}"] [role="tab"]`);
  await click(`[data-chat-id="${left}"] .brief-chat-tab-close`); assert.equal(client.store.getSnapshot().activeId,right);
  await React.act(async () => client.reopen(left)); assertRetained(left,expected);
  await click(`[data-chat-id="${right}"] .brief-chat-tab-close`); assert.equal(client.store.getSnapshot().activeId,left);
  await click(`[data-chat-id="${left}"] .brief-chat-tab-close`); assert.equal(client.store.getSnapshot().activeId,null);
  assert.equal(host.querySelectorAll('[role="tab"]').length,0); assert.ok(host.querySelector('[aria-label="New conversation"]'));
  assert.equal(repository.list({ limit: 100 }).items.length,12); assert.equal(cancelCalls,0);
  console.log("PASS F-04 actual client/store + D-12 mounted strip: ten add/close cycles, retained history/draft/scroll/attachments, reopen, adjacent and final selection, no cancellation, 12 retained histories.");
} finally {
  await React.act(async () => root.unmount()); client.stop(); closeDb(); host.remove(); GlobalRegistrator.unregister();
}
