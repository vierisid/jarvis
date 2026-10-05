import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { BriefRoomId, BriefShellPort } from "../../contracts";
import { BRIEF_ROOMS } from "../../rooms/registry";
import { UNKNOWN_NAVIGATION, type BriefNavigationBinding } from "../navigation/model";
import { pebbleGeometry, PEBBLE_SPLIT_MIN } from "./layout";

GlobalRegistrator.register({ url: "http://localhost:4386/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let NavigationShell: typeof import("../navigation/NavigationShell").NavigationShell;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let shell: BriefShellPort;
let binding: BriefNavigationBinding;
let enabled: boolean;
let source: "fixture" | "live";
let size = { width: 1208, height: 900 };
let observe: () => void = () => {};
let conversationMounts = 0;
let roomMounts = 0;
const realObserver = globalThis.ResizeObserver;
const realRect = HTMLElement.prototype.getBoundingClientRect;
beforeAll(async () => {
  React = await import("react"); ({ createRoot } = await import("react-dom/client"));
  ({ NavigationShell } = await import("../navigation/NavigationShell"));
  globalThis.ResizeObserver = class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { observe = () => callback([], this); }
    observe() {} unobserve() {} disconnect() {}
  };
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains("brief-pebble-layout") ? new DOMRect(232, 76, size.width, size.height) : realRect.call(this);
  };
});
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  enabled = true; source = "fixture"; size = { width: 1208, height: 900 }; conversationMounts = 0; roomMounts = 0;
  shell = { mode: "preview", route: { room: "today", selection: { runId: "run-012", factId: "fact-1" } },
    sidebar: "expanded", chatOpen: false, theme: "light",
    setSidebar: value => { shell = { ...shell, sidebar: value }; }, setChatOpen: value => { shell = { ...shell, chatOpen: value }; },
    setTheme: value => { shell = { ...shell, theme: value }; }, navigate: route => { shell = { ...shell, route }; },
  };
  binding = { capabilities: null, view: { source: "fixture", state: { status: "ready", data: UNKNOWN_NAVIGATION } } };
});
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => { globalThis.ResizeObserver = realObserver; HTMLElement.prototype.getBoundingClientRect = realRect; GlobalRegistrator.unregister(); });
function Conversation() {
  React.useEffect(() => { conversationMounts++; }, []);
  return <><div data-conversation-scroll style={{ overflow: "auto" }}>A retained response</div><textarea data-pebble-focus defaultValue="Original chat draft" aria-label="Chat draft" />
    <button onKeyDown={event => { if (event.key === "Escape") event.preventDefault(); }}>Nested choice</button></>;
}
function Room() {
  React.useEffect(() => { roomMounts++; }, []);
  const [selected, setSelected] = React.useState("node-a");
  return <><input defaultValue="Original room draft" /><button onClick={() => setSelected("node-b")}>Select node B</button><output>{selected}</output></>;
}
async function render(withConversation = true) {
  await React.act(async () => root.render(<div className="brief-root" data-brief-theme={shell.theme}>
    <NavigationShell shell={shell} rooms={BRIEF_ROOMS} binding={enabled ? binding : undefined} reducedMotion
      conversation={withConversation ? { source, content: <Conversation /> } : undefined}>
      <Room key={shell.route.room} />
    </NavigationShell>
  </div>));
}
async function click(element: HTMLElement) { await React.act(async () => element.click()); await render(); }
async function focus(element: HTMLElement) { await React.act(async () => element.focus()); }
async function key(element: HTMLElement, key: string) {
  await React.act(async () => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))); await render();
}
function opener() { return host.querySelector<HTMLButtonElement>(".brief-pebble-opener")!; }
function close() { return host.querySelector<HTMLButtonElement>(".brief-pebble-close")!; }
function panel() { return host.querySelector<HTMLElement>(".brief-pebble-surface")!; }
function main() { return host.querySelector<HTMLElement>("main")!; }

test("workspace geometry preserves room space, uses the workspace corner and has a readable single-pane fallback", () => {
  expect(pebbleGeometry(1208, 900)).toEqual({ single: false, inset: 26, panelWidth: 447, panelHeight: 848, reservedWidth: 473 });
  expect(pebbleGeometry(1368, 900).panelWidth).toBe(447);
  const compact = pebbleGeometry(318, 650);
  expect(compact).toEqual({ single: true, inset: 18, panelWidth: 282, panelHeight: 614, reservedWidth: 0 });
  expect(pebbleGeometry(PEBBLE_SPLIT_MIN, 400).single).toBe(false);
  expect(pebbleGeometry(0, 0).panelWidth).toBe(0);
});

for (const room of ["today", "workflow", "all-workflows", "memory-detail", "profile"] as BriefRoomId[]) {
  test(`${room}: twenty open/close/reopen cycles retain room, object, conversation, draft and scroll`, async () => {
    shell = { ...shell, route: { ...shell.route, room } }; await render();
    const input = host.querySelector("input")!; input.value = "An unsaved room edit";
    const chat = host.querySelector("textarea")!; chat.value = "An unsent conversation";
    const scroll = host.querySelector<HTMLElement>("[data-conversation-scroll]")!;
    const content = main(); content.scrollTop = 310; scroll.scrollTop = 125;
    await click([...host.querySelectorAll("button")].find(b => b.textContent === "Select node B")!);
    for (let cycle = 0; cycle < 20; cycle++) {
      shell = { ...shell, theme: cycle % 2 ? "light" : "dark", sidebar: cycle % 2 ? "expanded" : "rail" };
      await focus(opener()); await click(opener());
      expect(panel().getAttribute("aria-hidden")).toBe("false"); expect(document.activeElement).toBe(chat);
      expect(host.querySelector("output")?.textContent).toBe("node-b");
      expect(main()).toBe(content); expect(main().scrollTop).toBe(310);
      expect(scroll.scrollTop).toBe(125); expect(host.querySelector("textarea")).toBe(chat);
      expect(chat.value).toBe("An unsent conversation"); expect(input.value).toBe("An unsaved room edit");
      expect(shell.route.selection).toEqual({ runId: "run-012", factId: "fact-1" });
      await focus(close()); await click(close());
      expect(panel().getAttribute("aria-hidden")).toBe("true"); expect(panel().hasAttribute("inert")).toBe(true);
      expect(document.activeElement).toBe(opener());
    }
    expect(conversationMounts).toBe(1); expect(roomMounts).toBe(1);
  });
}

test("Escape closes locally and returns to the opener; an inner control can consume Escape", async () => {
  await render(); await focus(opener()); await click(opener());
  const chat = host.querySelector("textarea")!;
  const nested = [...host.querySelectorAll("button")].find(b => b.textContent === "Nested choice")!;
  nested.focus(); await key(nested, "Escape"); expect(shell.chatOpen).toBe(true);
  chat.focus(); await key(chat, "Escape"); expect(shell.chatOpen).toBe(false); expect(document.activeElement).toBe(opener());
  expect(opener().getAttribute("aria-controls")).toBe(panel().id);
});

test("closing a room-origin conversation restores that origin without scrolling", async () => {
  await render(); const input = host.querySelector("input")!; input.focus();
  shell = { ...shell, chatOpen: true }; await render();
  expect(document.activeElement).toBe(host.querySelector("textarea"));
  await key(host.querySelector("textarea")!, "Escape"); expect(document.activeElement).toBe(input);
});

test("narrow fallback keeps hidden work mounted, inert and scroll-stable; expanding keeps conversation focus", async () => {
  await render(); const input = host.querySelector("input")!; const content = main(); content.scrollTop = 480;
  input.focus(); shell = { ...shell, chatOpen: true }; await render();
  size = { width: 318, height: 600 }; await React.act(async () => observe());
  const work = host.querySelector<HTMLElement>(".brief-pebble-work")!;
  expect(work.hasAttribute("inert")).toBe(true); expect(work.getAttribute("aria-hidden")).toBe("true");
  expect(main()).toBe(content); expect(content.scrollTop).toBe(480);
  expect(document.activeElement).toBe(host.querySelector("textarea"));
  size = { width: 1208, height: 900 }; await React.act(async () => observe());
  expect(work.hasAttribute("inert")).toBe(false); expect(shell.chatOpen).toBe(true);
  await key(host.querySelector("textarea")!, "Escape"); expect(document.activeElement).toBe(input);
  expect(main().scrollTop).toBe(480); expect(roomMounts).toBe(1);
});

test("route changes preserve the single conversation and its draft while resetting room scroll", async () => {
  await render(); await click(opener()); const chat = host.querySelector("textarea")!; chat.value = "Keep this across destinations";
  for (const room of ["workflow", "all-workflows", "memory-detail", "profile"] as const) {
    main().scrollTop = 220; shell = { ...shell, route: { room, selection: {} } }; await render();
    expect(main().scrollTop).toBe(0); expect(host.querySelector("textarea")).toBe(chat);
    expect(chat.value).toBe("Keep this across destinations"); expect(shell.chatOpen).toBe(true);
  }
  expect(conversationMounts).toBe(1);
});

test("capability loss/recovery hides chrome without remounting room or its supplied conversation", async () => {
  await render(); await click(opener()); const input = host.querySelector("input")!; const chat = host.querySelector("textarea")!;
  enabled = false; await render(); expect(panel().getAttribute("aria-hidden")).toBe("true");
  expect(host.querySelector("input")).toBe(input); expect(host.querySelector("textarea")).toBe(chat);
  enabled = true; await render(); expect(panel().getAttribute("aria-hidden")).toBe("false");
  expect(conversationMounts).toBe(1); expect(roomMounts).toBe(1);
});

test("no binding provides no opener; live mode never mounts a fixture conversation", async () => {
  await render(false); expect(host.querySelector("[data-pebble-available]")?.getAttribute("data-pebble-available")).toBe("false");
  expect(host.querySelector("textarea")).toBeNull();
  shell = { ...shell, mode: "live", chatOpen: true }; await render();
  expect(host.querySelector("textarea")).toBeNull(); expect(panel().hasAttribute("inert")).toBe(true);
  expect(opener().tabIndex).toBe(-1);
});
