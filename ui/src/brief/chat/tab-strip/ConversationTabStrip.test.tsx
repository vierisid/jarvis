import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { BRIEF_MOTION } from "../../motion";
import { bindConversationTabs, chatTabId, chatTabWidth, tabsMode, type ConversationTabsBinding, type ConversationTabsOwner } from "./model";

GlobalRegistrator.register({ url: "http://localhost:4392/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let ConversationTabStrip: typeof import("./ConversationTabStrip").ConversationTabStrip;
let host: HTMLDivElement, root: ReturnType<typeof createRoot>, binding: ConversationTabsBinding;
let calls: string[], reject: boolean, serial: number;
beforeAll(async () => { React = await import("react"); ({ createRoot } = await import("react-dom/client")); ({ ConversationTabStrip } = await import("./ConversationTabStrip")); });
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  calls = []; reject = false; serial = 0;
  binding = { source: "fixture", scopeId: "workspace", status: { mode: "scoped", pending: 0, error: null },
    tabs: [{ id: "a", title: "General" }, { id: "b", title: "Investor update · September milestones" }], activeId: "a",
    actions: {
      add: async () => { calls.push("add"); if (reject) throw Error("write failed"); const id = `new-${++serial}`; binding = { ...binding, tabs: [...binding.tabs, { id, title: "New chat" }], activeId: id }; },
      select: async id => { calls.push(`select:${id}`); if (reject) throw Error("write failed"); binding = { ...binding, activeId: id }; },
      close: async id => { calls.push(`close:${id}`); if (reject) throw Error("write failed"); const index = binding.tabs.findIndex(tab => tab.id === id); binding = { ...binding,
        activeId: binding.activeId === id ? binding.tabs[index + 1]?.id ?? binding.tabs[index - 1]?.id ?? null : binding.activeId,
        tabs: binding.tabs.filter(tab => tab.id !== id) }; },
    } };
});
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());
async function render(mode: "live" | "preview" = "preview", dark = false, reducedMotion = true) {
  await React.act(async () => root.render(<div className="brief-root" data-brief-theme={dark ? "dark" : "light"}>
    <ConversationTabStrip mode={mode} binding={binding} panelId="test-panel" reducedMotion={reducedMotion} />
    <div id="test-panel" role="tabpanel" aria-labelledby={binding.activeId ? chatTabId("test-panel", binding.activeId) : undefined}/>
    <textarea aria-label="Draft"/><button aria-label="Close conversation">X</button>
  </div>));
}
const tab = (id: string) => host.querySelector<HTMLButtonElement>(`[data-chat-id="${id}"] [role="tab"]`)!;
const close = (id: string) => host.querySelector<HTMLButtonElement>(`[data-chat-id="${id}"] .brief-chat-tab-close`)!;
const plus = () => host.querySelector<HTMLButtonElement>('[aria-label="New conversation"]')!;
async function click(button: HTMLButtonElement) { await React.act(async () => button.click()); await render(); }
async function key(button: HTMLButtonElement, key: string) { await React.act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))); }
async function focus(button: HTMLElement) { await React.act(async () => button.focus()); }

// Hold only tab-settlement deadlines. React, focus and animation frames still run
// normally, so the race does not depend on a CI machine completing within 180ms.
function holdTabSettlement() {
  const schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout;
  const waiting = new Map<ReturnType<typeof setTimeout>, () => void>();
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay !== BRIEF_MOTION.selection.enter) return schedule(callback, delay, ...args);
    const timer = schedule(() => {}, 60_000);
    waiting.set(timer, callback);
    return timer;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(timer => {
    waiting.delete(timer as ReturnType<typeof setTimeout>); cancel(timer as Parameters<typeof cancel>[0]);
  });
  return {
    async finish() { await React.act(async () => {
      for (const [timer, callback] of [...waiting]) { waiting.delete(timer); cancel(timer); callback(); }
    }); },
    restore() { for (const timer of waiting.keys()) cancel(timer); clear.mockRestore(); timeout.mockRestore(); },
  };
}

test("a tab closed before entry settles keeps the same inert element through its exit", async () => {
  const clock = holdTabSettlement();
  try {
    await render("preview", false, false);
    expect(host.querySelector('[data-reduced-motion="false"]')).not.toBeNull();
    await binding.actions.add(); await render("preview", false, false);
    const entering = tab("new-1"), slot = entering.closest(".brief-chat-tab-slot")!;
    await focus(entering);
    await React.act(async () => close("new-1").click()); await render("preview", false, false);
    expect(tab("new-1") === entering).toBe(true);
    expect(slot.getAttribute("data-exiting")).toBe("true");
    expect(slot.hasAttribute("inert")).toBe(true);
    expect(slot.getAttribute("aria-hidden")).toBe("true");
    expect(entering.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(tab("b"));
    await React.act(async () => close("new-1").click());
    expect(calls).toEqual(["add", "close:new-1"]);
    await clock.finish();
    expect(tab("new-1")).toBeNull(); expect(tab("b").getAttribute("aria-selected")).toBe("true");
  } finally { clock.restore(); }
});

test("rapid add-close-reopen keeps identity and a stale exit cannot remove the returned tab", async () => {
  const clock = holdTabSettlement();
  try {
    await render("preview", false, false);
    await binding.actions.add(); await render("preview", false, false);
    const entry = binding.tabs.at(-1)!, entering = tab(entry.id);
    await binding.actions.close(entry.id); await render("preview", false, false);
    expect(tab(entry.id) === entering).toBe(true);
    binding = { ...binding, tabs: [...binding.tabs, entry], activeId: entry.id };
    await render("preview", false, false);
    expect(tab(entry.id) === entering).toBe(true);
    expect(entering.closest(".brief-chat-tab-slot")!.hasAttribute("inert")).toBe(false);
    await clock.finish();
    expect(tab(entry.id) === entering).toBe(true); expect(entering.getAttribute("aria-selected")).toBe("true");
    await binding.actions.close(entry.id); await render("preview", false, false);
    expect(tab(entry.id) === entering).toBe(true);
    await clock.finish(); expect(tab(entry.id)).toBeNull();
  } finally { clock.restore(); }
});

test("reduced motion removes an interrupted entrant immediately without leaving a ghost", async () => {
  const clock = holdTabSettlement();
  try {
    await render("preview", false, false);
    await binding.actions.add(); await render("preview", false, false);
    const entering = tab("new-1");
    await binding.actions.close("new-1"); await render("preview", false, false);
    expect(tab("new-1") === entering).toBe(true);
    await render("preview", false, true);
    expect(tab("new-1")).toBeNull();
    await clock.finish();
    expect(host.querySelectorAll('[role="tab"]').length).toBe(2);
    expect(tab("b").getAttribute("aria-selected")).toBe("true");
  } finally { clock.restore(); }
});

test("F-04 structural port projects stable identities and delegates only metadata operations", async () => {
  const owner: ConversationTabsOwner = { status: binding.status, state: { workspaceId: "workspace", order: ["b", "a"], activeId: "b", conversations: { a: { conversation: { title: "A" } }, b: { conversation: { title: "B" } } } }, client: binding.actions };
  const view = bindConversationTabs(owner, "live");
  expect(view.tabs.map(tab => tab.id)).toEqual(["b", "a"]); expect(view.activeId).toBe("b");
  await view.actions.select("b"); await view.actions.close("a"); await view.actions.add();
  expect(calls).toEqual(["select:b", "close:a", "add"]);
  expect(Object.keys(view.actions).sort()).toEqual(["add", "close", "select"]);
  expect(tabsMode("live", view)).toBe("scoped"); expect(tabsMode("preview", view)).toBe("disabled");
});
test("112px minimum and ordinary widths match native starting geometry", () => {
  expect(chatTabWidth(314, 1)).toBe(314); expect(chatTabWidth(314, 2)).toBe(155);
  expect(chatTabWidth(314, 3)).toBe(112); expect(chatTabWidth(180, 20)).toBe(112);
  expect(chatTabWidth(0, 0)).toBe(112);
});
test("non-scoped and wrong-source states cannot issue tab actions or look like an empty collection", async () => {
  for (const mode of ["disabled", "loading", "legacy", "unavailable"] as const) {
    binding = { ...binding, status: { ...binding.status, mode } }; await render();
    expect(host.querySelectorAll('[role="tab"]').length).toBe(0); expect(plus()).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBeTruthy();
  }
  binding.status.mode = "scoped"; await render("live"); expect(plus()).toBeNull(); expect(calls).toEqual([]);
});
test("selected identity, panel linkage and roving focus remain separate", async () => {
  await render(); expect(tab("a").getAttribute("aria-selected")).toBe("true"); expect(tab("a").tabIndex).toBe(0); expect(tab("b").tabIndex).toBe(-1);
  expect(tab("a").getAttribute("aria-controls")).toBe("test-panel");
  await focus(tab("a")); await key(tab("a"), "ArrowRight");
  expect(document.activeElement).toBe(tab("b")); expect(tab("b").tabIndex).toBe(0); expect(tab("a").getAttribute("aria-selected")).toBe("true"); expect(calls).toEqual([]);
  await click(tab("b")); expect(binding.activeId).toBe("b"); expect(calls).toEqual(["select:b"]);
  await key(tab("b"), "Home"); expect(document.activeElement).toBe(tab("a"));
  await key(tab("a"), "End"); expect(document.activeElement).toBe(tab("b"));
  await key(tab("b"), "ArrowRight"); expect(document.activeElement).toBe(tab("a"));
  await key(tab("a"), "ArrowLeft"); expect(document.activeElement).toBe(tab("b"));
});
test("closing inactive chat dispatches its exact ID without selecting it or cancelling another chat", async () => {
  await render(); await click(close("b")); expect(binding.activeId).toBe("a"); expect(calls).toEqual(["close:b"]);
  expect(tab("a").getAttribute("aria-selected")).toBe("true");
});
test("focused active closure follows owner selection and final closure focuses plus without creating history", async () => {
  await render(); await focus(tab("a")); await key(tab("a"), "Delete"); await render();
  expect(document.activeElement).toBe(tab("b")); expect(binding.activeId).toBe("b");
  await focus(close("b")); await click(close("b"));
  expect(binding.activeId).toBeNull(); expect(host.querySelectorAll('[role="tab"]').length).toBe(0);
  expect(document.activeElement).toBe(plus()); expect(calls).toEqual(["close:a", "close:b"]);
});
test("background removal cannot steal composer focus", async () => {
  await render(); await focus(tab("b")); await focus(host.querySelector("textarea")!);
  binding = { ...binding, tabs: binding.tabs.slice(0, 1) }; await render();
  expect(document.activeElement).toBe(host.querySelector("textarea"));
});
test("ten add/close cycles leave surviving tab identities and selected chat intact", async () => {
  await render();
  for (let i = 0; i < 10; i++) {
    await click(plus()); const id = binding.activeId!; expect(id).toBe(`new-${i + 1}`);
    expect(tab(id).tabIndex).toBe(0);
    await click(close(id)); expect(binding.activeId).toBe("b");
    expect(binding.tabs.map(tab => tab.id)).toEqual(["a", "b"]);
    await click(tab("a")); await render("preview", i % 2 === 0); expect(binding.activeId).toBe("a");
  }
  expect(calls.filter(call => call === "add").length).toBe(10); expect(calls.some(call => call.includes("cancel"))).toBe(false);
});
test("duplicate titles, long names and remote reorder retain ID-specific close targets", async () => {
  binding = { ...binding, tabs: [{ id: "other", title: "General" }, ...binding.tabs] }; await render();
  await click(close("other")); expect(calls).toEqual(["close:other"]); expect(binding.activeId).toBe("a");
  binding = { ...binding, tabs: [...binding.tabs].reverse() }; await render();
  expect([...host.querySelectorAll('[role="tab"]')].map(node => node.id)).toEqual([chatTabId("test-panel", "b"), chatTabId("test-panel", "a")]);
  expect(tab("b").getAttribute("aria-label")).toBe("Investor update · September milestones");
});
test("failed writes preserve tabs and focus, report locally and allow a retry", async () => {
  reject = true; await render(); await focus(close("a")); await click(close("a"));
  expect(binding.tabs.length).toBe(2); expect(binding.activeId).toBe("a"); expect(document.activeElement).toBe(close("a"));
  expect(host.querySelector('[role="status"]')?.textContent).toContain("failed");
  reject = false; await click(close("a")); expect(binding.activeId).toBe("b"); expect(host.querySelector('[role="status"]')?.textContent).toBe("");
});
test("pending writes block repeated clicks and owner pending counts are respected", async () => {
  let finish!: () => void;
  binding.actions.add = () => { calls.push("add"); return new Promise<void>(resolve => { finish = resolve; }); };
  await render(); await React.act(async () => { plus().click(); plus().click(); close("a").click(); });
  expect(calls).toEqual(["add"]); expect(plus().getAttribute("aria-disabled")).toBe("true");
  await React.act(async () => finish());
  binding.status.pending = 1; await render(); await click(plus()); expect(calls).toEqual(["add"]);
});
test("mode loss/unmount during a write cannot apply a stale local confirmation", async () => {
  let fail!: () => void;
  binding.actions.add = () => new Promise<void>((_, reject) => { fail = () => reject(Error("late")); });
  await render(); await React.act(async () => plus().click()); binding.status.mode = "legacy"; await render();
  await React.act(async () => fail()); expect(host.textContent).not.toContain("failed"); expect(plus()).toBeNull();
});
test("a replacement workspace does not inherit a pending lock or late error", async () => {
  let fail!: () => void;
  binding.actions.add = () => new Promise<void>((_, reject) => { fail = () => reject(Error("old workspace")); });
  await render(); await React.act(async () => plus().click());
  binding = { ...binding, scopeId: "new-workspace" }; await render();
  expect(plus().getAttribute("aria-disabled")).toBe("false");
  await React.act(async () => fail()); expect(host.querySelector('[role="status"]')?.textContent).toBe("");
  binding = { ...binding, scopeId: null }; await render(); expect(plus()).toBeNull();
  expect(host.querySelector('[data-tabs-mode="unavailable"]')).not.toBeNull();
});
