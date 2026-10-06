import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { bindConversationComposer, composerAvailability, draftError, type ComposerBinding, type ComposerOwner } from "./model";

GlobalRegistrator.register({ url: "http://localhost:4393/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let ConversationComposer: typeof import("./ConversationComposer").ConversationComposer;
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, binding: ComposerBinding;
let calls: string[];
const suggestions = [{ id: "call", label: "Prepare a call", text: "Prepare my next call with Alex." }];
beforeAll(async () => { React = await import("react"); ({ createRoot } = await import("react-dom/client")); ({ ConversationComposer } = await import("./ConversationComposer")); });
beforeEach(() => {
  calls = []; host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  binding = { source: "fixture", scopeId: "workspace", conversationId: "a", mode: "scoped", connected: true, metadataPending: false,
    draft: "", turn: null, pendingAcceptance: false, error: null, maxBytes: 65_536,
    actions: { setDraft: text => { calls.push(`draft:${text}`); binding = { ...binding, draft: text }; },
      send: text => { calls.push(`send:${text}`); }, cancel: () => { calls.push("cancel:a"); } } };
});
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());
async function render(mode: "live" | "preview" = "preview", dark = false) {
  await React.act(async () => root.render(<div className="brief-root" data-brief-theme={dark ? "dark" : "light"}>
    <ConversationComposer mode={mode} binding={binding} suggestions={suggestions} reducedMotion />
  </div>));
}
const input = () => host.querySelector("textarea")!;
const send = () => host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!;
const stop = () => host.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!;
const suggestion = () => host.querySelector<HTMLButtonElement>('.brief-composer-suggestions button')!;
const status = () => host.querySelector('[role="status"]')!.textContent;
async function click(button: HTMLButtonElement) { await React.act(async () => button.click()); await render(); }
async function key(options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
  await React.act(async () => input().dispatchEvent(event)); return event;
}
async function composition(type: "compositionstart" | "compositionend") {
  await React.act(async () => input().dispatchEvent(new CompositionEvent(type, { bubbles: true, data: "你好" })));
}

test("F-04 binding captures the selected conversation and exact cancellation reference", () => {
  const ref = { conversationId: "a", turnId: "turn-a", requestId: "request-a" };
  const operations: unknown[] = [];
  const owner: ComposerOwner = { status: { mode: "scoped", connected: true, pending: 0, pendingSends: [] },
    state: { workspaceId: "ws", activeId: "a", order: ["a", "b"], conversations: {
      a: { draft: "A", error: null, turns: { "turn-a": { ...ref, state: "running" } } }, b: { draft: "B", error: null, turns: {} } } },
    client: { store: { setDraft: (id, text) => operations.push(["draft", id, text]), dismissError: id => operations.push(["clear-error", id]) }, send: (id, text) => operations.push(["send", id, text]), cancel: ref => operations.push(["cancel", ref]) } };
  const view = bindConversationComposer(owner, "live"); owner.state.activeId = "b";
  view.actions.setDraft("new A"); view.actions.send("A"); view.actions.cancel();
  expect(operations).toEqual([["draft", "a", "new A"], ["send", "a", "A"], ["clear-error", "a"], ["cancel", ref]]);
  expect(view.maxBytes).toBe(65_536); expect(view.draft).toBe("A"); expect(view.turn).toMatchObject(ref);
  const next = bindConversationComposer(owner, "live"); expect(next.turn).toBeNull(); expect(() => next.actions.cancel()).toThrow();
});

test("a pending acceptance is cancellable by its original IDs and other chats cannot supply the turn", () => {
  const a = { conversationId: "a", turnId: "ta", requestId: "ra" }, b = { conversationId: "b", turnId: "tb", requestId: "rb" };
  const refs: unknown[] = [];
  const owner: ComposerOwner = { status: { mode: "scoped", connected: true, pending: 0, pendingSends: [b, a] },
    state: { workspaceId: "ws", activeId: "a", order: ["a"], conversations: { a: { draft: "Draft", error: null, turns: {} } } },
    client: { store: { setDraft() {}, dismissError() {} }, send() {}, cancel: ref => refs.push(ref) } };
  const view = bindConversationComposer(owner, "live"); view.actions.cancel(); expect(refs).toEqual([a]); expect(view.pendingAcceptance).toBe(true);
  owner.state.order = []; expect(composerAvailability("live", bindConversationComposer(owner, "live"))).toBe("empty");
  expect(() => bindConversationComposer(owner, "live").actions.send("No chat")).toThrow();
});

test("wrong sources, absent scope and non-scoped modes expose no writing or send action", async () => {
  await render("live"); expect(input()).toBeNull(); expect(calls).toEqual([]);
  for (const mode of ["loading", "unavailable", "legacy", "disabled"] as const) {
    binding = { ...binding, mode }; await render(); expect(input()).toBeNull(); expect(status()).toBeTruthy();
  }
  binding = { ...binding, mode: "scoped", scopeId: null }; await render(); expect(input()).toBeNull();
  binding = { ...binding, scopeId: "ws", conversationId: null }; await render(); expect(status()).toBe("Open a conversation to write.");
});

test("suggestions prefill and focus, preserving existing writing and never sending", async () => {
  await render(); await click(suggestion());
  expect(input().value).toBe(suggestions[0]!.text); expect(document.activeElement).toBe(input());
  await click(suggestion()); expect(input().value).toBe(`${suggestions[0]!.text}\n${suggestions[0]!.text}`);
  expect(calls.every(call => call.startsWith("draft:"))).toBe(true);
});

test("blank writing is inactive, Enter sends once, and Shift+Enter stays a newline", async () => {
  await render(); expect(send().getAttribute("aria-disabled")).toBe("true"); await click(send()); expect(calls).toEqual([]);
  binding = { ...binding, draft: "  \n " }; await render(); await key(); expect(calls).toEqual([]);
  binding = { ...binding, draft: "A real question" }; await render();
  expect((await key({ shiftKey: true })).defaultPrevented).toBe(false); expect(calls).toEqual([]);
  expect((await key()).defaultPrevented).toBe(true); expect(calls).toEqual(["send:A real question"]);
  expect(input().value).toBe("A real question");
});

test("IME composition, native composing and keyCode 229 cannot send prematurely", async () => {
  binding.draft = "你好"; await render();
  await composition("compositionstart"); await key(); await click(send()); await click(suggestion()); expect(calls).toEqual([]);
  await composition("compositionend"); await key(); expect(calls).toEqual([]);
  await Bun.sleep(36);
  await key({ isComposing: true }); await key({ keyCode: 229 }); await key({ repeat: true }); expect(calls).toEqual([]);
  await key(); expect(calls).toEqual(["send:你好"]);
});

test("send preserves exact text and keeps the draft until the owner accepts it", async () => {
  binding.draft = "  line one\nline two  "; await render(); await click(send());
  expect(calls).toEqual(["send:  line one\nline two  "]); expect(input().value).toBe(binding.draft);
  binding = { ...binding, draft: "" }; await render(); expect(input().value).toBe("");
});

test("async send is deduplicated and a newer draft is never cleared by its completion", async () => {
  let finish!: () => void; binding.draft = "Original";
  binding.actions.send = text => { calls.push(`send:${text}`); return new Promise<void>(resolve => { finish = resolve; }); };
  await render(); await React.act(async () => { send().click(); send().click(); });
  expect(calls).toEqual(["send:Original"]); expect(status()).toBe("Sending…");
  binding = { ...binding, draft: "A newer question" }; await render();
  await React.act(async () => finish()); expect(input().value).toBe("A newer question");
});

test("failed sending preserves draft, reports locally and permits a deliberate retry", async () => {
  binding.draft = "Keep this"; binding.actions.send = () => { calls.push("failed"); throw Error("Provider internals must not leak"); };
  await render(); await click(send()); expect(input().value).toBe("Keep this"); expect(status()).toBe("Could not send. Your draft is still here.");
  binding.actions.send = text => calls.push(`send:${text}`); await click(send()); expect(status()).toBe(""); expect(calls).toEqual(["failed", "send:Keep this"]);
});

test("active turns show Stop and cannot be resubmitted through Enter", async () => {
  binding.draft = "Next question"; binding.turn = { conversationId: "a", turnId: "t", requestId: "r" };
  await render(); expect(send()).toBeNull(); await key(); expect(calls).toEqual([]); await click(stop()); expect(calls).toEqual(["cancel:a"]);
  expect(input().value).toBe("Next question"); expect(status()).toBe("Stopping response…");
});

test("synchronous cancellation dispatch keeps feedback until the matching turn ends and permits retry", async () => {
  binding.draft = "Next question"; binding.turn = { conversationId: "a", turnId: "t", requestId: "r" };
  await render(); await click(stop());
  expect(status()).toBe("Stopping response…"); await render(); expect(status()).toBe("Stopping response…");
  const retry = host.querySelector<HTMLButtonElement>('[aria-label="Retry stop"]')!;
  expect(retry).not.toBeNull(); expect(retry.getAttribute("aria-disabled")).toBe("false");
  await click(retry); expect(calls).toEqual(["cancel:a", "cancel:a"]); expect(status()).toBe("Stopping response…");
  binding = { ...binding, turn: null }; await render();
  expect(status()).toBe(""); expect(send().getAttribute("aria-disabled")).toBe("false"); expect(input().value).toBe("Next question");
});

test("owner cancellation failure permits retry, and disconnect does not claim the turn stopped", async () => {
  binding.turn = { conversationId: "a", turnId: "t", requestId: "r" };
  await render(); await click(stop());
  binding = { ...binding, error: "Stop was not accepted." }; await render();
  expect(status()).toBe("Stop was not accepted."); expect(stop().getAttribute("aria-disabled")).toBe("false");
  await click(stop()); expect(status()).toBe("Stopping response…");
  binding = { ...binding, connected: false }; await render(); expect(status()).toContain("Reconnecting");
  expect(stop().getAttribute("aria-disabled")).toBe("true");
  binding = { ...binding, connected: true }; await render();
  expect(stop().getAttribute("aria-disabled")).toBe("false"); expect(binding.turn).not.toBeNull();
});

test("a new turn cannot inherit a previous stop lock or its late dispatch failure", async () => {
  let fail!: () => void;
  binding.turn = { conversationId: "a", turnId: "old", requestId: "old-request" };
  binding.actions.cancel = () => new Promise<void>((_, reject) => { fail = () => reject(Error("late stop failure")); });
  await render(); await React.act(async () => stop().click()); expect(status()).toBe("Stopping response…");
  binding = { ...binding, turn: { conversationId: "a", turnId: "new", requestId: "new-request" },
    actions: { ...binding.actions, cancel: () => { calls.push("cancel:new"); } } }; await render();
  expect(status()).toBe(""); expect(stop().getAttribute("aria-disabled")).toBe("false");
  await click(stop()); await React.act(async () => fail());
  expect(status()).toBe("Stopping response…"); expect(calls).toEqual(["cancel:new"]);
});

test("a repeated owner failure with identical wording ends the new stop intent after error dismissal", async () => {
  binding.turn = { conversationId: "a", turnId: "t", requestId: "r" }; binding.error = "Stop unavailable";
  binding.actions.cancel = () => { binding = { ...binding, error: null }; };
  await render(); await click(stop()); expect(status()).toBe("Stopping response…");
  binding = { ...binding, error: "Stop unavailable" }; await render();
  expect(status()).toBe("Stop unavailable"); expect(stop().getAttribute("aria-disabled")).toBe("false");
  await click(stop()); expect(status()).toBe("Stopping response…");
  binding = { ...binding, error: "Stop unavailable" }; await render();
  expect(status()).toBe("Stop unavailable"); expect(stop().getAttribute("aria-disabled")).toBe("false");
});

test("a pending stop has local feedback and a failed stop does not claim completion", async () => {
  let fail!: () => void; binding.turn = { conversationId: "a", turnId: "t", requestId: "r" };
  binding.actions.cancel = () => { calls.push("stop"); return new Promise<void>((_, reject) => { fail = () => reject(Error("failed")); }); };
  await render(); await React.act(async () => stop().click()); expect(status()).toBe("Stopping response…");
  const pending = host.querySelector<HTMLButtonElement>('[aria-label="Stopping response"]')!;
  expect(pending.getAttribute("aria-disabled")).toBe("true"); await React.act(async () => pending.click()); expect(calls).toEqual(["stop"]);
  await React.act(async () => fail()); expect(status()).toBe("Could not stop the response. Try again."); expect(stop()).not.toBeNull();
});

test("offline and metadata-pending states block sends while keeping the existing draft", async () => {
  binding.draft = "Stored draft"; binding.connected = false; await render(); await click(send()); expect(calls).toEqual([]); expect(input().value).toBe("Stored draft"); expect(status()).toContain("Reconnecting");
  binding = { ...binding, connected: true, metadataPending: true }; await render(); await click(send()); await click(suggestion()); expect(calls).toEqual([]);
  binding = { ...binding, metadataPending: false }; await render(); await click(send()); expect(calls).toEqual(["send:Stored draft"]);
});

test("UTF-8 limit is validated without truncating multibyte writing", async () => {
  expect(draftError("你好", 6)).toBeNull(); expect(draftError("你好", 5)).not.toBeNull();
  binding = { ...binding, draft: "你好", maxBytes: 5 }; await render(); await click(send());
  expect(input().value).toBe("你好"); expect(input().getAttribute("aria-invalid")).toBe("true"); expect(calls).toEqual([]);
});

test("switching conversations or workspace cannot inherit a pending lock or late error", async () => {
  let fail!: () => void; binding.draft = "A";
  binding.actions.send = () => new Promise<void>((_, reject) => { fail = () => reject(Error("Late A")); });
  await render(); await React.act(async () => send().click());
  binding = { ...binding, conversationId: "b", draft: "B", actions: { ...binding.actions, send: text => calls.push(`send:${text}`) } }; await render();
  await React.act(async () => fail()); expect(status()).toBe(""); expect(send().getAttribute("aria-disabled")).toBe("false"); await click(send()); expect(calls).toEqual(["send:B"]);
  binding = { ...binding, scopeId: "new-workspace", draft: "New scope" }; await render(); expect(status()).toBe(""); expect(input().value).toBe("New scope");
});

test("theme changes preserve the input element, focus, value and selection", async () => {
  binding.draft = "Keep this draft"; await render(); const original = input(); original.focus(); original.setSelectionRange(2, 7);
  await render("preview", true); expect(input() === original).toBe(true); expect(document.activeElement === original).toBe(true);
  expect(original.selectionStart).toBe(2); expect(original.selectionEnd).toBe(7); expect(original.value).toBe("Keep this draft");
});

test("composer has the fixed attachment seam without inventing an upload action", async () => {
  await render(); const attachment = host.querySelector<HTMLButtonElement>('[aria-label="Add attachment"]')!;
  expect(attachment.getAttribute("aria-disabled")).toBe("true"); await click(attachment); expect(calls).toEqual([]);
  expect(host.textContent).not.toContain("Goals and memory"); expect(host.querySelector('input[type="file"]')).toBeNull();
});
