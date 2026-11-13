/**
 * "Finish later" opens the dashboard without saving anything, under both gates
 * (the classic one and the Brief one). Setup stays incomplete, so the next load
 * resumes it. A person with no AI key must not be able to get stuck behind it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let Gate: typeof import("./OnboardingGate").OnboardingGate;
let BriefHost: typeof import("./OnboardingGate").BriefOnboardingHost;
const realFetch = globalThis.fetch;
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;
let posts: string[] = [];

const fresh = {
  setup_completed: false, setup_completed_at: null, setup_skipped_profile: false, profile_completed: false,
  tutorial_completed: false, tutorial_completed_at: null, tutorial_dismissed: false, tutorial_progress_step: null,
  last_reset_at: null,
};

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ OnboardingGate: Gate, BriefOnboardingHost: BriefHost } = await import("./OnboardingGate"));
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove(); root = null; container = null;
});
afterAll(() => { globalThis.fetch = realFetch; GlobalRegistrator.unregister(); });

const snapshot = { routine: null, request: null, storageFailed: false };
const stubDraft = { scope: "test", subscribe: () => () => {}, getSnapshot: () => snapshot, clear: () => {} };

async function mount(brief: boolean) {
  posts = [];
  globalThis.fetch = (async (input: string, init?: { method?: string }) => {
    const url = String(input);
    if (init?.method === "POST") posts.push(url);
    if (url === "/api/onboarding/status") return Response.json(fresh);
    if (url === "/api/config/llm") return Response.json({ hosted_llm: false });
    if (url === "/api/system/permissions") return Response.json({ available: false, reason: "no_sidecar" });
    return Response.json({});
  }) as never;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  const gate = <Gate brief={brief ? (stubDraft as never) : undefined}><main>The dashboard</main></Gate>;
  await act(async () => { root!.render(brief ? <BriefHost>{gate}</BriefHost> : gate); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}
const click = (text: RegExp) => act(async () => {
  const b = Array.from(container!.querySelectorAll("button")).find((x) => text.test(x.textContent || ""));
  if (!b) throw new Error(`no button ${text}`);
  b.click();
});

describe.each([["classic", false], ["Brief", true]] as const)("%s gate", (_name, brief) => {
  test("Finish later from the setup steps opens the dashboard and saves nothing", async () => {
    await mount(brief);
    await click(/^Set up Jarvis$/);
    expect(container!.textContent).toContain("Permissions");
    expect(container!.textContent).not.toContain("The dashboard");
    await click(/^Finish later$/);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(container!.textContent).toContain("The dashboard");
    expect(posts.filter((u) => u === "/api/onboarding/setup" || u === "/api/onboarding/skip")).toEqual([]);
  });
});
