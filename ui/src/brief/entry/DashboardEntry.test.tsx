import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { BriefRoomRegistry, BriefRoomProps, BriefShellPort } from "../contracts";
import type { BriefNavigationBinding } from "../shell/navigation/model";
import { UNKNOWN_NAVIGATION } from "../shell/navigation/model";
import { getV2Route, ROOM_KEYS } from "../../v2/router";

GlobalRegistrator.register({ url: "http://localhost:4381/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let Entry: typeof import("./DashboardEntry").DashboardEntry;
let bindView: typeof import("../adapters/view").bindBriefView;
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement;
let connections = 0, starts = 0, gates = 0;
const originalFetch = globalThis.fetch;
const OriginalWebSocket = globalThis.WebSocket;
let network: string[] = [];

beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ DashboardEntry: Entry } = await import("./DashboardEntry"));
  ({ bindBriefView: bindView } = await import("../adapters/view"));
});
beforeEach(() => {
  network = []; connections = 0; starts = 0; gates = 0;
  history.replaceState(null, "", "http://localhost:4381/");
  localStorage.clear(); document.documentElement.setAttribute("data-theme", "light");
  globalThis.fetch = ((input: unknown) => { network.push(String(input)); throw new Error("Unexpected network"); }) as unknown as typeof fetch;
  globalThis.WebSocket = class { constructor() { network.push("websocket"); throw new Error("Unexpected socket"); } } as unknown as typeof WebSocket;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await React.act(async () => root?.unmount()); root = null; host.remove();
  globalThis.fetch = originalFetch; globalThis.WebSocket = OriginalWebSocket;
});
afterAll(() => GlobalRegistrator.unregister());

function Legacy() {
  React.useEffect(() => { starts++; connections++; return () => { connections--; }; }, []);
  return <div data-legacy="true">Current dashboard</div>;
}
function Gate({ children }: { children: React.ReactNode }) { gates++; return <>{children}</>; }
async function mount(url: string, rooms?: BriefRoomRegistry, guard = Gate) {
  history.replaceState(null, "", url);
  await React.act(async () => root!.render(<Entry legacy={<Legacy />} rooms={rooms} Gate={guard} />));
}
async function route(url: string) {
  await React.act(async () => { history.replaceState(null, "", url); window.dispatchEvent(new PopStateEvent("popstate")); });
}
async function click(label: string) {
  const b = [...host.querySelectorAll("button")].find(b => b.textContent?.includes(label));
  expect(b).toBeDefined(); await React.act(async () => b!.click());
}

test("flag off and legacy hash navigation retain one legacy mount and its connection owner", async () => {
  await mount("http://localhost:4381/#/brief/today");
  expect(connections).toBe(1); expect(starts).toBe(1);
  await route("http://localhost:4381/?brief=1#/_room_workflows");
  await route("http://localhost:4381/?brief=1#/_panel_settings");
  expect(starts).toBe(1); expect(connections).toBe(1); expect(gates).toBe(0);
  expect(host.querySelector("[data-legacy]")).not.toBeNull();
});

test("every current room and sidecar panel still resolves through the released router", async () => {
  await mount("http://localhost:4381/");
  for (const key of ROOM_KEYS) {
    await route(`http://localhost:4381/?brief=1#/_room_${key}`);
    expect(getV2Route()).toEqual({ kind: "room", key });
    expect(host.querySelector("[data-legacy]")).not.toBeNull();
    await route(`http://localhost:4381/?brief=1#/_panel_${key}`);
    expect(getV2Route()).toEqual({ kind: "panel", key });
    expect(host.querySelector("[data-legacy]")).not.toBeNull();
  }
  expect(starts).toBe(1); expect(gates).toBe(0);
});

test("isolated preview owns no live connection, fetch or onboarding side effects", async () => {
  await mount("http://localhost:4381/?brief=preview#/_brief_preview");
  expect(host.textContent).toContain("Isolated development preview");
  expect(host.textContent).toContain("No live provider");
  await click("Toggle sidebar"); await click("Toggle chat"); await click("Switch to dark");
  expect(host.textContent).toContain("rail"); expect(host.textContent).toContain("open");
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(network).toEqual([]); expect(connections).toBe(0); expect(gates).toBe(0);
  await route("http://localhost:4381/#/");
  expect(connections).toBe(1); expect(starts).toBe(1);
});

test("real Brief entry remains behind the existing onboarding gate", async () => {
  function SetupGate() { return <div>Complete existing onboarding</div>; }
  await mount("http://localhost:4381/?brief=1#/brief/today", {}, SetupGate);
  expect(host.textContent).toBe("Complete existing onboarding");
  expect(host.querySelector("[data-brief-room]")).toBeNull();
  expect(connections).toBe(0);
});

test("shared-control specimen is isolated from live account and connection effects", async () => {
  await mount("http://localhost:4381/?brief=preview&specimen=controls#/_brief_preview");
  expect(host.textContent).toContain("Shared controls.");
  expect(host.querySelector('[role="switch"]')).not.toBeNull();
  await click("Account example");
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  expect(network).toEqual([]); expect(connections).toBe(0); expect(gates).toBe(0);
  await route("http://localhost:4381/#/");
  expect(connections).toBe(1); expect(document.querySelector('[role="menu"]')).toBeNull();
});

test("motion specimen stays isolated and unmounts without live side effects", async () => {
  await mount("http://localhost:4381/?brief=preview&specimen=motion#/_brief_preview");
  expect(host.textContent).toContain("Motion with a purpose.");
  await click("Toggle make room");
  expect(host.querySelector('input[placeholder="Ask Jarvis…"]')?.closest('[aria-hidden]')?.getAttribute('aria-hidden')).toBe("false");
  expect(network).toEqual([]); expect(connections).toBe(0); expect(gates).toBe(0);
  await route("http://localhost:4381/#/");
  expect(connections).toBe(1);
});

test("navigation review uses the production shell without live reads, sockets or account actions", async () => {
  await mount("http://localhost:4381/?brief=preview&specimen=navigation#/_brief_preview");
  expect(host.textContent).toContain("ISOLATED SHELL REVIEW");
  await click("Vieri Balboni");
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  const billing = [...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent === "Billing") as HTMLElement;
  await React.act(async () => billing.click());
  expect(host.querySelector("h1")?.textContent).toBe("Billing");
  expect(network).toEqual([]); expect(connections).toBe(0); expect(gates).toBe(0);
  await route("http://localhost:4381/#/");
  expect(connections).toBe(1); expect(document.querySelector('[role="menu"]')).toBeNull();
});

test("missing modules give a truthful fallback instead of fabricated empty business data", async () => {
  await mount("http://localhost:4381/?brief=1#/brief/today", {});
  expect(host.textContent).toContain("not available in Brief yet");
  expect(host.textContent).toContain("Open current dashboard");
  expect(gates).toBeGreaterThan(0); expect(connections).toBe(0); expect(network).toEqual([]);
  await route("http://localhost:4381/?brief=1#/brief/unknown");
  expect(host.querySelector("[data-legacy]")).not.toBeNull();
  expect(connections).toBe(1);
});

test("room modules preserve shell state and selected source IDs through navigation", async () => {
  let observed: BriefShellPort | undefined;
  function Body({ shell }: { shell: BriefShellPort }) {
    observed = shell;
    return <button onClick={() => { shell.setChatOpen(true); shell.setSidebar("rail"); }}>Set shell</button>;
  }
  const rooms: BriefRoomRegistry = { workflows: { id: "workflows", title: "Workflows", Body }, memory: { id: "memory", title: "Memory", Body } };
  await mount("http://localhost:4381/?brief=1#/brief/workflows?flowId=existing", rooms);
  await click("Set shell");
  await route("http://localhost:4381/?brief=1#/brief/memory?factId=known-fact");
  expect(observed?.sidebar).toBe("rail"); expect(observed?.chatOpen).toBe(true);
  expect(observed?.route.selection).toEqual({ factId: "known-fact" });
  expect(network).toEqual([]);
});

test("navigation readiness loss and recovery preserve the mounted room and edited draft", async () => {
  let mounts = 0;
  let observed: BriefShellPort | undefined;
  function Body({ shell }: { shell: BriefShellPort }) {
    observed = shell;
    React.useEffect(() => { mounts++; }, []);
    return <><input aria-label="Unsaved draft" defaultValue="Original" />
      <button onClick={() => { shell.setSidebar("rail"); shell.setChatOpen(true); shell.setTheme("dark"); }}>Set shell</button></>;
  }
  const rooms: BriefRoomRegistry = { workflows: { id: "workflows", title: "Workflows", Body } };
  const ready: BriefNavigationBinding = { capabilities: { contractVersion: 1, asOf: 1, capabilities: {
    navigationCompatibility: { supported: true, ready: true, enabled: true, state: "ready", reason: null },
  } }, view: { source: "live", state: { status: "ready", data: UNKNOWN_NAVIGATION } } };
  const loading: BriefNavigationBinding = { ...ready, capabilities: { contractVersion: 1, asOf: 2, capabilities: {
    navigationCompatibility: { supported: true, ready: false, enabled: false, state: "loading", reason: "provider_loading" },
  } } };
  history.replaceState(null, "", "http://localhost:4381/?brief=1#/brief/workflows?flowId=existing");
  const render = async (navigation?: BriefNavigationBinding) => {
    await React.act(async () => root!.render(<Entry legacy={<Legacy />} rooms={rooms} Gate={Gate} navigation={navigation} />));
  };
  await render(loading);
  const input = host.querySelector("input")!;
  input.value = "My unsaved workflow";
  await click("Set shell");
  await React.act(async () => input.focus());
  for (const navigation of [ready, loading, ready, undefined, ready]) {
    await render(navigation);
    expect(host.querySelector("input") === input).toBe(true);
    expect(input.value).toBe("My unsaved workflow");
    expect(document.activeElement === input).toBe(true);
    expect(mounts).toBe(1);
    expect(observed?.sidebar).toBe("rail"); expect(observed?.chatOpen).toBe(true);
    expect(observed?.theme).toBe("dark"); expect(observed?.route.selection.flowId).toBe("existing");
    expect(host.querySelectorAll("main")).toHaveLength(1);
    expect(host.querySelector("aside") !== null).toBe(navigation === ready);
  }
  expect(network).toEqual([]);
});

test("a fixture view cannot accidentally supply live room business data", async () => {
  function Content({ view }: BriefRoomProps<{ title: string }>) {
    return <p>{view.state.status === "ready" ? view.state.data.title : view.state.status === "unsupported" ? view.state.reason : "waiting"}</p>;
  }
  const Body = bindView(() => ({ source: "fixture", state: { status: "ready", data: { title: "Fake signed partners" } } }), Content);
  await mount("http://localhost:4381/?brief=1#/brief/goals", { goals: { id: "goals", title: "Goals", Body } });
  expect(host.textContent).not.toContain("Fake signed partners");
  expect(host.textContent).toContain("Preview data is not available");
});
