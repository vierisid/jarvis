import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { initDatabase, getDb, closeDb } from "../../../../../src/vault/schema";
import { ConversationRepository } from "../../../../../src/vault/conversation-lifecycle";
import { BriefCapabilities } from "../../../../../src/brief/capabilities";
import type { useBriefConversation } from "../provider";
import { BriefConversationClient } from "../client";
import type { ConversationApi } from "../api";
import { bindConversationTabs, type ConversationTabsOwner } from "./model";

// Compile-time guard: the F-04 provider's value must satisfy the structural port,
// so bindConversationTabs(useBriefConversation(), "live") keeps type-checking.
const ownerFromProvider = (thread: ReturnType<typeof useBriefConversation>): ConversationTabsOwner => thread;
void ownerFromProvider;

GlobalRegistrator.register({ url: "http://localhost:4392/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let ConversationTabStrip: typeof import("./ConversationTabStrip").ConversationTabStrip;
beforeAll(async () => { React = await import("react"); ({ createRoot } = await import("react-dom/client")); ({ ConversationTabStrip } = await import("./ConversationTabStrip")); });
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); closeDb(); });
afterAll(() => GlobalRegistrator.unregister());

test("the strip drives the real F-04 client: add, close and final close keep history and never cancel", async () => {
  initDatabase(":memory:", { quiet: true });
  const repository = new ConversationRepository(getDb());
  const enabled = ["conversations", "chatTransport", "chatState"] as const;
  const capabilities = new BriefCapabilities(enabled.map(id => ({ id, provider: { readiness: () => "ready" as const } })), enabled).snapshot();
  const api: ConversationApi = {
    capabilities: async () => capabilities, tabs: async () => repository.tabs(),
    create: async () => repository.create(), tab: async (id, open) => repository.setOpen(id, open),
    select: async id => repository.activate(id), history: async (id, cursor) => repository.messages(id, { cursor: cursor ?? undefined, limit: 50 }),
  };
  const client = new BriefConversationClient(api);
  let cancels = 0; client.cancel = () => { cancels++; };
  cleanups.push(() => client.stop());
  await client.start();
  const left = await client.add(), right = await client.add();
  client.store.setDraft(left, "Draft for Northwind");
  await client.select(left);

  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  cleanups.push(async () => { await React.act(async () => root.unmount()); host.remove(); });
  function Harness() {
    const status = React.useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
    const state = React.useSyncExternalStore(client.store.subscribe, client.store.getSnapshot, client.store.getSnapshot);
    return <ConversationTabStrip mode="live" binding={bindConversationTabs({ status, state, client }, "live")} panelId="owner-panel" reducedMotion />;
  }
  const click = async (selector: string) => {
    const element = host.querySelector<HTMLButtonElement>(selector);
    expect(element).not.toBeNull();
    await React.act(async () => { element!.click(); for (let i = 0; i < 10; i++) await Bun.sleep(1); });
  };
  await React.act(async () => root.render(<Harness />));
  expect([...host.querySelectorAll('[role="tab"]')].length).toBe(2);

  for (let i = 0; i < 3; i++) {
    await click('[aria-label="New conversation"]');
    const added = client.store.getSnapshot().activeId!;
    expect([left, right]).not.toContain(added);
    await click(`[data-chat-id="${added}"] .brief-chat-tab-close`);
    expect(client.store.getSnapshot().order).toEqual([left, right]);
    expect(client.store.getSnapshot().conversations[left]?.draft).toBe("Draft for Northwind");
  }
  // Closing the active tab selects the owner's neighbour; closing the last leaves no selection.
  await click(`[data-chat-id="${left}"] .brief-chat-tab-close`);
  expect(client.store.getSnapshot().activeId).toBe(right);
  await click(`[data-chat-id="${right}"] .brief-chat-tab-close`);
  expect(client.store.getSnapshot().activeId).toBeNull();
  expect(host.querySelectorAll('[role="tab"]').length).toBe(0);
  expect(host.querySelector('[aria-label="New conversation"]')).not.toBeNull();
  // Closed tabs keep their history (5 created, none deleted) and nothing was cancelled.
  expect(repository.list({ limit: 100 }).items.length).toBe(5);
  expect(cancels).toBe(0);
});
