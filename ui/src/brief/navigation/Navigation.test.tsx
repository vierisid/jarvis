import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { BriefCapabilities } from "../../../../src/brief/capabilities";
import { registerNavigationCompatibility } from "../../../../src/brief/navigation-compatibility";
import { NavigationCompatibility } from "./controller";
import { browserNavigationHost } from "./browser-host";
import { deviceNavigation } from "./devices";
import { DESTINATIONS, targetHref, type DestinationId } from "./destinations";
import type { AttentionSnapshot } from "./notifications";
import type { BriefConnection } from "../../../../src/brief/contracts";
import type { SettingsHook, SidecarInfo } from "../../v2/rooms/settings/useSettingsData";

GlobalRegistrator.register({ url: "http://localhost:4425/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let Attention: typeof import("./AttentionRoutes").AttentionRoutes;
let Maintenance: typeof import("./MaintenanceLinks").MaintenanceLinks;
let Entry: typeof import("../entry/DashboardEntry").DashboardEntry;
let Sidecars: typeof import("../../v2/rooms/settings/tabs/SidecarTab").SidecarTab;
let Settings: typeof import("../../v2/rooms/settings/SettingsRoom").SettingsRoomBody;
let root: ReturnType<typeof createRoot>, element: HTMLDivElement;
const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket;
const cap = new BriefCapabilities(registerNavigationCompatibility(() => ({ destinations: true, guardedNavigation: true, roomIntents: true, notificationsOutsideChat: true })), ["navigationCompatibility"]).snapshot();
const fixture: AttentionSnapshot = { status: "ready", items: [
  { id: "a", source: "approval", kind: "approval", title: "Approval", text: "Pending", unread: true, timestamp: 1, tone: "warn" },
  { id: "f", source: "failure", kind: "system", title: "Failure", text: "Needs recovery", unread: true, timestamp: 2, tone: "warn", refs: { taskId: "task-f" } },
  { id: "u", source: "update", kind: "system", title: "Update", text: "Device update", unread: true, timestamp: 3, tone: "neutral" },
] };
beforeAll(async () => {
  React = await import("react"); ({ createRoot } = await import("react-dom/client"));
  ({ AttentionRoutes: Attention } = await import("./AttentionRoutes"));
  ({ MaintenanceLinks: Maintenance } = await import("./MaintenanceLinks"));
  ({ DashboardEntry: Entry } = await import("../entry/DashboardEntry"));
  ({ SidecarTab: Sidecars } = await import("../../v2/rooms/settings/tabs/SidecarTab"));
  ({ SettingsRoomBody: Settings } = await import("../../v2/rooms/settings/SettingsRoom"));
});
beforeEach(() => {
  history.replaceState(null, "", "http://localhost:4425/?brief=1#/brief/settings");
  globalThis.fetch = (() => { throw Error("No network allowed"); }) as unknown as typeof fetch;
  globalThis.WebSocket = class { constructor() { throw Error("No socket allowed"); } } as unknown as typeof WebSocket;
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await React.act(async () => root.unmount()); element.remove(); globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; });
afterAll(() => GlobalRegistrator.unregister());
const mount = async (node: React.ReactNode) => { await React.act(async () => root.render(node)); };
async function click(text: string) {
  const button = [...element.querySelectorAll("button")].find(b => b.textContent === text)!;
  expect(button).toBeDefined(); await React.act(async () => button.click());
}
function controller(allow = true) {
  const opened: unknown[] = [], nav = new NavigationCompatibility({ roomAvailable: () => false, canLeave: async () => allow, commit: target => opened.push(target), explain() {} });
  nav.setAccess(cap); return { opened, nav };
}

test("approvals, failures and updates stay reachable with conversation absent, and marking read does not hide pending work", async () => {
  const f = controller(), read: string[] = [];
  await mount(<Attention snapshot={fixture} navigation={f.nav} roomAvailable={() => false} markRead={id => read.push(id)} />);
  await click("Approval"); await click("Failure"); await click("Update");
  expect(f.opened).toEqual([DESTINATIONS["advanced-authority"].legacy, { kind: "legacy", hash: "#/_task_task-f" }, DESTINATIONS.devices.legacy]);
  expect(read).toEqual(["a", "f", "u"]); expect(element.querySelectorAll("button").length).toBe(3);
  expect(element.textContent).not.toMatch(/Arrange|Create workflow/);
});

test("stale notifications are explicit, and a cancelled draft guard leaves notifications unread", async () => {
  const f = controller(false), read: string[] = [];
  await mount(<Attention snapshot={fixture} navigation={f.nav} roomAvailable={() => false} markRead={id => read.push(id)} />);
  await click("Approval"); expect(read).toEqual([]); expect(f.opened).toEqual([]); expect(element.textContent).toContain("Navigation cancelled");
  await mount(<Attention snapshot={{ status: "stale" }} navigation={f.nav} roomAvailable={() => false} markRead={() => {}} />);
  expect(element.querySelectorAll("button").length).toBe(0); expect(element.textContent).toContain("Notifications are stale"); expect(element.textContent).not.toContain("No pending");
});

test("support entry provides explicit retained links without restoring tabs or global create", async () => {
  await mount(<Maintenance href={window.location.href} />);
  const hrefs = [...element.querySelectorAll("a")].map(a => a.href);
  for (const id of ["emergency-controls", "capture-privacy", "credentials", "channels", "devices", "logs", "usage", "tasks", "calendar", "content", "workspaces", "tools"] as DestinationId[])
    expect(hrefs).toContain(targetHref(window.location.href, DESTINATIONS[id].legacy));
  expect(element.querySelector('[role="tablist"]')).toBeNull(); expect(element.querySelector("footer")).toBeNull();
});

test("browser handoff keeps one root and the in-memory room-action owner, and selects the real Settings tab", async () => {
  let legacyMounts = 0, legacyAlive = 0, tab: string | null = null;
  const { takeRequestedSettingsTab } = await import("../../v2/shell/settings-tab-request");
  function Legacy() { React.useEffect(() => { legacyMounts++; legacyAlive++; tab = takeRequestedSettingsTab(); return () => { legacyAlive--; }; }, []); return <p>Legacy owner</p>; }
  const nav = new NavigationCompatibility(browserNavigationHost({ roomAvailable: () => false, canLeave: async () => true, explain() {}, revealConversationItem() {} })); nav.setAccess(cap);
  await mount(<Entry legacy={<Legacy />} Gate={({ children }) => <>{children}</>} />);
  expect(legacyAlive).toBe(0);
  await React.act(async () => { await nav.navigate("devices"); });
  expect(legacyAlive).toBe(1); expect(legacyMounts).toBe(1); expect(tab as string | null).toBe("sidecar");
  expect(location.hash).toBe("#/_room_settings"); expect(new URL(location.href).searchParams.has("brief")).toBe(false);
  await React.act(async () => { await nav.intent("agents"); });
  expect(legacyMounts).toBe(1); expect(location.hash).toBe("#/_room_agents");
});

test("device handoff selects only the requested device and never calls update/revoke/enroll", async () => {
  const rows: SidecarInfo[] = [{ id: "device-1", name: "Fixture laptop", status: "active", enrolled_at: "2026-01-01", last_seen_at: null, connected: true, version: "1", latest_version: "2", update_available: true }];
  const identity: BriefConnection = { sourceId: "device:device-1", kind: "device", accountId: "device-1", availability: "ready", permissions: { canInspect: true, canConnect: false, canRevoke: true }, authenticated: null };
  const nav = new NavigationCompatibility(browserNavigationHost({ roomAvailable: () => false, canLeave: async () => true, explain() {}, revealConversationItem() {} })); nav.setAccess(cap);
  let snapshot: readonly SidecarInfo[] | null = rows;
  const port = deviceNavigation(nav, () => snapshot);
  expect(port.deviceDetails(identity)?.canUpdate).toBe(true);
  expect((await port.manageDevice(identity, "update", new AbortController().signal)).state).toBe("opened");
  expect(new URL(location.href).searchParams.get("sidecarId")).toBe("device-1");
  const data = { sidecars: rows, llm: null, stats: { sidecarsConnected: 1 }, enrollSidecar: () => { throw Error("Unexpected mutation"); }, revokeSidecar: () => { throw Error("Unexpected mutation"); } } as unknown as SettingsHook;
  await mount(<Sidecars data={data} onToast={() => {}} />);
  expect(element.querySelector('[aria-current="true"]')?.textContent).toContain("Fixture laptop · Selected device");
  snapshot = null; expect(port.deviceDetails(identity)).toBeNull();
  expect((await port.manageDevice(identity, "revoke", new AbortController().signal)).state).toBe("unavailable");
});

test("F-25 explicit preview mounts no legacy/voice owner and chat closure leaves attention visible", async () => {
  history.replaceState(null, "", "http://localhost:4425/?brief=preview#/_brief_navigation_preview");
  await mount(<Entry legacy={<p>Legacy must not mount</p>} Gate={({ children }) => <>{children}</>} />);
  expect(element.textContent).toContain("Isolated behavior preview"); expect(element.textContent).not.toContain("Legacy must not mount");
  expect(element.textContent).toContain("Conversation: closed"); await click("Inspect a device update");
  expect(element.querySelector("pre")?.textContent).toContain('"settingsTab":"sidecar"');
  await click("Conversation: closed"); await click("Conversation: open");
  expect(element.textContent).toContain("Review a pending approval");
});

test("an inline Settings observer preserves the sidecar pill request for the expanded destination mount", async () => {
  const { requestSettingsTab, clearRequestedSettingsTab } = await import("../../v2/shell/settings-tab-request");
  clearRequestedSettingsTab();
  history.replaceState(null, "", "http://localhost:4425/#/");
  globalThis.fetch = (async (_: unknown, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET"); return new Response(null, { status: 503 });
  }) as typeof fetch;
  await mount(<section id="inline"><Settings mode="inline" /></section>);
  await React.act(async () => {
    requestSettingsTab("sidecar");
    history.replaceState(null, "", "http://localhost:4425/#/_room_settings");
    root.render(<><section id="inline"><Settings mode="inline" /></section><section id="expanded"><Settings mode="expanded" /></section></>);
  });
  expect(element.querySelector('#expanded [aria-selected="true"]')?.textContent).toBe("Sidecar");
  clearRequestedSettingsTab();
});

test("an accepted history entry restores the real Settings tab without remounting the room", async () => {
  const { clearRequestedSettingsTab } = await import("../../v2/shell/settings-tab-request");
  clearRequestedSettingsTab();
  history.replaceState(null, "", "http://localhost:4425/#/_room_settings");
  globalThis.fetch = (async (_: unknown, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET"); return new Response(null, { status: 503 });
  }) as typeof fetch;
  await mount(<Settings mode="expanded" />);
  const nav = new NavigationCompatibility(browserNavigationHost({ roomAvailable: () => false, canLeave: async () => true, explain() {}, revealConversationItem() {} })); nav.setAccess(cap);
  await React.act(async () => { await nav.navigate("realtime-voice"); });
  const voiceURL = location.href;
  expect(element.querySelector('[aria-selected="true"]')?.textContent).toBe("Voice");
  await React.act(async () => { await nav.navigate("devices"); });
  const settingsRoot = element.firstElementChild;
  expect(element.querySelector('[aria-selected="true"]')?.textContent).toBe("Sidecar");
  await React.act(async () => {
    history.replaceState(null, "", voiceURL);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(element.firstElementChild).toBe(settingsRoot);
  expect(element.querySelector('[aria-selected="true"]')?.textContent).toBe("Voice");
  await mount(<p>Another retained room</p>);
  await mount(<Settings mode="expanded" />);
  expect(element.querySelector('[aria-selected="true"]')?.textContent).toBe("Voice");
  const { requestSettingsTab } = await import("../../v2/shell/settings-tab-request");
  await React.act(async () => { requestSettingsTab("sidecar"); });
  await mount(<p>Another retained room</p>);
  await mount(<Settings mode="expanded" />);
  expect(element.querySelector('[aria-selected="true"]')?.textContent).toBe("Sidecar");
  expect(new URL(location.href).searchParams.get("settingsTab")).toBe("sidecar");
  history.replaceState(null, "", "http://localhost:4425/#/_room_logs");
  const { takeRequestedSettingsTab } = await import("../../v2/shell/settings-tab-request");
  expect(takeRequestedSettingsTab()).toBeNull();
  clearRequestedSettingsTab();
});
