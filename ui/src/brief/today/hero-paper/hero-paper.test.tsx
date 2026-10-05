import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { BriefShellPort } from "../../contracts";
import type { DecisionBinding } from "./model";
import { canAct, decisionStatus, decisionView } from "./model";
import { samplePaper } from "../preview/fixtures";
import { UNKNOWN_NAVIGATION } from "../../shell/navigation/model";

GlobalRegistrator.register({ url: "http://localhost:4387/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let TodayLayout: typeof import("../layout/TodayLayout").TodayLayout;
let NavigationShell: typeof import("../../shell/navigation/NavigationShell").NavigationShell;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let shell: BriefShellPort;
let binding: DecisionBinding;
let actions: Array<{ id: string; revision: string; action: string }>;
let goalMounts = 0;
let showToday = true;
const realRect = HTMLElement.prototype.getBoundingClientRect;
beforeAll(async () => {
  React = await import("react"); ({ createRoot } = await import("react-dom/client"));
  ({ TodayLayout } = await import("../layout/TodayLayout"));
  ({ NavigationShell } = await import("../../shell/navigation/NavigationShell"));
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("brief-pebble-layout")) return new DOMRect(232, 76, 1208, 900);
    if (this.classList.contains("brief-pebble-companion")) return new DOMRect(1094, 108, 306, 152);
    return realRect.call(this);
  };
});
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); goalMounts = 0; showToday = true; actions = [];
  shell = { mode: "preview", route: { room: "today", selection: { approvalId: "fixture-approval-alex" } }, sidebar: "expanded", theme: "light", chatOpen: false,
    setSidebar: sidebar => { shell = { ...shell, sidebar }; }, setChatOpen: chatOpen => { shell = { ...shell, chatOpen }; },
    setTheme: theme => { shell = { ...shell, theme }; }, navigate: route => { shell = { ...shell, route }; } };
  binding = { source: "fixture", state: { status: "ready", data: samplePaper("ready", false) }, onAction: (d, action) => {
    actions.push({ id: d.decisionId, revision: d.revision, action });
    binding = { ...binding, operation: { decisionId: d.decisionId, revision: d.revision, state: "pending" } };
  } };
});
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => { HTMLElement.prototype.getBoundingClientRect = realRect; GlobalRegistrator.unregister(); });
function Goal() { React.useEffect(() => { goalMounts++; }, []); return <input aria-label="Retained goal view" defaultValue="Main goal" />; }
async function render() {
  await React.act(async () => root.render(<div className="brief-root" data-brief-theme={shell.theme}>
    <NavigationShell shell={shell} rooms={{ today: { id: "today", title: "Today" } }} reducedMotion
      binding={{ capabilities: null, view: { source: "fixture", state: { status: "ready", data: UNKNOWN_NAVIGATION } } }}
      conversation={{ source: "fixture", content: <textarea aria-label="Retained conversation" data-pebble-focus defaultValue="Draft" /> }}>
      {showToday ? <TodayLayout shell={shell} greeting="Good morning, Vieri." dateLabel="Thursday, 17 September" decision={binding} reducedMotion
        slots={{ goal: <Goal />, outcomes: <section>Outcomes</section>, activity: <section>Recent activity</section>, opportunities: <div>Prepared opportunity</div> }} /> : <h1>Another room</h1>}
    </NavigationShell>
  </div>));
}
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.getAttribute("aria-label") === label || b.querySelector(".brief-button__label")?.textContent === label)!;
const stage = () => host.querySelector<HTMLElement>(".brief-today-paper-stage")!;
let pointerSequence = 0;
async function hover(enter: boolean) { await React.act(async () => {
  stage().dispatchEvent(new PointerEvent(enter ? "pointerover" : "pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: document.body }));
  if (enter) stage().dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX: ++pointerSequence, clientY: 100 }));
}); }
async function click(label: string) { await React.act(async () => button(label).click()); await render(); }
const capabilities = { contractVersion: 1, asOf: 1, capabilities: { decisions: { supported: true, ready: true, enabled: true, state: "ready", reason: null } } };

test("source and readiness gates never expose sample decisions as live; preview rejects live writers", () => {
  expect(decisionView("live", binding).state.status).toBe("unavailable");
  expect(decisionView("preview", { ...binding, source: "live", capabilities }).state.status).toBe("unavailable");
  expect(decisionView("live", { ...binding, source: "live" }).state.status).toBe("unavailable");
  expect(decisionView("live", { ...binding, source: "live", capabilities }).state.status).toBe("ready");
});
test("ten re-hover cycles in all eight shell/chat/theme combinations leave the summary and identity unchanged", async () => {
  await render();
  const summary = host.querySelector(".brief-today-decision-summary")!;
  const text = summary.textContent;
  const goal = host.querySelector<HTMLInputElement>('[aria-label="Retained goal view"]')!; goal.value = "Keep goal selection";
  const chat = host.querySelector<HTMLTextAreaElement>("textarea")!; chat.value = "Keep chat draft";
  for (const theme of ["light", "dark"] as const) for (const sidebar of ["expanded", "rail"] as const) for (const chatOpen of [false, true]) {
    shell = { ...shell, theme, sidebar, chatOpen }; await render();
    for (let i = 0; i < 10; i++) {
      await hover(true); expect(stage().dataset.raised).toBe("true");
      expect(host.querySelector(".brief-today-decision-summary")).toBe(summary); expect(summary.textContent).toBe(text);
      expect(host.querySelector(".brief-today-paper-actions")!.hasAttribute("inert")).toBe(false);
      await hover(false); expect(stage().dataset.raised).toBe("false");
      expect(host.querySelector(".brief-today-paper-actions")!.hasAttribute("inert")).toBe(true);
    }
    expect(host.querySelector('[aria-label="Retained goal view"]')).toBe(goal); expect(goal.value).toBe("Keep goal selection");
    expect(host.querySelector("textarea")).toBe(chat); expect(chat.value).toBe("Keep chat draft");
    expect(shell.route.selection.approvalId).toBe("fixture-approval-alex");
  }
  expect(goalMounts).toBe(1); expect(actions).toEqual([]);
});
test("direct hover controls dispatch the exact source revision once, without pinning or navigating", async () => {
  await render(); await hover(true); await click("Approve & send"); await click("Approve & send");
  expect(actions).toEqual([{ id: "fixture-decision-follow-up", revision: "fixture-v1", action: "approve" }]);
  expect(host.querySelector(".brief-today-document-review")).toBeNull();
  expect(host.querySelector(".brief-today-decision")?.getAttribute("data-decision-id")).toBe("fixture-decision-follow-up");
  expect(shell.route.room).toBe("today"); expect(host.textContent).toContain("Waiting for confirmation");
});
test("Review is a visible keyboard/touch path; close restores focus and permits a fresh hover", async () => {
  await render(); await click("Review follow-up");
  const review = host.querySelector<HTMLElement>(".brief-today-document-review")!;
  expect(document.activeElement).toBe(review);
  await hover(false); expect(stage().dataset.raised).toBe("true");
  await click("Close review"); expect(document.activeElement).toBe(button("Review follow-up")); expect(stage().dataset.raised).toBe("false");
  // Layout can place the tray under a stationary pointer when Review collapses.
  await React.act(async () => stage().dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })));
  expect(stage().dataset.raised).toBe("false");
  await hover(true); expect(stage().dataset.raised).toBe("true"); await hover(false); expect(stage().dataset.raised).toBe("false");
  await click("Review follow-up");
  await React.act(async () => host.querySelector(".brief-today-document-review")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(host.querySelector(".brief-today-document-review")).toBeNull(); expect(document.activeElement).toBe(button("Review follow-up"));
});
test("queue insertion retains the front paper; a new identity starts at rest with its own document", async () => {
  await render(); await hover(true); const face = host.querySelector(".brief-today-paper-face");
  binding = { ...binding, state: { status: "ready", data: samplePaper("queued", false) } }; await render();
  expect(host.querySelector(".brief-today-paper-face")).toBe(face); expect(host.textContent).toContain("3 actions");
  await hover(false); await hover(true); expect(stage().dataset.raised).toBe("true");
  binding = { ...binding, state: { status: "ready", data: samplePaper("invitation", false) } }; await render();
  expect(stage().dataset.raised).toBe("false"); expect(button("Review invitation")).toBeDefined();
  await hover(true); await click("Keep draft"); expect(actions[0]?.id).toBe("fixture-decision-invitation");
});
test("stale, pending and unresolved effects never gain actionable approval or imply success", async () => {
  const data = samplePaper("ready", false);
  binding = { ...binding, state: { status: "stale", data, reason: "Refresh required" } }; await render(); await hover(true);
  expect(button("Approve & send").disabled).toBe(true); await click("Approve & send"); expect(actions).toEqual([]);
  binding = { ...binding, state: { status: "ready", data: samplePaper("unknown", false) } }; await render();
  expect(host.textContent).toContain("Check the outcome"); expect(host.textContent).not.toContain("Execution confirmed"); expect(button("Approve & send")).toBeUndefined();
  for (const outcome of ["not_started", "blocked", "unknown", "failed"] as const) {
    const item = samplePaper("unknown", false); item.decision.approval!.executionOutcome = outcome;
    expect(decisionStatus(item)).not.toBe("Execution confirmed"); expect(canAct(binding, item, "approve")).toBe(false);
  }
});
test("loading, empty and unavailable are distinct, without fictional completed work", async () => {
  for (const status of ["loading", "empty", "unavailable"] as const) {
    binding = { ...binding, state: status === "unavailable" ? { status, reason: "Connection interrupted" } : { status } }; await render();
    expect(host.querySelector(".brief-today-paper-face")).toBeNull();
    expect(host.textContent).toContain(status === "loading" ? "Loading your decisions" : status === "empty" ? "No decisions waiting" : "Connection interrupted");
  }
});
test("long review retains all content and the same open document across Pebble and theme changes", async () => {
  binding = { ...binding, state: { status: "ready", data: samplePaper("ready", true) } }; await render(); await click("Review follow-up");
  const review = host.querySelector(".brief-today-document-review"); expect(review?.textContent).toContain("Point 8");
  shell = { ...shell, chatOpen: true, sidebar: "rail", theme: "dark" }; await render();
  expect(host.querySelector(".brief-today-document-review")).toBe(review); expect(review?.textContent).toContain("Point 8");
});
test("leaving Today clears its companion reservation without replacing the conversation", async () => {
  await render(); const chat = host.querySelector("textarea"); expect(host.querySelector("[data-pebble-companion]")?.getAttribute("data-pebble-companion")).toBe("true");
  showToday = false; await render(); expect(host.querySelector("[data-pebble-companion]")?.getAttribute("data-pebble-companion")).toBe("false");
  expect(host.querySelector('[aria-label="Retained goal view"]')).toBeNull(); expect(host.querySelector("textarea")).toBe(chat);
});
