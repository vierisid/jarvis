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
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ WorkflowActivation } = await import("./WorkflowActivation"));
  ({ OnboardingGate } = await import("./OnboardingGate"));
  ({ Composer } = await import("../shell/Composer"));
  ({ useTalkDraft } = await import("../shell/useTalkDraft"));
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  globalThis.fetch = realFetch;
});
afterAll(() => GlobalRegistrator.unregister());

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}
const button = (text: string) => [...host.querySelectorAll("button")].find((el) => el.textContent?.trim() === text)!;
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
    await act(async () => button("Weekly update").click());
    expect(host.querySelector("textarea")!.value).toContain("Every Friday");
    expect(requests).toEqual([]);
    await enter(host.querySelector("textarea")!, "  Summarize my sales notes each Monday.  ");
    await act(async () => button("Review request in Talk").click());
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("\n\nSummarize my sales notes each Monday.\n\n");
    expect(requests[0]).toContain("Do not publish, enable or run");
    expect(requests[0]).toContain("any missing details or connections");
  });

  test("Explore Jarvis first skips without fabricating a workflow request", async () => {
    const requests: Array<string | undefined> = [];
    await mount(<WorkflowActivation onContinue={(prompt) => { requests.push(prompt); }} />);
    await act(async () => button("Competitor brief").click());
    await act(async () => button("Explore Jarvis first").click());
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
  let finishRefresh!: () => void;
  let statusReads = 0;
  let servicesReady = true;
  globalThis.fetch = (async (url: string) => {
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
  await act(async () => button("Skip tour").click());
  expect(host.textContent).not.toContain("Profile saved");
  await enter(host.querySelector("textarea")!, "Prepare a weekly update from my notes");
  await act(async () => button("Review request in Talk").click());
  expect(host.querySelector('[aria-label="Shell"]')).toBeNull();
  expect(sent).toEqual([]);
  await act(async () => finishRefresh());
  let input = host.querySelector("textarea")!;
  expect(input.value).toContain("Prepare a weekly update from my notes");
  expect(input.disabled).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click());
  expect(sent).toEqual([]);
  await act(async () => root!.render(view(true)));
  input = host.querySelector("textarea")!;
  expect(document.activeElement === input).toBe(true);
  await enter(input, "Draft a workflow for my Friday update. Ask me which notes to use; do not enable it.");
  // A peer tab/status broadcast and a restart-banner transition must not
  // remount the shell or overwrite an edited request after consumption.
  const channel = new BroadcastChannel("v2-onboarding-status");
  try {
    for (const ready of [false, true]) {
      servicesReady = ready;
      await act(async () => {
        channel.postMessage({ type: "status_changed" });
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      expect(host.querySelector("textarea")!.value).toContain("my Friday update");
      expect(host.querySelector(".v2-restart-banner") !== null).toBe(!ready);
    }
  } finally { channel.close(); }
  await act(async () => button("Close Talk").click());
  await act(async () => button("Open Talk").click());
  expect(host.querySelector("textarea")!.value).toContain("my Friday update");
  expect(sent).toEqual([]);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click());
  expect(sent).toEqual(["Draft a workflow for my Friday update. Ask me which notes to use; do not enable it."]);
  await act(async () => button("Close Talk").click());
  await act(async () => button("Open Talk").click());
  expect(host.querySelector("textarea")!.value).toBe("");
  expect(sent).toHaveLength(1);
});

test("a failed completion refresh retains the activation task and can be retried", async () => {
  let reads = 0;
  let failRefresh = true;
  globalThis.fetch = (async (url: string) => {
    if (String(url) === "/api/onboarding/status") {
      if (++reads === 1) return Response.json(AT_TOUR);
      if (failRefresh) return new Response("Unavailable", { status: 503 });
      return Response.json({ ...AT_TOUR, tutorial_dismissed: true });
    }
    return Response.json({ hosted_llm: true });
  }) as never;
  const sent: string[] = [];
  await mount(<OnboardingGate><TalkHarness connected onSubmit={(text) => sent.push(text)} /></OnboardingGate>);
  await act(async () => button("Skip tour").click());
  await enter(host.querySelector("textarea")!, "Prepare my Friday update");
  await act(async () => {
    button("Review request in Talk").click();
    await new Promise((resolve) => setTimeout(resolve, 2300));
  });
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("Your task is still here");
  expect(host.querySelector("textarea")!.value).toBe("Prepare my Friday update");
  failRefresh = false;
  await act(async () => button("Review request in Talk").click());
  expect(host.querySelector('[aria-label="Shell"]')).not.toBeNull();
  expect(host.querySelector("textarea")!.value).toContain("Prepare my Friday update");
  expect(sent).toEqual([]);
});
