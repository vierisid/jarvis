import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
const NativeResponse = globalThis.Response,
  originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import("react").act,
  createRoot: typeof import("react-dom/client").createRoot;
let Connection: typeof import("./PipedriveConnection").PipedriveConnection;
let root: ReturnType<typeof createRoot> | undefined, host: HTMLDivElement;
beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ PipedriveConnection: Connection } = await import("./PipedriveConnection"));
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());
const status = {
  configured: true,
  connected: false,
  connect_url: "https://app.usejarvis.dev/account?integration=pipedrive",
  external_id: "jarvis:pipedrive",
  account: null,
  workspaces: [],
  generation: null,
};
async function mount(element: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
  });
}
test("onboarding uses Google card design, OAuth link and connected status after return", async () => {
  let reply: any = status;
  globalThis.fetch = (async () => NativeResponse.json(reply)) as any;
  await mount(<Connection appearance="onboarding" />);
  expect(host.querySelector(".on-google__service")).not.toBeNull();
  expect(host.querySelector("a")?.getAttribute("href")).toBe(
    status.connect_url,
  );
  expect(host.querySelector("textarea")).toBeNull();
  reply = {
    ...status,
    connected: true,
    account: { id: "USER1", label: "Owner" },
    workspaces: [{ id: "ACCOUNT1", name: "Sandbox" }],
    generation: "new",
  };
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(host.textContent).toContain("Connected as Owner");
  expect(host.querySelector("a")?.textContent).toContain("Manage");
});
test("inline connection selects the managed credential without asking for a token", async () => {
  globalThis.fetch = (async () =>
    NativeResponse.json({
      ...status,
      connected: true,
      account: { id: "U", label: "Owner" },
      workspaces: [],
      generation: "new",
    })) as any;
  const picks: string[] = [];
  await mount(<Connection onPick={(v) => picks.push(v)} />);
  await act(async () => {
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent === "Use this account")!
      .click();
  });
  expect(picks).toEqual(["{{connections.jarvis:pipedrive}}"]);
  expect(host.querySelector("input,textarea")).toBeNull();
});
test("failed status offers a retry and recovers", async () => {
  let broken = true;
  globalThis.fetch = (async () =>
    broken
      ? new NativeResponse("", { status: 502 })
      : NativeResponse.json(status)) as any;
  await mount(<Connection appearance="onboarding" />);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not check Pipedrive",
  );
  broken = false;
  await act(async () => {
    Array.from(host.querySelectorAll("button"))
      .find((b) => b.textContent === "Try again")!
      .click();
  });
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
test("reconnect and unavailable states remain actionable", async () => {
  globalThis.fetch = (async () =>
    NativeResponse.json({ ...status, reconnect: true })) as any;
  await mount(<Connection />);
  expect(host.textContent).toContain("needs reconnecting");
  expect(host.querySelector("a")?.textContent).toBe("Connect Pipedrive");
});
test("onboarding reconnect wording covers revocation as well as expiry", async () => {
  globalThis.fetch = (async () =>
    NativeResponse.json({ ...status, reconnect: true })) as any;
  await mount(<Connection appearance="onboarding" />);
  expect(host.textContent).toContain(
    "Pipedrive refused this connection. Reconnect Pipedrive.",
  );
  expect(host.textContent).not.toContain("expired");
});
