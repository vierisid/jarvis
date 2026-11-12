import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { BriefShellPort } from "../../contracts";
import { UNKNOWN_NAVIGATION } from "../../shell/navigation/model";
import { samplePaper } from "../preview/fixtures";

GlobalRegistrator.register({ url: "http://localhost:4388/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let TodayLayout: typeof import("./TodayLayout").TodayLayout;
let NavigationShell: typeof import("../../shell/navigation/NavigationShell").NavigationShell;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let shell: BriefShellPort;
/** Height of the notices above the greeting, as the browser would lay them out. */
let noticeHeight = 0;
const realRect = HTMLElement.prototype.getBoundingClientRect;
const RealResizeObserver = globalThis.ResizeObserver;
/** Records what each observer watches, so a test can say which box changed size. */
const watchers = new Set<{ callback: () => void; targets: Set<Element> }>();
class RecordingResizeObserver {
  private watcher: { callback: () => void; targets: Set<Element> };
  constructor(callback: () => void) { this.watcher = { callback, targets: new Set() }; watchers.add(this.watcher); }
  observe(target: Element) { this.watcher.targets.add(target); }
  unobserve(target: Element) { this.watcher.targets.delete(target); }
  disconnect() { this.watcher.targets.clear(); }
}
const resized = (target: Element) => { for (const watcher of watchers) if (watcher.targets.has(target)) watcher.callback(); };
beforeAll(async () => {
  React = await import("react"); ({ createRoot } = await import("react-dom/client"));
  ({ TodayLayout } = await import("./TodayLayout"));
  ({ NavigationShell } = await import("../../shell/navigation/NavigationShell"));
  globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("brief-pebble-layout")) return new DOMRect(232, 76, 1208, 900);
    if (this.classList.contains("brief-today-greeting")) return new DOMRect(270, 108 + noticeHeight, 700, 74);
    return realRect.call(this);
  };
});
beforeEach(() => {
  noticeHeight = 0;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  shell = { mode: "preview", route: { room: "today", selection: {} }, sidebar: "expanded", theme: "light", chatOpen: false,
    setSidebar: () => {}, setChatOpen: () => {}, setTheme: () => {}, navigate: () => {} };
});
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => { HTMLElement.prototype.getBoundingClientRect = realRect; globalThis.ResizeObserver = RealResizeObserver; GlobalRegistrator.unregister(); });
const companion = () => host.querySelector<HTMLElement>(".brief-pebble-companion")!;
const tick = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

async function renderToday() {
  await React.act(async () => root.render(<div className="brief-root" data-brief-theme="light">
    <NavigationShell shell={shell} rooms={{ today: { id: "today", title: "Today" } }} reducedMotion
      binding={{ capabilities: null, view: { source: "fixture", state: { status: "ready", data: UNKNOWN_NAVIGATION } } }}
      conversation={{ source: "fixture", content: <textarea aria-label="Conversation" data-pebble-focus /> }}>
      <TodayLayout shell={shell} greeting="Good morning." dateLabel="Thursday" reducedMotion
        decision={{ source: "fixture", state: { status: "ready", data: samplePaper("ready", false) } }}
        slots={{ goal: <p>No active goal</p> }} />
    </NavigationShell></div>));
  await tick();
}

test("the goal card follows the greeting down when a notice appears above Today and back up when it leaves", async () => {
  await renderToday();
  // Level with the greeting at its usual place: 108 is 32 below the layout's top (76).
  expect(companion().style.getPropertyValue("--pebble-companion-top")).toBe("32px");
  expect(companion().style.getPropertyValue("--pebble-companion-closed-top")).toBe("132px");

  noticeHeight = 70;
  const notice = document.createElement("div"); notice.setAttribute("role", "alert");
  host.querySelector("main")!.prepend(notice);
  await tick();
  expect(companion().style.getPropertyValue("--pebble-companion-top")).toBe("102px");
  expect(companion().style.getPropertyValue("--pebble-companion-closed-top")).toBe("202px");

  noticeHeight = 0; notice.remove();
  await tick();
  expect(companion().style.getPropertyValue("--pebble-companion-top")).toBe("32px");
  expect(companion().style.getPropertyValue("--pebble-companion-closed-top")).toBe("132px");
});

test("the goal card follows a notice that grows or shrinks in place, without a node being added", async () => {
  await renderToday();
  noticeHeight = 70;
  const notice = document.createElement("div"); notice.setAttribute("role", "status");
  host.querySelector("main")!.prepend(notice);
  await tick();
  expect(companion().style.getPropertyValue("--pebble-companion-top")).toBe("102px");

  // Paused becomes stopped: the same banner rewraps to another line, only its text changes.
  noticeHeight = 94;
  await React.act(async () => resized(notice));
  expect(companion().style.getPropertyValue("--pebble-companion-top")).toBe("126px");
  expect(companion().style.getPropertyValue("--pebble-companion-closed-top")).toBe("226px");
  noticeHeight = 46;
  await React.act(async () => resized(notice));
  expect(companion().style.getPropertyValue("--pebble-companion-top")).toBe("78px");
});
