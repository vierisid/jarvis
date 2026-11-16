/**
 * A self-hosted person with no AI key must never be trapped in setup: they can
 * step back from the first screen, leave from any setup step without anything
 * being marked complete, and skip the AI step to reach the dashboard.
 *
 * Assertions are on what the wizard actually sent (fetch stub) and on the
 * callbacks the host gave it, so a leave that quietly saved setup, or a skip
 * that sent a provider nobody tested, fails here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let OnboardingWizard: typeof import("./OnboardingWizard").OnboardingWizard;
type OnboardingStatus = import("./useOnboardingStatus").OnboardingStatus;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ OnboardingWizard } = await import("./OnboardingWizard"));
});
afterAll(() => {
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

const FRESH: OnboardingStatus = {
  setup_completed: false, setup_completed_at: null, setup_skipped_profile: false, profile_completed: false,
  tutorial_completed: false, tutorial_completed_at: null, tutorial_dismissed: false, tutorial_progress_step: null,
  last_reset_at: null,
};

type Sent = { url: string; body: Record<string, unknown> | null };
const sent: Sent[] = [];
const calls: string[] = [];
let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

/** The host's setup-only wizard, as the optional onboarding journey mounts it. */
async function mount(props: { onBack?: boolean; onLeave?: boolean } = { onBack: true, onLeave: true }) {
  sent.length = 0; calls.length = 0;
  globalThis.fetch = (async (input: string, init?: { body?: string }) => {
    const url = String(input);
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = null; } }
    sent.push({ url, body });
    if (url === "/api/config/llm") return json({ hosted_llm: false });
    if (url === "/api/config/llm/test") return json({ ok: true, model: "m" });
    return json({});
  }) as never;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<OnboardingWizard status={FRESH} setupOnly
      onComplete={() => { calls.push("complete"); }}
      {...(props.onBack ? { onBack: () => { calls.push("back"); } } : {})}
      {...(props.onLeave ? { onLeave: (o: { setupSaved: boolean }) => { calls.push(o.setupSaved ? "leave:saved" : "leave"); } } : {})} />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); root = null; host = null;
});

const buttons = () => Array.from(host!.querySelectorAll("button"));
const find = (text: RegExp) => buttons().find((b) => text.test(b.textContent || ""));
function button(text: RegExp): HTMLButtonElement {
  const found = find(text);
  if (!found) throw new Error(`no button matching ${text}; have: ${buttons().map((b) => b.textContent).join(" | ")}`);
  return found;
}
const click = (text: RegExp) => act(async () => button(text).click());
const savedAnything = () => sent.some((s) => s.url === "/api/onboarding/setup" || s.url === "/api/onboarding/skip");

describe("leaving setup", () => {
  test("Back on the first step is enabled and hands control to the host", async () => {
    await mount();
    expect(host!.textContent).toContain("Step 1 of 4");
    expect(button(/^Back$/).disabled).toBe(false);
    await click(/^Back$/);
    expect(calls).toEqual(["back"]);
  });

  test("Back stays off on the first step when the host has no earlier screen", async () => {
    await mount({});
    expect(button(/^Back$/).disabled).toBe(true);
    expect(find(/^Finish later$/)).toBeUndefined();
  });

  test("Finish later is offered on every setup step and never saves setup", async () => {
    await mount();
    const offered = () => find(/^Finish later$/) !== undefined;
    expect(offered()).toBe(true); // permissions
    await click(/^Continue$/);
    expect(host!.textContent).toContain("Pick a brain for Jarvis.");
    expect(offered()).toBe(true);
    await click(/^Skip for now$/);
    expect(host!.textContent).toContain("How should Jarvis hear you?");
    expect(offered()).toBe(true);
    await click(/^Continue$/);
    expect(host!.textContent).toContain("Speaking");
    expect(offered()).toBe(true);
    await click(/^Finish later$/);
    expect(calls).toEqual(["leave"]);
    expect(savedAnything()).toBe(false);
  });
});

describe("skipping the AI step", () => {
  async function toBrain() {
    await mount();
    await click(/^Continue$/);
    expect(host!.textContent).toContain("Pick a brain for Jarvis.");
  }

  test("is possible without a tested connection and says what stays off", async () => {
    await toBrain();
    expect(button(/^Continue$/).disabled).toBe(true);
    expect(host!.textContent).toContain("skip for now");
    expect(host!.textContent).toContain("chat and workflows stay off");
    await click(/^Skip for now$/);
    expect(host!.textContent).toContain("How should Jarvis hear you?");
  });

  test("saves setup with no AI provider and lands in the dashboard, not the journey", async () => {
    await toBrain();
    await click(/^Skip for now$/);
    await click(/^Continue$/); // hearing
    await click(/^Continue$/); // speaking: the setup POST
    const setup = sent.find((s) => s.url === "/api/onboarding/setup");
    expect(setup).toBeDefined();
    expect(setup!.body).not.toHaveProperty("llm");
    expect(sent.some((s) => s.url === "/api/config/llm/test")).toBe(false);
    expect(calls).toEqual(["leave:saved"]);
  });

  test("is not offered when the host has no way into the dashboard", async () => {
    await mount({ onBack: true });
    await click(/^Continue$/);
    expect(host!.textContent).toContain("Pick a brain for Jarvis.");
    expect(find(/^Skip for now$/)).toBeUndefined();
    expect(host!.textContent).not.toContain("skip for now");
  });

  test("a key that passes Test connection continues exactly as before", async () => {
    await toBrain();
    const key = host!.querySelector<HTMLInputElement>('.obw-provdetail input[type="password"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(key, "sk-ant-typed"); key.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(/^Test connection$/);
    await click(/^Continue$/); // brain
    await click(/^Continue$/); // hearing
    await click(/^Continue$/); // speaking: the setup POST
    const setup = sent.find((s) => s.url === "/api/onboarding/setup");
    expect((setup!.body as { llm: { providers: Record<string, unknown> } }).llm.providers).toHaveProperty("anthropic");
    expect(calls).toEqual(["complete"]);
  });

  test("skipping, then going back and testing a key, saves the key", async () => {
    await toBrain();
    await click(/^Skip for now$/);
    await click(/^Back$/);
    const key = host!.querySelector<HTMLInputElement>('.obw-provdetail input[type="password"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(key, "sk-ant-typed"); key.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(/^Test connection$/);
    await click(/^Continue$/);
    await click(/^Continue$/);
    await click(/^Continue$/);
    const setup = sent.find((s) => s.url === "/api/onboarding/setup");
    expect(setup!.body).toHaveProperty("llm");
    expect(calls).toEqual(["complete"]);
  });
});
