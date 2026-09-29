import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const realFetch = globalThis.fetch;
let React: typeof import("react");
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let useOnboardingStatus: typeof import("./useOnboardingStatus").useOnboardingStatus;
let ONBOARDING_BROADCAST_CHANNEL: typeof import("./useOnboardingStatus").ONBOARDING_BROADCAST_CHANNEL;
let resetOnboarding: typeof import("./resetClient").resetOnboarding;
let STATUS_RETRY: typeof import("./useOnboardingStatus").STATUS_RETRY;
let retryDelay = 0;

beforeAll(async () => {
  React = await import("react");
  ({ act } = React);
  ({ createRoot } = await import("react-dom/client"));
  ({ useOnboardingStatus, ONBOARDING_BROADCAST_CHANNEL } = await import("./useOnboardingStatus"));
  ({ resetOnboarding } = await import("./resetClient"));
  ({ STATUS_RETRY } = await import("./useOnboardingStatus"));
  // Three attempts at the real 700ms backoff is ~2.1s, which would eat most
  // of `actUntil`'s budget: a regression that made the hook hit a wrong URL
  // would then surface as a timeout instead of the `unexpected` assertion
  // that says what happened.
  retryDelay = STATUS_RETRY.delayMs;
  STATUS_RETRY.delayMs = 1;
});

/** Every root and raw channel a test opened, torn down in `afterEach` so a
 *  leaked listener cannot make the next test's read counter lie. */
const mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLDivElement }> = [];
const channels: BroadcastChannel[] = [];
async function unmountAll() {
  for (const m of mounted.splice(0)) {
    await act(async () => m.root.unmount());
    m.host.remove();
  }
}
afterEach(async () => {
  await unmountAll();
  for (const ch of channels.splice(0)) ch.close();
  globalThis.fetch = realFetch;
});
afterAll(() => {
  STATUS_RETRY.delayMs = retryDelay;
  GlobalRegistrator.unregister();
});

/**
 * One macrotask -- the slack a real fetch always costs. Same reasoning as
 * WorkflowActivation.test.tsx: an in-memory response that settles inside
 * `act`'s microtask drain hides a missing wait, and hides an extra round
 * trip that lands just after the assertions.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const BASE = {
  setup_completed: false,
  setup_completed_at: null,
  setup_skipped_profile: false,
  profile_completed: false,
  tutorial_completed: false,
  tutorial_completed_at: null,
  tutorial_dismissed: false,
  tutorial_progress_step: null,
  last_reset_at: null,
};

/** Bounded, named wait -- a real regression fails promptly and says what for. */
// 3s, inside bun's default 5s test timeout, so the named error wins.
async function actUntil(what: string, done: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
}

/**
 * Assert a count is final, not merely reached.
 *
 * The counts below are the whole point of #556, so "at least one read" would
 * pass with the bug still in place. A redundant read is triggered by a
 * broadcast delivery, i.e. within a macrotask or two of the read it follows,
 * so draining a handful of macrotasks and re-checking catches it: before the
 * fix this fails on the first pass, which is how the counts here were shown
 * to be exact rather than lucky.
 */
async function expectFinalCount(what: string, counter: () => number, expected: number) {
  // Named on both sides so a failure reads as a sentence, and so every one of
  // the six checks registers as an assertion rather than a bare throw.
  const reads = (n: number) => `${what}: ${n} reads`;
  expect(reads(counter())).toBe(reads(expected));
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(reads(counter())).toBe(reads(expected));
  }
}

interface Server {
  /** Reads started, counted on entry so a held read still counts. */
  reads: number;
  /** Any URL a test did not route, asserted empty by every test in this
   *  file: a throw in a fetch mock would be swallowed by
   *  `fetchStatusWithRetry` and surface only as a timeout, which would not
   *  say what went wrong. */
  unexpected: string[];
  /** Hold the Nth read open until `release()`, to build an overlap. */
  holdRead: number;
  release: () => void;
}

/** A status endpoint whose payload the test flips between reads. */
function statusServer(payload: () => Record<string, unknown>): Server {
  const server: Server = { reads: 0, unexpected: [], holdRead: 0, release: () => {} };
  globalThis.fetch = (async (url: string) => {
    await tick();
    if (String(url) !== "/api/onboarding/status") {
      server.unexpected.push(String(url));
      return new Response("unexpected", { status: 404 });
    }
    if (++server.reads === server.holdRead) {
      await new Promise<void>((resolve) => { server.release = resolve; });
    }
    return Response.json({ ...BASE, ...payload() });
  }) as never;
  return server;
}

/** Mount one hook instance in its own root -- one "tab", as far as the hook
 *  can tell: its own component tree, its own channel object. */
async function mountProbe(): Promise<{ refresh: () => Promise<unknown>; rendered: () => string }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  let refresh!: () => Promise<unknown>;
  function Probe() {
    const value = useOnboardingStatus();
    refresh = value.refresh;
    return React.createElement("span", null, value.status ? String(value.status.setup_completed) : "-");
  }
  await act(async () => root.render(React.createElement(Probe)));
  return { refresh, rendered: () => host.textContent ?? "" };
}

/** A raw channel object, standing in for a peer tab's subscriber. */
function peerChannel(): { messages: unknown[]; channel: BroadcastChannel } {
  const channel = new BroadcastChannel(ONBOARDING_BROADCAST_CHANNEL);
  channels.push(channel);
  const messages: unknown[] = [];
  channel.addEventListener("message", (e) => messages.push((e as MessageEvent).data));
  return { messages, channel };
}

test("a local phase flip costs exactly one status read, not two", async () => {
  let flipped = false;
  const server = statusServer(() => ({ setup_completed: flipped }));
  const peer = peerChannel();
  const probe = await mountProbe();
  await actUntil("the initial status read", () => probe.rendered() === "false");
  await expectFinalCount("the initial read", () => server.reads, 1);

  // The flip the gate actually does: finish a phase, then refresh.
  flipped = true;
  await act(async () => { await probe.refresh(); });
  await actUntil("the flipped status", () => probe.rendered() === "true");
  // Two: the mount read and this refresh. A third would be the tab hearing
  // its own `status_changed` broadcast and re-reading for nothing (#556).
  await expectFinalCount("a local phase flip", () => server.reads, 2);
  // The post itself went out exactly once -- a count, not a timing guess.
  expect(peer.messages).toEqual([{ type: "status_changed" }]);
  expect(server.unexpected).toEqual([]);
});

test("a local phase flip still reaches other subscribers, each re-reading once", async () => {
  let flipped = false;
  const server = statusServer(() => ({ setup_completed: flipped }));
  const peer = peerChannel();
  const a = await mountProbe();
  const b = await mountProbe();
  await actUntil("both initial status reads", () => server.reads === 2);
  await actUntil("both probes painted", () => a.rendered() === "false" && b.rendered() === "false");

  flipped = true;
  await act(async () => { await a.refresh(); });
  // The broadcast left the tab: a channel object that did not post it sees it.
  await actUntil("the status_changed broadcast", () => peer.messages.length === 1);
  expect(peer.messages).toEqual([{ type: "status_changed" }]);
  // ...and the second subscriber acted on it, without being told directly.
  await actUntil("the peer subscriber's re-read", () => b.rendered() === "true");
  // 2 mount reads + A's own refresh + B's one broadcast-driven re-read. A
  // fifth would be A hearing itself, or B re-broadcasting back to A.
  await expectFinalCount("a flip with two subscribers", () => server.reads, 4);
  expect(peer.messages).toHaveLength(1);
  expect(server.unexpected).toEqual([]);
});

test("a peer tab's broadcast triggers exactly one re-read", async () => {
  let flipped = false;
  const server = statusServer(() => ({ setup_completed: flipped }));
  const probe = await mountProbe();
  await actUntil("the initial status read", () => probe.rendered() === "false");

  // What a real second tab does -- post from a channel object this hook
  // instance does not own.
  flipped = true;
  const peer = peerChannel();
  await act(async () => peer.channel.postMessage({ type: "status_changed" }));
  await actUntil("the broadcast-driven re-read", () => probe.rendered() === "true");
  await expectFinalCount("a peer broadcast", () => server.reads, 2);

  // A `reset` from a peer is honoured the same way.
  flipped = false;
  await act(async () => peer.channel.postMessage({ type: "reset", scope: "all" }));
  await actUntil("the reset-driven re-read", () => probe.rendered() === "false");
  await expectFinalCount("a peer reset", () => server.reads, 3);
  // Both of those reads saw a flag flip, and neither may be echoed back:
  // the peer that posted would re-read, and ping-pong from there.
  expect(peer.messages).toEqual([]);
  expect(server.unexpected).toEqual([]);
});

test("a local flip overlapping a peer-driven read is still broadcast", async () => {
  let flipped = false;
  const server = statusServer(() => ({ setup_completed: flipped }));
  const probe = await mountProbe();
  await actUntil("the initial status read", () => probe.rendered() === "false");

  // Put a peer-driven read in flight and hold it there.
  server.holdRead = 2;
  const peer = peerChannel();
  await act(async () => peer.channel.postMessage({ type: "status_changed" }));
  await actUntil("the held peer-driven read", () => server.reads === 2);

  // Now flip a phase locally, while that read is still open. Peers must
  // hear about it: the suppression is per-read, not a flag shared by
  // whatever happens to be in flight.
  flipped = true;
  await act(async () => { await probe.refresh(); });
  await actUntil("the local flip's broadcast", () => peer.messages.length === 1);
  expect(peer.messages).toEqual([{ type: "status_changed" }]);

  server.release();
  await actUntil("the held read to land", () => probe.rendered() === "true");
  // 1 initial + the held peer-driven read + the local refresh. The held one
  // landing last must not echo either, however late it is.
  await expectFinalCount("an overlapped flip", () => server.reads, 3);
  expect(peer.messages).toHaveLength(1);
  expect(server.unexpected).toEqual([]);
});

test("a reset fired through resetClient reaches a mounted tab", async () => {
  let reads = 0;
  let dismissed = false;
  const resets: unknown[] = [];
  const unexpected: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    await tick();
    if (String(url) === "/api/onboarding/reset") {
      resets.push(init?.body);
      return Response.json({ ok: true, scope: "all", cleared: [], client_cache_keys: [], message: "" });
    }
    if (String(url) === "/api/onboarding/status") {
      reads++;
      return Response.json({ ...BASE, setup_completed: !dismissed });
    }
    unexpected.push(String(url));
    return new Response("unexpected", { status: 404 });
  }) as never;
  const probe = await mountProbe();
  await actUntil("the initial status read", () => probe.rendered() === "true");

  // `reload: false` so the reset's own page reload does not end the test --
  // that is also the path where this tab's re-read actually matters.
  dismissed = true;
  await act(async () => { await resetOnboarding("all", { reload: false }); });
  await actUntil("the reset-driven re-read", () => probe.rendered() === "false");
  expect(resets).toHaveLength(1);
  // Exactly one re-read: the reset post is a throwaway channel with no
  // listener of its own, so nothing can bounce between the two.
  await expectFinalCount("a resetClient broadcast", () => reads, 2);
  expect(unexpected).toEqual([]);
});

test("unmounting closes the channel, so a later broadcast reads nothing", async () => {
  const server = statusServer(() => ({}));
  const probe = await mountProbe();
  await actUntil("the initial status read", () => probe.rendered() === "false");
  await unmountAll();

  const peer = peerChannel();
  await act(async () => peer.channel.postMessage({ type: "status_changed" }));
  // A leaked channel would be a listener outliving its component: it would
  // fetch here, and set state on a tree that is gone. (This guards the
  // second reference `channelRef` adds; it is not part of the #556 proof.)
  await expectFinalCount("a broadcast after unmount", () => server.reads, 1);
  expect(server.unexpected).toEqual([]);
});
