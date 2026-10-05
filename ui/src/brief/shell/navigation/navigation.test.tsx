import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { badgeLabel, breadcrumbs, canMountNavigation, connectionLabel, navigationData, navigationRoute, planFromBilling, UNKNOWN_NAVIGATION } from "./model";
import type { BriefNavigationBinding } from "./model";
import type { BriefShellPort } from "../../contracts";
import type { BillingSnapshot } from "../../../v2/billing/useBilling";
import { BRIEF_ROOMS } from "../../rooms/registry";

GlobalRegistrator.register({ url: "http://localhost:4385/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let NavigationShell: typeof import("./NavigationShell").NavigationShell;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let shell: BriefShellPort;
let binding: BriefNavigationBinding;
let destinations: string[];
const capability = { contractVersion: 1, asOf: 1, capabilities: {
  navigationCompatibility: { supported: true, ready: true, enabled: true, state: "ready", reason: null },
} };

beforeAll(async () => {
  React = await import("react"); ({ createRoot } = await import("react-dom/client"));
  ({ NavigationShell } = await import("./NavigationShell"));
});
beforeEach(() => {
  document.documentElement.dataset.theme = "light";
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  destinations = [];
  shell = { mode: "preview", route: { room: "workflow-runs", selection: { flowId: "flow-1", runId: "run-12" } }, sidebar: "expanded", chatOpen: true, theme: "light",
    setSidebar: value => { shell = { ...shell, sidebar: value }; }, setChatOpen: value => { shell = { ...shell, chatOpen: value }; },
    setTheme: value => { shell = { ...shell, theme: value }; }, navigate: route => { destinations.push(route.room); shell = { ...shell, route }; },
  };
  binding = { capabilities: capability, view: { source: "fixture", state: { status: "ready", data: {
    ...UNKNOWN_NAVIGATION, workspaceName: "Vieri’s workspace", account: { name: "Vieri Balboni", plan: { status: "ready", data: "Business" } },
    badges: { workflows: 4, "needs-you": 1 },
  } } } };
});
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());
async function render() {
  await React.act(async () => root.render(<div className="brief-root" data-brief-theme={shell.theme}>
    <NavigationShell shell={shell} binding={binding} rooms={BRIEF_ROOMS}><input aria-label="Kept draft" defaultValue="Keep me" /></NavigationShell>
  </div>));
}
function trigger() { return host.querySelector<HTMLButtonElement>(".brief-account-origin")!; }
function menu() { return document.querySelector<HTMLElement>('[role="menu"]'); }
async function click(element: HTMLElement) { await React.act(async () => element.click()); }
async function key(element: HTMLElement, value: string) {
  await React.act(async () => element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
}

test("live navigation requires the F-25 capability and rejects fixture data", () => {
  expect(canMountNavigation("live")).toBe(false);
  expect(canMountNavigation("live", binding)).toBe(false);
  binding.view.source = "live";
  expect(canMountNavigation("live", binding)).toBe(true);
  for (const patch of [{ enabled: false }, { state: "loading" }, { ready: false }, { reason: "disabled" }]) {
    const modified = { ...capability, capabilities: { navigationCompatibility: { ...capability.capabilities.navigationCompatibility, ...patch } } };
    expect(canMountNavigation("live", { ...binding, capabilities: modified })).toBe(false);
  }
  for (const snapshot of [null, {}, { ...capability, contractVersion: 2 }]) expect(canMountNavigation("live", { ...binding, capabilities: snapshot })).toBe(false);
});

test("unavailable and stale reads never invent healthy connection, plan or zero counts", () => {
  expect(navigationData({ source: "live", state: { status: "loading" } })).toBe(UNKNOWN_NAVIGATION);
  if (binding.view.state.status !== "ready") throw Error("fixture");
  const stale = navigationData({ source: "live", state: { status: "stale", data: { ...binding.view.state.data, connection: "connected" }, reason: "Offline" } });
  expect(stale.connection).toBe("unknown"); expect(stale.badges).toEqual({}); expect(stale.account.plan.status).toBe("unavailable");
  expect(connectionLabel(stale)).toBe("Connection status unavailable");
  expect(connectionLabel({ ...stale, hosting: "self", connection: "connected" })).toBe("Jarvis connected");
});

test("actual billing names are retained; outages and self-hosted are distinct", () => {
  const bill: BillingSnapshot = { state: "ready", stale: false, readAt: 1, links: null,
    summary: { plans: [{ name: "Business", key: "b", quantity: 1, prices: [] }], account: { email: "private@example.com" }, subscription: null, upcomingInvoice: null, paymentMethods: null, payments: [] } };
  expect(planFromBilling(bill)).toEqual({ status: "ready", data: "Business" });
  expect(planFromBilling({ ...bill, stale: true }).status).toBe("unavailable");
  expect(planFromBilling({ ...bill, state: "unknown", summary: null }).status).toBe("loading");
  expect(planFromBilling({ ...bill, state: "self", summary: null })).toEqual({ status: "ready", data: "Self-hosted" });
  expect(planFromBilling({ ...bill, summary: { ...bill.summary!, plans: [] } })).toEqual({ status: "ready", data: "No active plan" });
  expect(planFromBilling({ ...bill, summary: { ...bill.summary!, plans: null as never } }).status).toBe("unavailable");
});

test("bounded counts and real parent links do not conflate object IDs and titles", () => {
  expect([undefined, -1, 1.5, NaN, Infinity].map(badgeLabel)).toEqual([null, null, null, null, null]);
  expect([0, 4, 99, 100].map(badgeLabel)).toEqual(["0", "4", "99", "99+"]);
  expect(breadcrumbs(shell.route, "Runs", "Meeting follow-ups")).toEqual({ parent: { label: "Workflows", route: { room: "workflows", selection: {} } }, current: "Meeting follow-ups" });
  expect(breadcrumbs({ room: "today", selection: {} }, "Today").parent).toBeNull();
  expect(navigationRoute("workflow-runs", shell.route)).toBe(shell.route);
  expect(navigationRoute("workflows", shell.route)).toEqual({ room: "workflows", selection: {} });
});

test("disabled rollout renders existing children without a replacement shell", async () => {
  shell = { ...shell, mode: "live" };
  await render(); expect(host.querySelector("aside")).toBeNull(); expect(host.querySelector("input")?.value).toBe("Keep me");
  binding.view.source = "live";
  await render(); expect(host.querySelector("aside")).not.toBeNull();
});

test("ten collapse/expand cycles retain the actual body DOM, draft, room, selection and chat", async () => {
  await render();
  const input = host.querySelector("input")!; input.value = "Changed draft";
  for (let i = 0; i < 20; i++) {
    await click(host.querySelector<HTMLButtonElement>(".brief-collapse")!); await render();
    expect(host.querySelector("input")).toBe(input); expect(input.value).toBe("Changed draft");
    expect(shell.route.selection.runId).toBe("run-12"); expect(shell.chatOpen).toBe(true);
  }
  expect(destinations).toEqual([]); expect(shell.sidebar).toBe("expanded");
  expect(host.querySelector('[aria-current="page"].brief-nav-row')?.getAttribute("aria-label")).toBe("Workflows");
});

test("account menu opens by keyboard, wraps focus, supports typeahead and Escape return", async () => {
  await render(); trigger().focus(); await key(trigger(), "ArrowUp");
  expect(document.activeElement?.textContent).toBe("Billing");
  await key(document.activeElement as HTMLElement, "ArrowDown"); expect(document.activeElement?.textContent).toBe("Profile");
  await key(document.activeElement as HTMLElement, "s"); expect(document.activeElement?.textContent).toBe("Settings");
  await key(document.activeElement as HTMLElement, "Escape"); expect(document.activeElement).toBe(trigger()); expect(trigger().getAttribute("aria-expanded")).toBe("false");
});

test("all account destinations are reachable expanded/rail in both themes", async () => {
  for (const sidebar of ["expanded", "rail"] as const) for (const theme of ["light", "dark"] as const) for (const room of ["profile", "settings", "billing"] as const) {
    shell = { ...shell, sidebar, theme, route: { room: "today", selection: {} } };
    await render(); await click(trigger());
    const option = [...menu()!.querySelectorAll("button")].find(b => b.textContent?.toLowerCase() === room)!;
    await click(option); await render();
    expect(shell.route.room).toBe(room); expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".brief-control-layer")?.getAttribute("data-brief-theme")).toBe(theme);
  }
});

test("outside click dismisses without stealing the new focus; Tab returns toward normal flow", async () => {
  await render(); await click(trigger());
  await React.act(async () => {
    host.querySelector("input")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); host.querySelector("input")!.focus();
  });
  expect(trigger().getAttribute("aria-expanded")).toBe("false"); expect(document.activeElement).toBe(host.querySelector("input"));
  await click(trigger()); await key(menu()!.querySelector("button")!, "Tab");
  expect(trigger().getAttribute("aria-expanded")).toBe("false"); expect(document.activeElement).toBe(trigger());
});

test("route and theme changes do not strand a menu or change the account plan", async () => {
  await render(); await click(trigger());
  shell = { ...shell, theme: "dark" }; await render();
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector(".brief-control-layer")?.getAttribute("data-brief-theme")).toBe("dark");
  shell = { ...shell, route: { room: "memory", selection: { factId: "fact-9" } } }; await render();
  expect(trigger().getAttribute("aria-expanded")).toBe("false"); expect(trigger().textContent).toContain("Business");
  expect(document.activeElement).toBe(trigger());
});

test("fresh read models and equivalent route objects leave the account menu and focus intact", async () => {
  await render(); await key(trigger(), "ArrowUp");
  shell = { ...shell, route: { ...shell.route, selection: { ...shell.route.selection } } };
  binding = { ...binding, view: { ...binding.view } };
  await render();
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement?.textContent).toBe("Billing");
});

test("reopening during account-menu exit reuses one surface and recovers keyboard focus", async () => {
  await render();
  for (let i = 0; i < 10; i++) {
    await key(trigger(), "ArrowUp"); expect(document.activeElement?.textContent).toBe("Billing");
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    await key(document.activeElement as HTMLElement, "Escape"); expect(document.activeElement).toBe(trigger());
  }
  await key(trigger(), "ArrowUp");
  shell = { ...shell, sidebar: "rail" }; await render();
  expect(document.activeElement?.textContent).toBe("Billing");
});

test("rail focus names its icon and dismissal leaves focus on that same destination", async () => {
  shell = { ...shell, sidebar: "rail" }; await render();
  const destination = host.querySelector<HTMLButtonElement>('[aria-label="Memory"]')!;
  await React.act(async () => destination.focus());
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Memory");
  expect(document.querySelector('[data-placement="right"]')).not.toBeNull();
  await key(destination, "Escape"); expect(document.activeElement).toBe(destination);
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await click(destination); expect(shell.route.room).toBe("memory");
});

test("status targets the connected workspace and unknown state remains explicitly named", async () => {
  await render();
  const status = host.querySelector<HTMLButtonElement>(".brief-connection")!;
  expect(status.getAttribute("aria-label")).toBe("Connection status unavailable. Open connected workspace");
  await click(status); expect(shell.route.room).toBe("connected-workspace"); expect(shell.chatOpen).toBe(true);
});
