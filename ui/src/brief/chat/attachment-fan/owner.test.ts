import { afterEach, test } from "bun:test";
import { strict as assert } from "node:assert";
import { initDatabase, getDb, closeDb } from "../../../../../src/vault/schema";
import { ConversationRepository } from "../../../../../src/vault/conversation-lifecycle";
import { BriefCapabilities } from "../../../../../src/brief/capabilities";
import { BriefConversationClient } from "../client";
import type { ConversationApi } from "../api";
import type { AttachmentApi } from "../attachments";
import { bindAttachmentFan, type AttachmentOwner, type AttachmentPickers } from "./model";

// Compile-time guard: the F-05 client must satisfy the fan's structural port,
// so bindAttachmentFan(client, pickers, "live") keeps type-checking.
const ownerFromClient = (client: BriefConversationClient): AttachmentOwner => client;
void ownerFromClient;

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); closeDb(); });

// Drives the real F-05 client, store and DraftAttachments with in-memory repositories and a
// synthetic attachment API. No real upload, capture or model call.
test("the fan delegates to the real F-05 DraftAttachments flow and keeps its conversation", async () => {
  initDatabase(":memory:", { quiet: true });
  const repository = new ConversationRepository(getDb());
  const enabled = ["conversations", "chatTransport", "chatState", "chatAttachments"] as const;
  const capabilities = new BriefCapabilities(enabled.map(id => ({ id, provider: { readiness: () => "ready" as const } })), enabled).snapshot();
  const api: ConversationApi = {
    capabilities: async () => capabilities, tabs: async () => repository.tabs(),
    create: async () => repository.create(), tab: async (id, open) => repository.setOpen(id, open),
    select: async id => repository.activate(id), history: async (id, cursor) => repository.messages(id, { cursor: cursor ?? undefined, limit: 50 }),
  };
  const uploads: Array<{ c: string; kind: string; name: string }> = [], captures: Array<{ c: string; deviceId: string }> = [];
  const ref = (c: string, id: string, kind: "document" | "image" | "screenshot", name: string, mediaType: string, size: number) =>
    ({ conversationId: c, attachmentId: id, kind, name, mediaType, size, sha256: "fixture", expiresAt: Date.now() + 60_000, state: "ready" as const, turnId: null });
  const files: AttachmentApi = {
    get: async () => { throw new Error("No restored fixture"); },
    remove: async (c, id) => ({ ...ref(c, id, "document", "note.txt", "text/plain", 4), state: "removed" as const }),
    upload: async (c, id, kind, file) => { uploads.push({ c, kind, name: file.name }); return ref(c, id, kind, file.name, file.type, file.size); },
    capture: async (c, id, deviceId) => { captures.push({ c, deviceId }); return ref(c, id, "screenshot", "Screenshot.png", "image/png", 4); },
  };
  const client = new BriefConversationClient(api, undefined, files);
  cleanups.push(() => client.stop());
  const file = new File(["synthetic notes"], "note.txt", { type: "text/plain" });
  const pickers: AttachmentPickers = { file: async () => file, screenshot: async () => ({ deviceId: "fixture-desktop", confirmed: true }), screenshotAvailability: { available: true } };
  const signal = () => new AbortController().signal;
  const items = (id: string) => client.store.getSnapshot().conversations[id]!.attachments ?? [];

  await client.start();
  const a = await client.add(), b = await client.add();
  await client.select(a);
  client.adapter.onOpen({ readyState: 1, send: () => {} } as never);
  for (let i = 0; !client.getSnapshot().connected && i < 1000; i++) await Bun.sleep(1);
  assert.equal(client.getSnapshot().connected, true);
  client.store.setDraft(a, "Keep A"); client.store.setDraft(b, "Keep B");

  // The conversation is captured before the picker; switching chats during it does not move the file.
  let release!: (file: File | null) => void;
  pickers.file = () => new Promise(resolve => { release = resolve; });
  const selection = bindAttachmentFan(client, pickers, "live").choose("document", signal());
  await client.select(b); release(file);
  assert.equal(await selection, "attached");
  assert.equal(items(a)[0]!.name, "note.txt");
  assert.equal(items(b).length, 0);
  assert.equal(uploads[0]!.c, a);
  assert.equal(client.store.getSnapshot().conversations[a]!.draft, "Keep A");
  assert.equal(client.store.getSnapshot().conversations[b]!.draft, "Keep B");

  // F-05's own size limit still applies; the fan does not bypass it.
  pickers.file = async () => new File([], "empty.txt", { type: "text/plain" });
  await assert.rejects(() => bindAttachmentFan(client, pickers, "live").choose("document", signal()));
  assert.equal(uploads.length, 1);

  pickers.file = async () => new File(["fixture pixels"], "image.png", { type: "image/png" });
  await bindAttachmentFan(client, pickers, "live").choose("image", signal());
  assert.equal(items(b)[0]!.kind, "image");

  pickers.screenshotAvailability.available = false;
  await assert.rejects(() => bindAttachmentFan(client, pickers, "live").choose("screenshot", signal()));
  assert.equal(captures.length, 0);
  pickers.screenshotAvailability.available = true;
  pickers.screenshot = async () => null;
  assert.equal(await bindAttachmentFan(client, pickers, "live").choose("screenshot", signal()), "cancelled");
  assert.equal(captures.length, 0);
  pickers.screenshot = async () => ({ deviceId: "fixture-desktop", confirmed: true });
  await bindAttachmentFan(client, pickers, "live").choose("screenshot", signal());
  assert.deepEqual(captures, [{ c: b, deviceId: "fixture-desktop" }]);
  assert.equal(items(b)[1]!.kind, "screenshot");

  // A file chosen after its chat closed during the picker is refused, not uploaded.
  await client.select(a);
  pickers.file = () => new Promise(resolve => { release = resolve; });
  const closed = bindAttachmentFan(client, pickers, "live").choose("document", signal());
  await client.close(a); release(file);
  await assert.rejects(() => closed);
  assert.equal(uploads.length, 2);
});
