/**
 * #1023: a held remember_that is settled by the daemon before its card: the
 * entity its subject names, pinned by id, or a new one. The Memory room used
 * to look the subject up itself after the yes, by a substring of whatever it
 * had loaded ("me" found "James"), and with nothing loaded it made a
 * duplicate. This runs the real room body behind a real RoomActionBus and
 * records every request it makes.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Bus = typeof import("../useRoomActionBus");
let React: typeof import("react");
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let bus: Bus;
let Body: React.ComponentType<{ mode: "inline" | "expanded" }>;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  React = await import("react");
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  bus = await import("../useRoomActionBus");
  Body = (await import("./MemoryRoom")).MemoryRoomBody;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  GlobalRegistrator.unregister();
});

const NOW = Date.now();
const entity = (id: string, name: string) => ({ id, type: "person", name, properties: null, created_at: NOW, updated_at: NOW, source: "dashboard" });
/** In the vault. */
const VAULT = [entity("e-james", "James"), entity("e-alice", "Alice Smith"), entity("e-bob1", "Bob"), entity("e-bob2", "bob")];
/** What the room's own paged load has shown so far: only James. */
const LOADED = [VAULT[0]!];

/** Mount the room; answer every request, and record it with its body. */
async function mount(): Promise<{ dispatch: ReturnType<Bus["useRoomActionDispatcher"]>["dispatch"]; calls: string[] }> {
  let dispatch: ReturnType<Bus["useRoomActionDispatcher"]>["dispatch"] | undefined;
  const calls: string[] = [];
  function Probe() { dispatch = bus.useRoomActionDispatcher().dispatch; return null; }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    // The room's own paged load, which the action must not match against.
    if (url.startsWith("/api/vault/page")) return NativeResponse.json({ items: url.includes("kind=entities") ? LOADED : [], nextCursor: null });
    calls.push(`${method} ${url}${init?.body ? ` ${String(init.body)}` : ""}`);
    if (method === "GET" && url === "/api/vault/entities") return NativeResponse.json(VAULT);
    if (method === "POST" && url === "/api/vault/entities") {
      const { name } = JSON.parse(String(init!.body)) as { name: string };
      return NativeResponse.json(entity("e-new", name));
    }
    if (method === "POST" && url === "/api/vault/facts") {
      const { subject_id } = JSON.parse(String(init!.body)) as { subject_id: string };
      // As the daemon answers for an entity deleted since the card.
      if (subject_id === "e-gone") return new NativeResponse(JSON.stringify({ error: `Unknown subject_id: ${subject_id}` }), { status: 404 });
      return NativeResponse.json({ id: "f-1" });
    }
    return new NativeResponse("", { status: 404 });
  }) as unknown as typeof fetch;
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(bus.RoomActionBusProvider, null, React.createElement(Probe), React.createElement(Body, { mode: "expanded" })));
  });
  // Let the room load, so a lookup in what it loaded would find James.
  for (let i = 0; i < 200 && !(host.textContent ?? "").includes("James"); i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  if (!dispatch || !(host.textContent ?? "").includes("James")) throw new Error("the room did not load");
  return { dispatch, calls };
}

async function remember(args: Record<string, unknown>): Promise<{ answer: string; calls: string[] }> {
  const { dispatch, calls } = await mount();
  let answer: string | undefined;
  await act(async () => {
    dispatch({ room: "memory", action: "remember_that", args, ts: Date.now() }, (ok, outcome) => { answer = `${ok} ${outcome}`; });
  });
  for (let i = 0; i < 200 && answer === undefined; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  if (answer === undefined) throw new Error("no answer");
  return { answer, calls };
}

const fact = (subjectId: string) => `POST /api/vault/facts ${JSON.stringify({ subject_id: subjectId, predicate: "birthday", object: "march 15", source: "dashboard" })}`;

test("a pinned entity is written to as given: no lookup, no new entity", async () => {
  const { answer, calls } = await remember({ subject: "Alice Smith", predicate: "birthday", object: "march 15", id: "e-alice" });
  expect(answer).toBe("true accepted");
  expect(calls).toEqual([fact("e-alice")]);
});

test("a new entity the card promised is made, though a loaded name (James) holds the subject", async () => {
  const { answer, calls } = await remember({ subject: "me", predicate: "birthday", object: "march 15", new_entity: true });
  expect(answer).toBe("true accepted");
  expect(calls).toEqual([
    `POST /api/vault/entities ${JSON.stringify({ name: "me", type: "concept", source: "dashboard" })}`,
    fact("e-new"),
  ]);
});

test("unsettled (the realtime path), the subject is matched against the vault, not a substring of what is loaded", async () => {
  // "alice" is a word of "Alice Smith": that entity, though the room has not loaded it.
  expect(await remember({ subject: "alice", predicate: "birthday", object: "march 15" }))
    .toEqual({ answer: "true accepted", calls: ["GET /api/vault/entities", fact("e-alice")] });
  // "me" is inside "James" but not a word of it: a new entity, not James.
  const me = await remember({ subject: "me", predicate: "birthday", object: "march 15" });
  expect(me.calls).toEqual([
    "GET /api/vault/entities",
    `POST /api/vault/entities ${JSON.stringify({ name: "me", type: "concept", source: "dashboard" })}`,
    fact("e-new"),
  ]);
  // Two entities called "bob": refused, nothing written.
  expect(await remember({ subject: "Bob", predicate: "birthday", object: "march 15" }))
    .toEqual({ answer: "false rejected", calls: ["GET /api/vault/entities"] });
});

test("a pinned entity deleted since the card is refused, not swapped for another or made again", async () => {
  const { answer, calls } = await remember({ subject: "Alice Smith", predicate: "birthday", object: "march 15", id: "e-gone" });
  expect(answer).toBe("false rejected");
  expect(calls).toEqual([fact("e-gone")]);
  expect(host.textContent).toContain("Alice Smith is no longer in memory; nothing was saved.");
});
