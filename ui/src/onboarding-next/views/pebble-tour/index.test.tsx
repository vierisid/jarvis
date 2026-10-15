import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PebbleTourIntent, PebbleTourSurfaceProps, PebbleTourViewProps } from "./index";

let act: typeof import("react").act;
let useState: typeof import("react").useState;
let createRoot: typeof import("react-dom/client").createRoot;
let View: typeof import("./index").PebbleTourView;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement;
let props: PebbleTourViewProps;
let intents: PebbleTourIntent[];
let opens: boolean[];
let surfaceProps: PebbleTourSurfaceProps;
let effects = 0;
const originalFetch = globalThis.fetch;
const originalSocket = globalThis.WebSocket;
const originalAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act, useState } = await import("react")); ({ createRoot } = await import("react-dom/client"));
  ({ PebbleTourView: View } = await import("./index"));
  globalThis.fetch = Object.assign(async () => { effects++; throw new Error("Unexpected network"); }, { preconnect: originalFetch.preconnect });
  globalThis.WebSocket = class { constructor() { effects++; throw new Error("Unexpected socket"); } } as never;
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); });
afterAll(() => { globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalAct; GlobalRegistrator.unregister(); });

function Surface(p: PebbleTourSurfaceProps) {
  surfaceProps = p;
  const [draft, setDraft] = useState(0);
  return <div data-room="today" data-selection="follow-up"><button onClick={() => setDraft(n => n + 1)}>Unsent draft {draft}</button>
    <button onClick={() => p.onOpenChange(!p.open)}>{p.open ? "Close conversation" : "Open conversation"}</button></div>;
}
async function mount(overrides: Partial<PebbleTourViewProps> = {}) {
  intents = []; opens = []; effects = 0;
  props = { model: { sessionId: "journey-1", revision: 1, phase: "ready", theme: "light", sidebar: "expanded" },
    adapter: { isolation: "tutorial-sandbox", status: "ready", open: false, Surface, onOpenChange: value => opens.push(value) },
    onNavigate: intent => { intents.push(intent); }, ...overrides };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); await render();
}
async function render() { await act(async () => root!.render(<View {...props} />)); }
function button(text: string) { const el = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === text); if (!el) throw new Error(`Missing ${text}`); return el; }
async function click(text: string) { await act(async () => button(text).click()); }
async function open(value: boolean) { props.adapter = { ...props.adapter!, open: value }; await render(); }

test("closed card uses approved copy and requests the existing shell without optimistic advancement", async () => {
  await mount(); expect(host.querySelector("h2")?.textContent).toBe("A conversation beside your work.");
  expect(document.activeElement).toBe(button("Open Pebble"));
  await click("Open Pebble"); expect(opens).toEqual([true]); expect(intents).toEqual([]);
  expect(host.querySelector("h2")?.textContent).toBe("A conversation beside your work.");
  await open(true); expect(host.querySelector("h2")?.textContent).toBe("Your work makes room for the conversation.");
  // Main has one Talk thread; the copy must not promise conversation tabs.
  expect(host.querySelector(".on-pebble-tour__body")?.textContent).toBe("Chat stays beside the page. Close Pebble to return to the full workspace.");
  expect(host.textContent).not.toContain("Skip tour");
  await click("Let’s build your first workflow");
  expect(intents).toEqual([{ sessionId: "journey-1", revision: 1, from: "pebble", action: "next", to: "first-workflow" }]);
  expect(effects).toBe(0);
});
test("ten close/reopen cycles retain room, selected object, surface instance and local draft", async () => {
  await mount(); const room = host.querySelector("[data-room]"); const primary = button("Open Pebble");
  await click("Unsent draft 0");
  for (let i = 0; i < 10; i++) {
    await click("Open Pebble"); await open(true); await click("Close conversation"); await open(false);
    expect(host.querySelector("[data-room]")).toBe(room); expect(room?.getAttribute("data-selection")).toBe("follow-up");
    expect(button("Unsent draft 1")).toBeDefined(); expect(button("Open Pebble")).toBe(primary);
  }
  expect(opens).toEqual(Array.from({ length: 10 }, () => [true, false]).flat()); expect(intents).toEqual([]); expect(effects).toBe(0);
});
test.each(["light", "dark"] as const)("%s appearance/sidebar changes keep the mounted open conversation", async theme => {
  await mount(); await open(true); const room = host.querySelector("[data-room]"); await click("Unsent draft 0");
  props.model = { ...props.model, theme, sidebar: "rail" }; await render();
  expect(host.querySelector("[data-theme]")?.getAttribute("data-theme")).toBe(theme);
  expect(host.querySelector("[data-sidebar]")?.getAttribute("data-sidebar")).toBe("rail");
  expect(host.querySelector("[data-room]")).toBe(room); expect(button("Unsent draft 1")).toBeDefined(); expect(surfaceProps.open).toBe(true);
});
test("reduced motion is forwarded to the real layout, not independently animated", async () => {
  await mount({ reducedMotion: true }); expect(surfaceProps.reducedMotion).toBe(true);
  await open(true); expect(surfaceProps.reducedMotion).toBe(true); expect(effects).toBe(0);
});
test.each(["loading", "unsupported", "error"] as const)("%s adapter cannot open/advance but permits back and skip", async status => {
  await mount(); props.adapter = { ...props.adapter!, status, open: true }; await render();
  await click("Open Pebble"); expect(opens).toEqual([]); expect(button("Open Pebble").getAttribute("aria-disabled")).toBe("true");
  await click("Back"); expect(intents[0]?.to).toBe("billing");
});
test("missing adapter fallback is truthful and skip hands off without completing onboarding", async () => {
  await mount({ adapter: undefined }); expect(host.textContent).toContain("preview is unavailable");
  expect(document.activeElement).toBe(host.querySelector("h2")); await click("Open Pebble"); expect(opens).toEqual([]);
  await click("Skip tour"); expect(intents[0]?.action).toBe("skip"); expect(intents[0]?.to).toBe("first-workflow");
});
test("an incorrectly isolated adapter never renders", async () => {
  await mount(); props.adapter = { ...props.adapter!, isolation: "live" as never }; await render();
  expect(host.querySelector("[data-room]")).toBeNull(); expect(button("Open Pebble").getAttribute("aria-disabled")).toBe("true");
});
test("late adapter readiness recovers entry focus", async () => {
  await mount({ adapter: undefined });
  props.adapter = { isolation: "tutorial-sandbox", status: "ready", open: false, Surface, onOpenChange: value => opens.push(value) }; await render();
  expect(document.activeElement).toBe(button("Open Pebble"));
});
test("late readiness does not steal focus after the user leaves the fallback title", async () => {
  await mount({ adapter: undefined }); button("Back").focus(); host.querySelector<HTMLElement>("h2")!.focus();
  props.adapter = { isolation: "tutorial-sandbox", status: "ready", open: false, Surface, onOpenChange: value => opens.push(value) }; await render();
  expect(document.activeElement).toBe(host.querySelector("h2"));
});
test("double activation emits once, promise resolution waits for authoritative revision", async () => {
  await mount({ onNavigate: async intent => { intents.push(intent); } }); await open(true);
  const next = button("Let’s build your first workflow"); await act(async () => { next.click(); next.click(); });
  expect(intents.length).toBe(1); await click("Back"); expect(intents.length).toBe(1);
  props.model = { ...props.model, revision: 2 }; await render(); await click("Back"); expect(intents.length).toBe(2);
});
test.each(["throw", "reject"] as const)("%s navigation recovers locally", async failure => {
  await mount({ onNavigate: () => { if (failure === "throw") throw new Error("private details"); return Promise.reject(new Error("private details")); } });
  await open(true); await click("Let’s build your first workflow");
  expect(host.textContent).toContain("The tour couldn’t continue"); expect(host.textContent).not.toContain("private details");
  expect(button("Let’s build your first workflow").getAttribute("aria-disabled")).toBe("false");
});
test("stale rejection cannot unlock a newer pending navigation", async () => {
  let reject!: () => void;
  await mount({ onNavigate: () => new Promise<void>((_, fail) => { reject = () => fail(new Error("old")); }) }); await click("Back");
  props.model = { ...props.model, revision: 2 }; props.onNavigate = intent => { intents.push(intent); }; await render(); await click("Back");
  await act(async () => reject()); await click("Back"); expect(intents.length).toBe(1);
  expect(host.textContent).not.toContain("couldn’t continue");
});
test("new session ignores a prior session's pending rejection", async () => {
  let reject!: () => void;
  await mount({ onNavigate: () => new Promise<void>((_, fail) => { reject = () => fail(new Error("old")); }) }); await click("Back");
  props.model = { ...props.model, sessionId: "journey-2" }; await render(); await act(async () => reject());
  expect(host.textContent).not.toContain("couldn’t continue"); expect(button("Open Pebble").getAttribute("aria-disabled")).toBe("false");
});
test("moving journey blocks all tour/shell intents", async () => {
  await mount(); props.model = { ...props.model, phase: "moving" }; await render();
  await click("Open Pebble"); await click("Open conversation"); await click("Back"); await click("Skip tour");
  expect(opens).toEqual([]); expect(intents).toEqual([]);
});
test("shell failure is local and retryable; no provider details leak", async () => {
  await mount(); props.adapter = { ...props.adapter!, onOpenChange: () => { throw new Error("secret"); } }; await render();
  await click("Open Pebble"); expect(host.textContent).toContain("Pebble couldn’t open"); expect(host.textContent).not.toContain("secret");
  props.adapter = { ...props.adapter!, onOpenChange: value => opens.push(value) }; await render(); await click("Open Pebble"); expect(opens).toEqual([true]);
});
test("closing disables forward progression again without an implicit workflow handoff", async () => {
  await mount(); await open(true); await open(false); expect(host.textContent).not.toContain("Let’s build your first workflow");
  await click("Open Pebble"); expect(intents).toEqual([]);
});
