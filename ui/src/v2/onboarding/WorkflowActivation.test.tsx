import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const realFetch = globalThis.fetch;
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let WorkflowActivation: typeof import("./WorkflowActivation").WorkflowActivation;
let OnboardingGate: typeof import("./OnboardingGate").OnboardingGate;
let Composer: typeof import("../shell/Composer").Composer;
let useTalkDraft: typeof import("../shell/useTalkDraft").useTalkDraft;
let STATUS_RETRY: typeof import("./useOnboardingStatus").STATUS_RETRY;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ WorkflowActivation } = await import("./WorkflowActivation"));
  ({ OnboardingGate } = await import("./OnboardingGate"));
  ({ Composer } = await import("../shell/Composer"));
  ({ useTalkDraft } = await import("../shell/useTalkDraft"));
  ({ STATUS_RETRY } = await import("./useOnboardingStatus"));
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  globalThis.fetch = realFetch;
});
afterAll(() => GlobalRegistrator.unregister());

/**
 * One macrotask -- the slack a real fetch always costs.
 *
 * Every mock below answers through this. `await act()` drains React's queue
 * and microtasks but gives the tree NO macrotask slack, so an in-memory
 * `Response.json()` that happens to settle inside that drain let a test touch
 * a tree that had not painted yet and still pass -- on this bun build, by luck
 * (#552). Answering on a task makes a missing wait fail every run instead of
 * one in N, which is the only way the waits below can be shown to be right.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Mount into a fresh host and wait for the first painted render.
 *
 * OnboardingGate renders nothing until its status read lands, so `render`
 * inside one `act` is not enough: the caller's next line would look for a
 * control in an empty host and die on `undefined.click()`.
 */
async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  await actUntil("the first render", () => host.childElementCount > 0, 1_000);
}
/**
 * Let React and the component's own async work run until `done()` holds.
 * These flows chain real timers -- each status retry waits on a setTimeout,
 * even at a 0ms backoff -- so the fixed 20ms sleeps they replaced raced them:
 * one event-loop stall longer than the sleep (GC, a loaded machine) and the
 * assertions saw a flow that had not finished yet (#524). Bounded, and named,
 * so a real regression still fails promptly and says what it was waiting for.
 */
// 3s, inside bun's default 5s test timeout, so the named error wins. Only one
// wait per test can ever exhaust its budget, because exhausting it throws; the
// rest resolve in milliseconds in practice, and that -- not the sum of the
// bounds, which is larger than the timeout -- is what keeps a test inside it.
async function actUntil(what: string, done: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
}
const buttons = () => [...host.querySelectorAll("button")];
const find = (text: string) => buttons().find((el) => el.textContent?.trim() === text);
const button = (text: string) => find(text)!;
/**
 * Wait for a control, then click it. The wait is the point: most clicks below
 * follow an async boundary (a status read, a tutorial-dismiss POST) that the
 * click's own `act` does not cover, so the control is not painted yet.
 */
async function click(text: string) {
  // Enabled, not merely present: a click on a disabled control is swallowed,
  // and the assertion after it would then pass for an unrelated reason.
  await actUntil(`the "${text}" button`, () => find(text)?.disabled === false, 1_000);
  await act(async () => button(text).click());
}
/**
 * Quiet the gate's follow-up refresh before the test ends. Best effort only.
 *
 * A local refresh that flips a phase flag posts `status_changed` on a NEWLY
 * created channel, so the tab hears its own broadcast through its listener
 * channel and re-reads status -- redundant work `useOnboardingStatus` does in
 * production too, not just here. It lands in the gap between the last assertion
 * and `afterEach` (a drain in `afterEach` is already too late), where React
 * reports it as an update outside act.
 *
 * Three passes is what absorbs it at the 0ms mock latency above; at higher
 * latency the warning comes back, and no in-test predicate does better, because
 * the read counter can go quiet before the broadcast is even delivered. So this
 * suppresses noise rather than fixing anything: it gates no assertion, and the
 * warning reappearing is its only failure mode. The fix belongs in the hook.
 */
async function settle() {
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
}
/** Wait for the activation screen's request box to paint, then hand it over. */
async function requestBox(): Promise<HTMLTextAreaElement> {
  await actUntil("the request textarea", () => host.querySelector("textarea") !== null, 1_000);
  return host.querySelector("textarea")!;
}
/**
 * Wait for Talk's own composer box. "Any textarea" would also match the
 * activation screen's, which carries the same text and is disabled while the
 * handoff is pending -- so the wrong element could satisfy the assertions that
 * follow and only a later null would give it away.
 */
const COMPOSER = 'textarea[aria-label="Message Jarvis"]';
async function composerBox(): Promise<HTMLTextAreaElement> {
  await actUntil("the Talk composer", () => host.querySelector(COMPOSER) !== null, 1_000);
  return host.querySelector<HTMLTextAreaElement>(COMPOSER)!;
}
async function enter(el: HTMLTextAreaElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("first workflow activation", () => {
  test("starts empty, offers editable examples and hands off only on a deliberate click", async () => {
    const requests: Array<string | undefined> = [];
    await mount(<WorkflowActivation onContinue={(prompt) => { requests.push(prompt); }} />);
    expect(button("Review request in Talk").disabled).toBe(true);
    await click("Weekly update");
    expect(host.querySelector("textarea")!.value).toContain("Every Friday");
    expect(requests).toEqual([]);
    await enter(host.querySelector("textarea")!, "  Summarize my sales notes each Monday.  ");
    await click("Review request in Talk");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("\n\nSummarize my sales notes each Monday.\n\n");
    expect(requests[0]).toContain("Do not publish, enable or run");
    expect(requests[0]).toContain("any missing details or connections");
  });

  test("Explore Jarvis first skips without fabricating a workflow request", async () => {
    const requests: Array<string | undefined> = [];
    await mount(<WorkflowActivation onContinue={(prompt) => { requests.push(prompt); }} />);
    await click("Competitor brief");
    await click("Explore Jarvis first");
    expect(requests).toEqual([undefined]);
  });

  test("blocks duplicate handoffs and keeps the task when opening fails", async () => {
    let fail!: (error: Error) => void;
    let count = 0;
    await mount(<WorkflowActivation onContinue={() => {
      count++;
      return new Promise<void>((_, reject) => { fail = reject; });
    }} />);
    await enter(host.querySelector("textarea")!, "Prepare my weekly update");
    await act(async () => {
      const next = button("Review request in Talk");
      next.click();
      next.click();
    });
    expect(count).toBe(1);
    await act(async () => fail(new Error("Unavailable")));
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("Your task is still here");
    expect(host.querySelector("textarea")!.value).toBe("Prepare my weekly update");
    expect(button("Review request in Talk").disabled).toBe(false);
  });
});

const AT_TOUR = {
  setup_completed: true, setup_completed_at: 1, setup_skipped_profile: true,
  profile_completed: false, tutorial_completed: false, tutorial_completed_at: null,
  tutorial_dismissed: false, tutorial_progress_step: null, last_reset_at: null,
  post_setup_services_ready: true,
};

// Use the same draft hook and Composer as ShellLayout, without loading the
// daemon's unrelated room/voice services. The gate and wizard are real.
function TalkHarness({ connected, onSubmit }: { connected: boolean; onSubmit: (text: string) => void }) {
  const { open, setOpen, draft, setDraft } = useTalkDraft();
  return <section aria-label="Shell">
    <button onClick={() => setOpen(!open)}>{open ? "Close Talk" : "Open Talk"}</button>
    {open && <Composer value={draft} onValueChange={setDraft} autoFocus disabled={!connected} onSubmit={onSubmit} />}
  </section>;
}

test("the request survives the gate refresh, waits for connection, preserves edits on reopen and never sends itself", async () => {
  const sent: string[] = [];
  let finishRefresh: (() => void) | undefined;
  let statusReads = 0;
  let servicesReady = true;
  globalThis.fetch = (async (url: string) => {
    await tick();
    if (String(url) === "/api/onboarding/status") {
      if (++statusReads === 1) return Response.json(AT_TOUR);
      if (statusReads > 2) return Response.json({ ...AT_TOUR, tutorial_dismissed: true, post_setup_services_ready: servicesReady });
      return new Promise<Response>((resolve) => {
        finishRefresh = () => resolve(Response.json({ ...AT_TOUR, tutorial_dismissed: true }));
      });
    }
    return Response.json({ hosted_llm: true });
  }) as never;
  const view = (connected: boolean) => <OnboardingGate><TalkHarness connected={connected} onSubmit={(text) => sent.push(text)} /></OnboardingGate>;
  await mount(view(false));
  // Skipping the tour POSTs the dismissal before the activation screen exists,
  // so the screen has to be waited for, not assumed.
  await click("Skip tour");
  await enter(await requestBox(), "Prepare a weekly update from my notes");
  await click("Review request in Talk");
  // Assert the no-flash with the refresh genuinely in flight: the mock has been
  // entered (it is what hands back `finishRefresh`) and is holding the response.
  await actUntil("the gate's status refresh", () => finishRefresh !== undefined, 1_000);
  expect(host.querySelector('[aria-label="Shell"]')).toBeNull();
  expect(sent).toEqual([]);
  await act(async () => finishRefresh!());
  let input = await composerBox();
  expect(input.value).toContain("Prepare a weekly update from my notes");
  expect(input.disabled).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click());
  expect(sent).toEqual([]);
  await act(async () => root!.render(view(true)));
  input = await composerBox();
  expect(document.activeElement === input).toBe(true);
  await enter(input, "Draft a workflow for my Friday update. Ask me which notes to use; do not enable it.");
  // A peer tab/status broadcast and a restart-banner transition must not
  // remount the shell or overwrite an edited request after consumption.
  const channel = new BroadcastChannel("v2-onboarding-status");
  try {
    for (const ready of [false, true]) {
      servicesReady = ready;
      const reads = statusReads;
      await act(async () => channel.postMessage({ type: "status_changed" }));
      // The banner flips only once the broadcast-triggered refresh has landed.
      await actUntil("the broadcast refresh", () =>
        statusReads > reads && (host.querySelector(".v2-restart-banner") !== null) === !ready);
      expect(host.querySelector("textarea")!.value).toContain("my Friday update");
      expect(host.querySelector(".v2-restart-banner") !== null).toBe(!ready);
    }
  } finally { channel.close(); }
  await click("Close Talk");
  await click("Open Talk");
  expect((await composerBox()).value).toContain("my Friday update");
  expect(sent).toEqual([]);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click());
  expect(sent).toEqual(["Draft a workflow for my Friday update. Ask me which notes to use; do not enable it."]);
  await click("Close Talk");
  await click("Open Talk");
  expect((await composerBox()).value).toBe("");
  expect(sent).toHaveLength(1);
});

test("a failed completion refresh retains the activation task and can be retried", async () => {
  let reads = 0;
  let failRefresh = true;
  globalThis.fetch = (async (url: string) => {
    await tick();
    if (String(url) === "/api/onboarding/status") {
      if (++reads === 1) return Response.json(AT_TOUR);
      if (failRefresh) return new Response("Unavailable", { status: 503 });
      return Response.json({ ...AT_TOUR, tutorial_dismissed: true });
    }
    return Response.json({ hosted_llm: true });
  }) as never;
  const sent: string[] = [];
  await mount(<OnboardingGate><TalkHarness connected onSubmit={(text) => sent.push(text)} /></OnboardingGate>);
  await click("Skip tour");
  await enter(await requestBox(), "Prepare my Friday update");
  const retryDelay = STATUS_RETRY.delayMs;
  STATUS_RETRY.delayMs = 0;
  try {
    await click("Review request in Talk");
    await actUntil("the refresh failure", () => host.querySelector('[role="alert"]') !== null);
  } finally {
    STATUS_RETRY.delayMs = retryDelay;
  }
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("Your task is still here");
  expect(host.querySelector("textarea")!.value).toBe("Prepare my Friday update");
  failRefresh = false;
  await click("Review request in Talk");
  await actUntil("the dashboard", () => host.querySelector('[aria-label="Shell"]') !== null);
  expect(host.querySelector('[aria-label="Shell"]')).not.toBeNull();
  expect((await composerBox()).value).toContain("Prepare my Friday update");
  expect(sent).toEqual([]);
  await settle();
});

const NEW_INSTALL = {
  setup_completed: false, setup_completed_at: null, setup_skipped_profile: false,
  profile_completed: false, tutorial_completed: false, tutorial_completed_at: null,
  tutorial_dismissed: false, tutorial_progress_step: null, last_reset_at: null,
};

test("a skip that saves but cannot load the dashboard says so, and retrying works", async () => {
  let statusReads = 0;
  let failRefresh = true;
  const skips: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    await tick();
    if (String(url) === "/api/onboarding/skip") {
      skips.push(init?.method ?? "GET");
      return Response.json({ ok: true });
    }
    if (String(url) === "/api/onboarding/status") {
      if (++statusReads === 1) return Response.json(NEW_INSTALL);
      if (failRefresh) return new Response("Unavailable", { status: 503 });
      return Response.json({ ...NEW_INSTALL, setup_completed: true, setup_skipped_profile: true, tutorial_dismissed: true, post_setup_services_ready: true });
    }
    return Response.json({ hosted_llm: true });
  }) as never;
  const retryDelay = STATUS_RETRY.delayMs;
  STATUS_RETRY.delayMs = 0;
  try {
    await mount(<OnboardingGate><section aria-label="Shell" /></OnboardingGate>);
    const later = () => buttons().find((el) => el.textContent?.includes("do this later"));
    await actUntil("the skip button", () => later() !== undefined, 1_000);
    await act(async () => later()!.click());
    // Settled: an error is showing and the button is usable again.
    await actUntil("the skip to settle", () =>
      /Skip saved|Couldn't save the skip|Couldn't reach the daemon/.test(host.textContent ?? "") && later()?.disabled === false);
    expect(host.textContent).toContain("Skip saved, but Jarvis couldn't load your dashboard");
    expect(host.textContent).not.toContain("Couldn't save the skip");
    expect(statusReads).toBe(4); // the initial read, then all three refresh attempts
    failRefresh = false;
    await act(async () => later()!.click());
    await actUntil("the dashboard", () => host.querySelector('[aria-label="Shell"]') !== null);
    expect(skips).toEqual(["POST", "POST"]);
    await settle();
  } finally {
    STATUS_RETRY.delayMs = retryDelay;
  }
});
