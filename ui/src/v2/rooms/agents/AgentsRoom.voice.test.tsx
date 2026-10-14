/**
 * #991: a voice `spawn_agent` room action is answered by what POST /api/agents
 * did, not before it is known. Since #932 the route can raise a card (202),
 * refuse under Pause or Kill (409), deny (403) or refuse for too many waiting
 * cards (429); none of those started an agent, so the room must not tell the
 * daemon it carried the spawn out. Real AgentsRoom body, real RoomActionBus.
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
let AgentsRoomBody: React.ComponentType<{ mode: "inline" | "expanded" }>;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  React = await import("react");
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  bus = await import("../useRoomActionBus");
  AgentsRoomBody = (await import("./AgentsRoom")).AgentsRoomBody;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

type Dispatch = (req: { room: string; action: string; args: Record<string, unknown>; ts: number }, onResult?: import("../useRoomActionBus").RoomActionResultCallback) => void;

/** Mount the Agents room; `spawnReply` answers each POST /api/agents. */
async function mount(spawnReply: () => Promise<Response>): Promise<{ dispatch: Dispatch; posts: string[] }> {
  let dispatch!: Dispatch;
  const posts: string[] = [];
  function Probe() { dispatch = bus.useRoomActionDispatcher().dispatch; return null; }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "POST" && url === "/api/agents") {
      posts.push(String(init?.body ?? ""));
      return spawnReply();
    }
    if (url === "/api/agents/specialists") return NativeResponse.json({ specialists: [] });
    return NativeResponse.json([]);
  }) as unknown as typeof fetch;
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(bus.RoomActionBusProvider, null, React.createElement(Probe),
      React.createElement(AgentsRoomBody, { mode: "expanded" })));
  });
  await act(async () => { await Promise.resolve(); });
  return { dispatch, posts };
}

/**
 * Dispatch a spawn and return a reader for the answer, as "<carried out> <answer>"
 * (#1016: a card waiting is `false pending`, a refusal `false rejected`);
 * undefined until the room answers.
 */
async function spawn(dispatch: Dispatch): Promise<() => string | undefined> {
  let answer: string | undefined;
  await act(async () => {
    dispatch({ room: "agents", action: "spawn_agent", args: { specialist: "research-analyst", task: "look into it" }, ts: Date.now() },
      (ok, outcome) => { answer = `${ok} ${outcome}`; });
  });
  return () => answer;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

const errorReply = (status: number, message: string) => async () => NativeResponse.json({ error: message }, { status });

test("the room does not answer a voice spawn before the route has", async () => {
  let reply!: (r: Response) => void;
  const { dispatch, posts } = await mount(() => new Promise<Response>((r) => { reply = r; }));
  const answer = await spawn(dispatch);
  await settle();
  expect(posts).toHaveLength(1);
  // The request is out and the route has not answered: neither yes nor no yet.
  expect(answer()).toBeUndefined();
  await act(async () => { reply(NativeResponse.json({ approval_required: true, approval_id: "a1", message: "A card is waiting." }, { status: 202 })); });
  await settle();
  expect(answer()).toBe("false pending");
});

test("a voice spawn is carried out only when the route started the agent", async () => {
  const outcomes: Array<[string, () => Promise<Response>]> = [
    ["202 card raised", async () => NativeResponse.json({ approval_required: true, approval_id: "a1", message: "A card is waiting." }, { status: 202 })],
    ["409 halted", errorReply(409, "[SYSTEM PAUSED] No agent can be started while the system is paused.")],
    ["403 denied", errorReply(403, "Authority denied starting an agent")],
    ["429 too many waiting", errorReply(429, "5 requests to start an agent are already waiting")],
    ["network failure", async () => { throw new Error("offline"); }],
    ["201 spawned", async () => NativeResponse.json({ id: "agent-1", assignment: { message: "Assigned." } }, { status: 201 })],
  ];
  const answers: string[] = [];
  for (const [label, reply] of outcomes) {
    const { dispatch } = await mount(reply);
    const answer = await spawn(dispatch);
    await settle();
    answers.push(`${label}: ${answer()}`);
    await act(async () => root!.unmount());
    root = undefined;
    host.remove();
  }
  // A card is waiting, not a refusal (#1016); nothing else waits.
  expect(answers).toEqual([
    "202 card raised: false pending",
    "409 halted: false rejected",
    "403 denied: false rejected",
    "429 too many waiting: false rejected",
    "network failure: false rejected",
    "201 spawned: true accepted",
  ]);
});

test("the bus reports a promised answer when it settles, and a rejected one as not carried out", async () => {
  let answer: () => PromiseLike<import("../useRoomActionBus").RoomActionAnswer> = async () => true;
  let dispatch!: Dispatch;
  function Probe() { dispatch = bus.useRoomActionDispatcher().dispatch; return null; }
  function Room() { bus.useRoomActions("authority", () => answer()); return null; }
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(bus.RoomActionBusProvider, null, React.createElement(Probe), React.createElement(Room)));
  });
  await act(async () => { await Promise.resolve(); });
  const results: Array<string | undefined> = [];
  // A thenable that is not a native Promise is an answer too.
  const thenable = (): PromiseLike<boolean> => ({ then: (ok, _err) => Promise.resolve(ok?.(true)) as never });
  const held = async (): Promise<import("../useRoomActionBus").RoomActionAnswer> => bus.AWAITING_APPROVAL;
  // Only the bus's own marker is pending: an object that looks like it is not.
  const lookalike = async () => ({ awaitingApproval: true }) as never;
  for (const next of [async () => true, async () => "Done.", async () => false, async () => { throw new Error("broke"); }, thenable, held, lookalike]) {
    answer = next;
    let got: string | undefined;
    await act(async () => { dispatch({ room: "authority", action: "set_filter", args: {}, ts: Date.now() }, (ok, outcome) => { got = `${ok} ${outcome}`; }); });
    await settle();
    results.push(got);
  }
  expect(results).toEqual(["true accepted", "true accepted", "false rejected", "false rejected", "true accepted", "false pending", "false rejected"]);
});
