/**
 * #1015: a voice room action that changes more than the screen is answered
 * once its request has settled, with whether it worked. Every such handler
 * but spawn_agent answered yes as its request went out, so voice confirmed a
 * failed save, a PATCH that always answered 400 (#1020), and a heartbeat
 * write the daemon has no endpoint for. room-actions.test.ts holds the
 * handlers' code to this; this runs them: the real room bodies behind a real
 * RoomActionBus, every side-effecting action in ROOM_ACTIONS, against a
 * daemon that holds each write until the test answers it.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Bus = typeof import("./useRoomActionBus");
type Body = React.ComponentType<{ mode: "inline" | "expanded" }>;
let React: typeof import("react");
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let bus: Bus;
let table: typeof import("../../../../src/daemon/room-actions");
let bodies: Record<string, Body>;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
const originalReload = window.location.reload;
let reloads = 0;

beforeAll(async () => {
  React = await import("react");
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  bus = await import("./useRoomActionBus");
  table = await import("../../../../src/daemon/room-actions");
  bodies = {
    settings: (await import("./settings/SettingsRoom")).SettingsRoomBody,
    tasks: (await import("./tasks/TasksRoom")).TasksRoomBody,
    workspaces: (await import("./workspaces/WorkspacesRoom")).WorkspacesRoomBody,
    content: (await import("./content/ContentRoom")).ContentRoomBody,
    memory: (await import("./memory/MemoryRoom")).MemoryRoomBody,
    goals: (await import("./goals/GoalsRoom")).GoalsRoomBody,
    calendar: (await import("./calendar/CalendarRoom")).CalendarRoomBody,
    workflows: (await import("./workflows/WorkflowsRoom")).WorkflowsRoomBody,
  };
  // replay_onboarding reloads the page once it has answered.
  Object.defineProperty(window.location, "reload", { configurable: true, value: () => { reloads += 1; } });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  Object.defineProperty(window.location, "reload", { configurable: true, value: originalReload });
  GlobalRegistrator.unregister();
});

const NOW = Date.now();
const TASK = { id: "t1", what: "Pay rent", when_due: null, context: null, priority: "normal", status: "pending", assigned_to: null, created_at: NOW, completed_at: null, result: null, sort_order: 0 };
const CONTENT = { id: "c1", title: "Launch post", content_type: "blog", stage: "draft", body: "", tags: [], scheduled_at: null, published_at: null, published_url: null, created_by: "user", sort_order: 0, created_at: NOW, updated_at: NOW };
const PROJECT = { id: "p1", name: "demo", framework: "vite", path: "/tmp/demo", status: "stopped", devPort: null, createdAt: NOW, lastOpenedAt: NOW };

/**
 * What a GET answers: the one item each list room acts on, an empty list for
 * the other lists, and 404 for anything else. Settings reads config objects,
 * so a 404 for each leaves it its error state, tabs and handler and all, as
 * room-tabs-voice.test.tsx does.
 */
function getReply(url: string): Response {
  if (url.startsWith("/api/vault/commitments")) return NativeResponse.json([TASK]);
  if (url === "/api/content") return NativeResponse.json([CONTENT]);
  if (url === "/api/sites/projects") return NativeResponse.json([PROJECT]);
  if (["/api/goals", "/api/workflows", "/api/vault/entities", "/api/vault/facts", "/api/vault/relationships"].includes(url.split("?")[0]!)) return NativeResponse.json([]);
  if (url.startsWith("/api/calendar")) return NativeResponse.json([]);
  return new NativeResponse("", { status: 404 });
}

/** A write the daemon has not answered yet. */
type Held = { url: string; release: (status: number) => void };

/**
 * Wait for `ready`, a bounded number of turns of the event loop, rather than
 * a fixed sleep: a slow run waits longer, a fast one does not wait at all.
 */
async function until(ready: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !ready(); i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  if (!ready()) throw new Error(`timed out waiting for ${what}`);
}

/** What a write answers when it succeeds: enough of each shape for every room to read it. */
const okBody = { ok: true, message: "Saved.", id: "new-1", title: "New", what: "New", name: "new", status: "stopped", framework: "vite",
  item: CONTENT, flow: { id: "f1" }, version: { id: "v1" }, client_cache_keys: [], model: "gpt" };

/** The item each list room is shown, as it renders it. */
const SHOWN: Record<string, string> = { tasks: TASK.what, content: CONTENT.title, workspaces: PROJECT.name };

async function mount(room: string): Promise<{ dispatch: Bus["useRoomActionDispatcher"] extends () => { dispatch: infer D } ? D : never; held: Held[] }> {
  let dispatch: ReturnType<Bus["useRoomActionDispatcher"]>["dispatch"] | undefined;
  const held: Held[] = [];
  function Probe() { dispatch = bus.useRoomActionDispatcher().dispatch; return null; }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET") return getReply(url);
    return new Promise<Response>((resolve) => {
      held.push({
        url: `${method} ${url}`,
        release: (status) => resolve(status === 200 ? NativeResponse.json(okBody) : NativeResponse.json({ error: "refused" }, { status })),
      });
    });
  }) as unknown as typeof fetch;
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(bus.RoomActionBusProvider, null, React.createElement(Probe), React.createElement(bodies[room]!, { mode: "expanded" })));
  });
  // Let the list load, so a case that picks an item by name finds it.
  const shown = SHOWN[room];
  await until(() => dispatch !== undefined && (!shown || (host.textContent ?? "").includes(shown)), `${room} to show its item`);
  return { dispatch: dispatch as never, held };
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** The arguments each side-effecting action is sent with: valid, naming the item the room holds. */
const ARGS: Record<string, Record<string, unknown>> = {
  "settings/set_default_model": { ref: "openai:gpt-5" },
  "settings/set_model": { provider: "openai", model: "gpt-5" },
  "settings/test_provider": { provider: "openai" },
  "settings/enable_telegram": {},
  "settings/disable_telegram": {},
  "settings/enable_discord": {},
  "settings/disable_discord": {},
  "settings/set_stt_provider": { provider: "groq" },
  "settings/enable_tts": {},
  "settings/disable_tts": {},
  "settings/set_tts_provider": { provider: "edge" },
  "settings/set_tts_voice": { voice: "en-US-AriaNeural" },
  "settings/set_heartbeat_interval": { minutes: 30 },
  "settings/set_heartbeat_aggressiveness": { level: "passive" },
  "settings/restart_daemon": {},
  "settings/replay_onboarding": { scope: "tutorial" },
  "tasks/create_task": { title: "Water plants" },
  "tasks/complete_task": { name: "rent" },
  "tasks/update_priority": { name: "rent", level: "high" },
  "tasks/reassign": { name: "rent", agent: "research" },
  "workspaces/select_project": { name: "demo" },
  "workspaces/create_project": { name: "site", template: "vite-react" },
  "workspaces/start_server": { name: "demo" },
  "workspaces/stop_server": { name: "demo" },
  "content/create_content": { title: "Draft" },
  "content/advance": { name: "launch" },
  "content/regress": { name: "launch" },
  "content/schedule": { name: "launch", when: "tomorrow" },
  "memory/remember_that": { subject: "alice", predicate: "birthday", object: "march 15" },
  "goals/create_goal": { title: "Ship it" },
  "calendar/schedule_event": { title: "Dentist", when: "tomorrow" },
  "workflows/create_from_nl": { prompt: "" },
};

/**
 * The heartbeat actions make no request: the daemon has no endpoint for
 * them, so they can only be answered no.
 */
const NO_REQUEST = new Set(["settings/set_heartbeat_interval", "settings/set_heartbeat_aggressiveness"]);

/** The write each action makes first. */
const WRITES: Record<string, string> = {
  "settings/set_default_model": "POST /api/config/llm",
  "settings/set_model": "POST /api/config/llm",
  "settings/test_provider": "POST /api/config/llm/test",
  "settings/enable_telegram": "POST /api/config/channels",
  "settings/disable_telegram": "POST /api/config/channels",
  "settings/enable_discord": "POST /api/config/channels",
  "settings/disable_discord": "POST /api/config/channels",
  "settings/set_stt_provider": "POST /api/config/stt",
  "settings/enable_tts": "POST /api/config/tts",
  "settings/disable_tts": "POST /api/config/tts",
  "settings/set_tts_provider": "POST /api/config/tts",
  "settings/set_tts_voice": "POST /api/config/tts",
  "settings/restart_daemon": "POST /api/system/autostart/restart",
  "settings/replay_onboarding": "POST /api/onboarding/reset",
  "tasks/create_task": "POST /api/vault/commitments",
  "tasks/complete_task": "PATCH /api/vault/commitments/t1",
  "tasks/update_priority": "PATCH /api/vault/commitments/t1",
  "tasks/reassign": "PATCH /api/vault/commitments/t1",
  "workspaces/select_project": "POST /api/sites/projects/p1/start",
  "workspaces/create_project": "POST /api/sites/projects",
  "workspaces/start_server": "POST /api/sites/projects/p1/start",
  "workspaces/stop_server": "POST /api/sites/projects/p1/stop",
  "content/create_content": "POST /api/content",
  "content/advance": "POST /api/content/c1/advance",
  "content/regress": "POST /api/content/c1/regress",
  "content/schedule": "PATCH /api/content/c1",
  "memory/remember_that": "POST /api/vault/entities",
  "goals/create_goal": "POST /api/goals",
  "calendar/schedule_event": "POST /api/vault/commitments",
  "workflows/create_from_nl": "POST /api/workflows",
};

const sideEffecting = () => Object.entries(table.ROOM_ACTIONS).flatMap(([room, actions]) =>
  Object.keys(actions).filter((a) => !table.isPresentationRoomAction(room, a)).map((a) => `${room}/${a}`));

test("every side-effecting action but spawn_agent is covered here", () => {
  // agents/spawn_agent has its own (AgentsRoom.voice.test.tsx, #991).
  expect(Object.keys(ARGS).sort()).toEqual(sideEffecting().filter((a) => a !== "agents/spawn_agent").sort());
  expect(Object.keys(ARGS).length).toBe(32);
});

for (const room of ["settings", "tasks", "workspaces", "content", "memory", "goals", "calendar", "workflows"]) {
  test(`${room}: each side-effecting action is answered only once its request settles, with whether it worked`, async () => {
    const actions = Object.keys(ARGS).filter((a) => a.startsWith(`${room}/`));
    expect(actions.length).toBeGreaterThan(0);
    const got: string[] = [];
    const want: string[] = [];
    for (const status of [500, 200]) {
      const { dispatch, held } = await mount(room);
      for (const key of actions) {
        const action = key.split("/")[1]!;
        let answer: string | undefined;
        let started = false;
        held.length = 0;
        await act(async () => {
          dispatch({ room, action, args: ARGS[key]!, ts: Date.now(), onStarted: () => { started = true; } },
            (ok, outcome) => { answer = `${ok} ${outcome}`; });
        });
        if (NO_REQUEST.has(key)) {
          await until(() => answer !== undefined, `${key} to answer`);
          got.push(`${key} ${status}: ${held.length} writes, ${answer}`);
          want.push(`${key} ${status}: 0 writes, false rejected`);
          continue;
        }
        await until(() => held.length > 0, `${key} to write`);
        await flush();
        // The write is out and unanswered: the room has said it started, and
        // has not answered.
        got.push(`${key} ${status} held: ${held[0]!.url} ${started} ${answer}`);
        want.push(`${key} ${status} held: ${WRITES[key]} true undefined`);
        // Answer every write, and any it sets off (create_project opens the
        // project it made), until the room answers.
        for (let i = 0; i < 5 && answer === undefined; i++) {
          for (const h of held.splice(0)) await act(async () => { h.release(status); });
          await flush();
          if (answer === undefined && held.length === 0) await until(() => answer !== undefined || held.length > 0, `${key} to answer or write again`);
        }
        const yes = status === 200;
        // Nothing it started is still going once it has answered.
        await flush();
        got.push(`${key} ${status}: ${answer}, ${held.length} writes left`);
        want.push(`${key} ${status}: ${yes ? "true accepted" : "false rejected"}, 0 writes left`);
      }
      await act(async () => root!.unmount());
      root = undefined;
      host.remove();
    }
    expect(got).toEqual(want);
  });
}

test("replay_onboarding answers before the page reloads", async () => {
  reloads = 0;
  const { dispatch, held } = await mount("settings");
  const order: string[] = [];
  Object.defineProperty(window.location, "reload", { configurable: true, value: () => { order.push("reload"); } });
  await act(async () => {
    dispatch({ room: "settings", action: "replay_onboarding", args: { scope: "tutorial" }, ts: Date.now() }, (ok) => { order.push(`answer ${ok}`); });
  });
  await until(() => held.length > 0, "the reset to be sent");
  expect(order).toEqual([]);
  for (const h of held.splice(0)) await act(async () => { h.release(200); });
  await until(() => order.length === 2, "the answer and the reload");
  expect(order).toEqual(["answer true", "reload"]);
});

test("create_project is a yes once created, though the dev server it then opens does not start", async () => {
  const { dispatch, held } = await mount("workspaces");
  let answer: string | undefined;
  await act(async () => {
    dispatch({ room: "workspaces", action: "create_project", args: { name: "site", template: "vite-react" }, ts: Date.now() },
      (ok, outcome) => { answer = `${ok} ${outcome}`; });
  });
  await until(() => held.length > 0, "the create");
  const create = held.splice(0);
  expect(create.map((h) => h.url)).toEqual(["POST /api/sites/projects"]);
  await act(async () => { create[0]!.release(200); });
  // Created, so the project it made (stopped) is opened, and its server started.
  await until(() => held.length > 0, "the server start");
  expect(answer).toBeUndefined();
  const start = held.splice(0);
  expect(start.map((h) => h.url)).toEqual(["POST /api/sites/projects/new-1/start"]);
  await act(async () => { start[0]!.release(500); });
  await until(() => answer !== undefined, "the answer");
  expect(answer).toBe("true accepted");
  expect(host.textContent).toContain("its dev server did not start");
});

test("update_priority with a level that is not one says so and sends nothing", async () => {
  const { dispatch, held } = await mount("tasks");
  let answer: string | undefined;
  await act(async () => {
    dispatch({ room: "tasks", action: "update_priority", args: { name: "rent", level: "urgent" }, ts: Date.now() },
      (ok, outcome) => { answer = `${ok} ${outcome}`; });
  });
  await until(() => answer !== undefined, "the answer");
  expect(answer).toBe("false rejected");
  expect(held).toEqual([]);
  expect(host.textContent).toContain('"urgent" is not a priority.');
});
