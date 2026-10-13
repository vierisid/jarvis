import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { BriefRoomRegistry, BriefRoomProps, BriefShellPort } from "../contracts";
import type { BriefNavigationBinding } from "../shell/navigation/model";
import { UNKNOWN_NAVIGATION } from "../shell/navigation/model";
import { getV2Route, ROOM_KEYS } from "../../v2/router";
import { BRIEF_ROOM_IDS } from "../contracts";
import { BRIEF_ROOMS } from "../rooms/registry";
import { releaseExample } from "./release.test-support";
import { BRIEF_RELEASE } from "./release";
import type { DashboardEntryProps } from "./DashboardEntry";

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
  // These are isolated internal composition/preview tests, not release evidence.
  localStorage.setItem("jarvis-devtools", "1");
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
  // The isolated preview is lazy-loaded only after its development gate passes.
  if (url.includes("brief=preview")) {
    for (let i = 0; i < 100 && !host.textContent; i++) {
      await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
  }
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

test("style specimen is an isolated, scoped preview with working theme and text controls", async () => {
  await mount("http://localhost:4381/?brief=preview&specimen=styles#/_brief_preview");
  const specimen = host.querySelector<HTMLElement>("main.brief-root.brief-specimen");
  expect(specimen).not.toBeNull();
  expect(specimen!.getAttribute("data-brief-theme")).toBe("light");
  expect(host.querySelector(".brief-type-room-title")).not.toBeNull();
  expect(host.querySelectorAll('[role="progressbar"]').length).toBe(5);
  await click("Switch to dark");
  expect(specimen!.getAttribute("data-brief-theme")).toBe("dark");
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  await click("200% text");
  expect(specimen!.style.getPropertyValue("--brief-text-scale")).toBe("2");
  expect(network).toEqual([]); expect(connections).toBe(0); expect(gates).toBe(0);
  await route("http://localhost:4381/#/");
  expect(host.querySelector(".brief-root")).toBeNull();
  expect(connections).toBe(1);
});

test("Today review and illustrative decision actions never call live providers", async () => {
  await mount("http://localhost:4381/?brief=preview&specimen=today#/_brief_preview");
  expect(host.querySelector(".brief-today-decision")).not.toBeNull();
  await click("Review follow-up");
  const approve = host.querySelector<HTMLButtonElement>(".brief-today-review-actions button")!;
  await React.act(async () => approve.click());
  expect(host.textContent).toContain("Waiting for confirmation");
  expect(host.querySelector(".brief-today-decision")?.getAttribute("data-decision-id")).toBe("fixture-decision-follow-up");
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 700)); });
  expect(host.querySelector(".brief-today-decision")?.getAttribute("data-transition")).toBe("confirmed");
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 240)); });
  expect(host.querySelector(".brief-today-decision")?.getAttribute("data-decision-id")).toBe("fixture-decision-investor");
  await click("Reset example");
  expect(host.textContent).toContain("No email or workflow executes");
  expect(network).toEqual([]); expect(connections).toBe(0); expect(gates).toBe(0);
  await route("http://localhost:4381/#/");
  expect(connections).toBe(1); expect(host.querySelector(".brief-pebble-companion")).toBeNull();
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
  await click("Alex Morgan");
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
  expect(host.querySelector("[data-legacy]")).toBeNull();
  expect(host.textContent).toContain("This view is not part of Brief");
  expect(host.textContent).toContain("Open advanced settings and support");
  expect(connections).toBe(0);
});

test("Pebble review mounts one isolated conversation without live reads or writers", async () => {
  await mount("http://localhost:4381/?brief=preview&specimen=pebble#/_brief_preview");
  const composer = host.querySelector<HTMLTextAreaElement>('[aria-label="Conversation draft"]')!;
  expect(composer).not.toBeNull();
  await React.act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Open conversation"]')!.click());
  expect(host.querySelector("[data-pebble-open]")?.getAttribute("data-pebble-open")).toBe("true");
  await React.act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close conversation"]')!.click());
  expect(host.querySelector('[aria-label="Conversation draft"]')).toBe(composer);
  expect(network).toEqual([]); expect(connections).toBe(0); expect(gates).toBe(0);
  await route("http://localhost:4381/#/"); expect(connections).toBe(1);
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

function releaseProps(): DashboardEntryProps {
  const { config, runtime } = releaseExample();
  function Body({ shell }: { shell: BriefShellPort }) {
    return <><p>Test room: {shell.route.room}</p><input aria-label="Release test draft" defaultValue="Draft" />
      <button onClick={() => shell.navigate({ room: "memory-detail", selection: { factId: "fact-123" } })}>Open selected fact</button></>;
  }
  return {
    legacy: <Legacy />, Gate, release: config, runtime,
    rooms: Object.fromEntries(BRIEF_ROOM_IDS.map(id => [id, { id, title: id, Body }])),
    navigation: { capabilities: { contractVersion: 1, asOf: 1, capabilities: {
      navigationCompatibility: { supported: true, ready: true, enabled: true, state: "ready", reason: null },
    } }, view: { source: "live", state: { status: "ready", data: UNKNOWN_NAVIGATION } } },
    conversation: { source: "live", content: <textarea aria-label="Release test conversation" /> },
  };
}
async function production(url: string, props: DashboardEntryProps = { legacy: <Legacy />, Gate }) {
  localStorage.removeItem("jarvis-devtools");
  history.replaceState(null, "", url);
  await React.act(async () => root!.render(<Entry {...props} />));
}

test("production default rejects opt-in bypass and restores the legacy parent before mounting", async () => {
  localStorage.setItem("saved-work", "canonical-existing-work");
  await production("http://localhost:4381/?brief=1&sidecar=desktop#/brief/workflow-runs?flowId=flow-1&runId=run-2");
  expect(getV2Route()).toEqual({ kind: "room", key: "workflows" });
  expect(new URL(location.href).searchParams.get("briefReturn")).toBe("#/brief/workflow-runs?flowId=flow-1&runId=run-2");
  expect(new URL(location.href).searchParams.get("sidecar")).toBe("desktop");
  expect(host.textContent).toBe("Current dashboard"); expect(starts).toBe(1); expect(gates).toBe(0);
  expect(localStorage.getItem("saved-work")).toBe("canonical-existing-work"); expect(network).toEqual([]);
});
test("fixture preview URL cannot mount in the ordinary production document", async () => {
  await production("http://localhost:4381/?brief=preview&specimen=today#/_brief_preview");
  expect(host.textContent).toBe("Current dashboard"); expect(starts).toBe(1); expect(gates).toBe(0);
  expect(network).toEqual([]);
});
for (const missing of ["body", "navigation", "conversation", "fixture-navigation", "fixture-conversation", "loading-navigation"] as const) {
  test(`a passed release record cannot bypass missing or unsafe composition: ${missing}`, async () => {
    const props = releaseProps();
    if (missing === "body") props.rooms = BRIEF_ROOMS;
    if (missing === "navigation") props.navigation = undefined;
    if (missing === "conversation") props.conversation = undefined;
    if (missing === "fixture-navigation") props.navigation!.view.source = "fixture";
    if (missing === "fixture-conversation") props.conversation!.source = "fixture";
    if (missing === "loading-navigation") props.navigation!.view.state = { status: "loading" };
    await production("http://localhost:4381/?brief=1#/_room_memory", props);
    expect(host.textContent).toBe("Current dashboard"); expect(network).toEqual([]);
  });
}
test("approved cohort aliases foreground routes and retains exact selection through navigation", async () => {
  await production("http://localhost:4381/?brief=1#/_room_memory", releaseProps());
  expect(host.textContent).toContain("Test room: memory"); expect(connections).toBe(0); expect(gates).toBeGreaterThan(0);
  await click("Open selected fact");
  await React.act(async () => window.dispatchEvent(new HashChangeEvent("hashchange")));
  expect(location.hash).toBe("#/brief/memory-detail?factId=fact-123");
  expect(host.textContent).toContain("Test room: memory-detail");
  expect(host.querySelectorAll('[aria-label="Release test conversation"]')).toHaveLength(1);
  expect(network).toEqual([]);
});
test("native sidecar panels still mount only their legacy owner under an approved release", async () => {
  const props = releaseProps(); props.release!.rollout = "released";
  await production("http://localhost:4381/?brief=1#/_panel_settings", props);
  expect(getV2Route()).toEqual({ kind: "panel", key: "settings" });
  expect(host.textContent).toBe("Current dashboard"); expect(gates).toBe(0); expect(starts).toBe(1);
});
test("old F25 maintenance links keep device settings reachable with a released default", async () => {
  const props = releaseProps(); props.release!.rollout = "released";
  await production("http://localhost:4381/?briefMaintenance=1&settingsTab=sidecar&sidecarId=device-123#/_room_settings", props);
  expect(getV2Route()).toEqual({ kind: "room", key: "settings" });
  expect(new URL(location.href).searchParams.get("sidecarId")).toBe("device-123");
  expect(host.textContent).toBe("Current dashboard"); expect(gates).toBe(0);
});
test("approved entry still runs the existing onboarding gate, and explicit reset retains its owner", async () => {
  const props = releaseProps(); props.Gate = () => <p>Complete existing onboarding</p>;
  await production("http://localhost:4381/?brief=1#/", props);
  expect(host.textContent).toBe("Complete existing onboarding");
  await route("http://localhost:4381/?brief=1&onboarding=reset&scope=tutorial#/brief/today");
  expect(host.textContent).toBe("Current dashboard");
  expect(location.search).toContain("onboarding=reset");
});
test("readiness and configuration updates do not discard an open draft; reload applies rollback", async () => {
  const props = releaseProps();
  await production("http://localhost:4381/?brief=1#/brief/memory-detail?factId=kept", props);
  const input = host.querySelector<HTMLInputElement>('[aria-label="Release test draft"]')!;
  input.value = "My unsaved correction";
  await React.act(async () => input.focus());
  for (let i = 0; i < 20; i++) {
    await React.act(async () => root!.render(<Entry {...props} release={BRIEF_RELEASE} navigation={i % 2 ? props.navigation : undefined} />));
    expect(host.querySelector('[aria-label="Release test draft"]') === input).toBe(true);
    expect(input.value).toBe("My unsaved correction"); expect(document.activeElement === input).toBe(true);
    expect(connections).toBe(0);
  }
  // A new document/root uses the new flag. Saved domain records are untouched.
  localStorage.setItem("saved-work", "saved-fact");
  await React.act(async () => root!.unmount()); root = createRoot(host);
  await production(location.href, { ...props, release: BRIEF_RELEASE });
  expect(getV2Route()).toEqual({ kind: "room", key: "memory" });
  expect(host.textContent).toBe("Current dashboard"); expect(connections).toBe(1);
  expect(new URL(location.href).searchParams.get("briefReturn")).toBe("#/brief/memory-detail?factId=kept");
  expect(localStorage.getItem("saved-work")).toBe("saved-fact"); expect(network).toEqual([]);
});
test("enabling a flag during a legacy session waits for reload instead of destroying legacy work", async () => {
  const props = releaseProps();
  await production("http://localhost:4381/?brief=1#/", { ...props, release: BRIEF_RELEASE });
  await React.act(async () => root!.render(<Entry {...props} />));
  expect(host.textContent).toBe("Current dashboard"); expect(starts).toBe(1); expect(gates).toBe(0);
});
