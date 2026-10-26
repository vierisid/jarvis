/**
 * #1105: the gate picks F-26's Brief onboarding adapter by the host it
 * renders inside, not by a ?brief=1 URL flag.
 *
 * A released rollout mounts Brief through foreground aliases (#/,
 * #/_room_memory, ...) with no brief parameter, so a URL check sent Brief
 * users to the classic wizard. The reverse also held: the current dashboard
 * opened with ?brief=1 (rollout off, so it is NOT Brief) picked the Brief
 * adapter. Both are pinned here through the real DashboardEntry and the real
 * OnboardingGate. Which adapter mounted is read off the draft port: only the
 * Brief adapter subscribes to the draft.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { BriefShellPort } from "../contracts";
import { BRIEF_ROOM_IDS } from "../contracts";
import { UNKNOWN_NAVIGATION } from "../shell/navigation/model";
import { releaseExample } from "./release.test-support";
import type { DashboardEntryProps } from "./DashboardEntry";
import type { OnboardingDraft } from "../onboarding/draft";
import type { OnboardingStatus } from "../../v2/onboarding/useOnboardingStatus";

GlobalRegistrator.register({ url: "http://localhost:4381/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let Entry: typeof import("./DashboardEntry").DashboardEntry;
let OnboardingGate: typeof import("../../v2/onboarding/OnboardingGate").OnboardingGate;
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement;
const originalFetch = globalThis.fetch;

const COMPLETE: OnboardingStatus = {
  setup_completed: true, setup_completed_at: 1, setup_skipped_profile: false, profile_completed: true,
  tutorial_completed: true, tutorial_completed_at: 1, tutorial_dismissed: false, tutorial_progress_step: null,
  last_reset_at: null,
};

let subscriptions = 0;
const SNAPSHOT = { routine: "", request: null, job: null, busy: false, error: null, storageFailed: false };
/** The draft port the gate reads. Only BriefOnboardingGate subscribes to it. */
const draft = {
  scope: "account-1",
  subscribe: () => { subscriptions++; return () => {}; },
  getSnapshot: () => SNAPSHOT,
} as unknown as OnboardingDraft;

beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ DashboardEntry: Entry } = await import("./DashboardEntry"));
  ({ OnboardingGate } = await import("../../v2/onboarding/OnboardingGate"));
});
beforeEach(() => {
  subscriptions = 0;
  localStorage.clear();
  globalThis.fetch = (async (input: unknown) => {
    if (String(input) === "/api/onboarding/status") return Response.json(COMPLETE);
    return Response.json({});
  }) as unknown as typeof fetch;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await React.act(async () => root?.unmount()); root = null; host.remove();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

/** How a host that owns a draft would supply it: through the injectable Gate. */
function DraftGate({ children }: { children: React.ReactNode }) {
  return <OnboardingGate brief={draft}>{children}</OnboardingGate>;
}
/** The current dashboard owns its own gate, as AppShellV2 does. */
function Legacy() {
  return <OnboardingGate brief={draft}><div>Current dashboard</div></OnboardingGate>;
}

function releasedProps(): DashboardEntryProps {
  const { config, runtime } = releaseExample();
  config.rollout = "released";
  function Body({ shell }: { shell: BriefShellPort }) { return <p>Test room: {shell.route.room}</p>; }
  return {
    legacy: <Legacy />, Gate: DraftGate, release: config, runtime,
    rooms: Object.fromEntries(BRIEF_ROOM_IDS.map(id => [id, { id, title: id, Body }])),
    navigation: { capabilities: { contractVersion: 1, asOf: 1, capabilities: {
      navigationCompatibility: { supported: true, ready: true, enabled: true, state: "ready", reason: null },
    } }, view: { source: "live", state: { status: "ready", data: UNKNOWN_NAVIGATION } } },
    conversation: { source: "live", content: <textarea aria-label="Conversation" /> },
  };
}

async function mount(url: string, props: DashboardEntryProps) {
  history.replaceState(null, "", url);
  await React.act(async () => root!.render(<Entry {...props} />));
  for (let i = 0; i < 50 && !host.textContent; i++) {
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

test("a released foreground alias with no brief parameter gets the Brief onboarding adapter", async () => {
  await mount("http://localhost:4381/#/_room_memory", releasedProps());
  expect(host.textContent).toContain("Test room: memory");
  expect(new URL(location.href).searchParams.has("brief")).toBe(false);
  expect(subscriptions).toBeGreaterThan(0);
});

test("the released root alias gets the Brief onboarding adapter too", async () => {
  await mount("http://localhost:4381/#/", releasedProps());
  expect(host.textContent).toContain("Test room: today");
  expect(subscriptions).toBeGreaterThan(0);
});

test("the current dashboard keeps the classic gate even when the URL says ?brief=1", async () => {
  // Rollout off (the shipped default) and no devtools: this is the legacy dashboard.
  await mount("http://localhost:4381/?brief=1#/_room_memory", { legacy: <Legacy />, Gate: DraftGate });
  expect(host.textContent).toBe("Current dashboard");
  expect(subscriptions).toBe(0);
});

test("the gate on its own, outside any Brief host, never picks the Brief adapter", async () => {
  history.replaceState(null, "", "http://localhost:4381/?brief=1#/brief/today");
  await React.act(async () => root!.render(<OnboardingGate brief={draft}><div>Shell</div></OnboardingGate>));
  for (let i = 0; i < 50 && !host.textContent; i++) {
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  expect(host.textContent).toBe("Shell");
  expect(subscriptions).toBe(0);
});

test("the Brief moved-room notice is inside Brief too", async () => {
  // Only the developer-tools review path can reach the moved notice (D-33).
  localStorage.setItem("jarvis-devtools", "1");
  await mount("http://localhost:4381/?brief=1#/brief/not-a-room", { legacy: <Legacy />, Gate: DraftGate });
  expect(host.textContent).toContain("This view is not part of Brief");
  expect(subscriptions).toBeGreaterThan(0);
});
