/**
 * #933: a voice tab switch is announced only when the room ran it. These
 * mount the real room bodies behind a real RoomActionBus and check that each
 * room accepts exactly the tabs in ROOM_TABS (the table the voice side builds
 * its words from), says no to anything else, and that the bus reports both.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Bus = typeof import("./useRoomActionBus");
type Tabs = typeof import("../../../../src/daemon/room-tabs");
let React: typeof import("react");
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let bus: Bus;
let tabs: Tabs;
let bodies: Record<string, React.ComponentType<{ mode: "inline" | "expanded" }>>;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  React = await import("react");
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  bus = await import("./useRoomActionBus");
  tabs = await import("../../../../src/daemon/room-tabs");
  bodies = {
    settings: (await import("./settings/SettingsRoom")).SettingsRoomBody,
    agents: (await import("./agents/AgentsRoom")).AgentsRoomBody,
    authority: (await import("./authority/AuthorityRoom")).AuthorityRoomBody,
    memory: (await import("./memory/MemoryRoom")).MemoryRoomBody,
    goals: (await import("./goals/GoalsRoom")).GoalsRoomBody,
  };
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

type Dispatch = (req: { room: string; action: string; args: Record<string, unknown>; ts: number }, onResult?: (ok: boolean) => void) => void;

async function mountWithBus(children: React.ReactNode, status = 200): Promise<Dispatch> {
  let dispatch!: Dispatch;
  function Probe() { dispatch = bus.useRoomActionDispatcher().dispatch; return null; }
  // Empty lists for the list rooms. Settings reads config objects, so it gets
  // a 404 for each and renders its error state, tabs and all.
  globalThis.fetch = (async () => status === 200 ? NativeResponse.json([]) : new NativeResponse("", { status })) as unknown as typeof fetch;
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(bus.RoomActionBusProvider, null, React.createElement(Probe), children));
  });
  // Handlers register in an effect; let any queued drain run.
  await act(async () => { await Promise.resolve(); });
  return dispatch;
}

async function switchTab(dispatch: Dispatch, room: string, tab: unknown): Promise<boolean | undefined> {
  let result: boolean | undefined;
  await act(async () => {
    dispatch({ room, action: "switch_tab", args: { tab }, ts: Date.now() }, (ok) => { result = ok; });
  });
  return result;
}

const selected = (): string | null =>
  host.querySelector('[data-roving-tab][aria-selected="true"]')?.getAttribute("data-roving-tab") ?? null;
const shown = (tab: string): boolean => host.querySelector(`[data-roving-tab="${tab}"]`) !== null;

for (const room of ["settings", "agents", "authority", "memory", "goals"] as const) {
  test(`${room}: accepts each of its ROOM_TABS, reports it, and refuses anything else`, async () => {
    const Body = bodies[room]!;
    const dispatch = await mountWithBus(React.createElement(Body, { mode: "expanded" }), room === "settings" ? 404 : 200);
    let accepted = 0;
    for (const tab of tabs.ROOM_TABS[room]) {
      const ok = await switchTab(dispatch, room, tab);
      if (!shown(tab)) {
        // Billing is hidden until the account has it; the room says no. No
        // other tab may be missing.
        expect(`${room}:${tab}`).toBe("settings:billing");
        expect(`${tab}:${ok}`).toBe(`${tab}:false`);
        continue;
      }
      expect(`${tab}:${ok}`).toBe(`${tab}:true`);
      expect(selected()).toBe(tab);
      accepted++;
    }
    expect(accepted).toBeGreaterThan(1);
    const before = selected();
    for (const bogus of ["editor", "list", "tts", "logs", "agent_builder", 42]) {
      expect(`${bogus}:${await switchTab(dispatch, room, bogus)}`).toBe(`${bogus}:false`);
    }
    expect(selected()).toBe(before);
  });
}

test("an action queued before the room mounted is reported when it runs", async () => {
  let dispatch!: Dispatch;
  function Probe() { dispatch = bus.useRoomActionDispatcher().dispatch; return null; }
  function Late({ on }: { on: boolean }) {
    return on ? React.createElement(Room) : null;
  }
  function Room() {
    bus.useRoomActions("goals", (action, args) => action === "switch_tab" && args.tab === "timeline");
    return null;
  }
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  const render = (on: boolean) => root!.render(
    React.createElement(bus.RoomActionBusProvider, null, React.createElement(Probe), React.createElement(Late, { on })));
  await act(async () => { render(false); });
  const results: boolean[] = [];
  await act(async () => {
    dispatch({ room: "goals", action: "switch_tab", args: { tab: "timeline" }, ts: Date.now() }, (ok) => results.push(ok));
    dispatch({ room: "goals", action: "switch_tab", args: { tab: "editor" }, ts: Date.now() }, (ok) => results.push(ok));
  });
  expect(results).toEqual([]);
  await act(async () => { render(true); });
  await act(async () => { await Promise.resolve(); });
  expect(results).toEqual([true, false]);
});
