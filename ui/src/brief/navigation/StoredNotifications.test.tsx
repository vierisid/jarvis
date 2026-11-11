import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { BriefCapabilities } from "../../../../src/brief/capabilities";
import { registerNavigationCompatibility } from "../../../../src/brief/registrations/navigation-compatibility";
import { NavigationCompatibility } from "./controller";
import { dashboardAttentionSnapshot } from "./notifications";

GlobalRegistrator.register({ url: "http://localhost:4426/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let Attention: typeof import("./AttentionRoutes").AttentionRoutes;
let useCenter: typeof import("../../hooks/useNotificationCenter").useNotificationCenter;
let storedNotice: typeof import("../../hooks/useWebSocket").storedNotice;
let root: ReturnType<typeof createRoot>, element: HTMLDivElement;
const originalFetch = globalThis.fetch;
const posts: string[] = [];
const cap = new BriefCapabilities(registerNavigationCompatibility(() => ({ destinations: true, guardedNavigation: true, roomIntents: true, notificationsOutsideChat: true })), ["navigationCompatibility"]).snapshot();

beforeAll(async () => {
  React = await import("react"); ({ createRoot } = await import("react-dom/client"));
  ({ AttentionRoutes: Attention } = await import("./AttentionRoutes"));
  ({ useNotificationCenter: useCenter } = await import("../../hooks/useNotificationCenter"));
  ({ storedNotice } = await import("../../hooks/useWebSocket"));
});
beforeEach(() => {
  localStorage.clear(); posts.length = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => { posts.push(`${init?.method ?? "GET"} ${url}`); return new Response("{}"); }) as unknown as typeof fetch;
  element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await React.act(async () => root.unmount()); element.remove(); globalThis.fetch = originalFetch; });
afterAll(() => GlobalRegistrator.unregister());

/** The Needs you list as the dashboard wires it, fed one notification saved on the daemon. */
function Harness() {
  const notices = React.useMemo(() => [storedNotice({ id: "n1", message: "**Stand-up**\nStart at 9:00", priority: "normal", created_at: 1000 })], []);
  const center = useCenter({ approvals: [], clarifiers: [], repeatBacks: [], notices });
  const nav = React.useMemo(() => { const n = new NavigationCompatibility({ roomAvailable: () => false, canLeave: async () => true, commit() {}, explain() {} }); n.setAccess(cap); return n; }, []);
  return <Attention snapshot={dashboardAttentionSnapshot(true, center.items, {})} navigation={nav} roomAvailable={() => false} markRead={identity => center.markRead(identity.id)} />;
}

test("a notification saved while the dashboard was closed shows as unread, and reading it tells the daemon", async () => {
  await React.act(async () => root.render(<Harness />));
  const card = element.querySelector(".brief-attention-item");
  expect(card?.querySelector("h3")?.textContent).toBe("Stand-up");
  expect(card?.querySelector("p")?.textContent).toBe("Start at 9:00");
  const button = card!.querySelector("button")!;
  expect(button.textContent).toBe("Mark as read");
  await React.act(async () => button.click());
  expect(posts).toEqual(["POST /api/dashboard-notifications/n1/read"]);
  expect(element.querySelector(".brief-attention-item button")?.textContent).toBe("Read");
});
