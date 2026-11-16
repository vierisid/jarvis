import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let useBilling: typeof import("./useBilling").useBilling;
let root: ReturnType<typeof createRoot>, host: HTMLDivElement, originalFetch: typeof fetch, calls: string[];

beforeAll(async () => {
  GlobalRegistrator.register({ url: "https://instance.test/" });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ useBilling } = await import("./useBilling"));
});
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  originalFetch = globalThis.fetch; calls = [];
  globalThis.fetch = (async (path: RequestInfo | URL) => {
    calls.push(String(path));
    return Response.json({ error: "Billing is not available on self-hosted installs" }, { status: 503 });
  }) as typeof fetch;
});
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; });
afterAll(() => GlobalRegistrator.unregister());

function Probe({ enabled }: { enabled?: boolean }) {
  const billing = useBilling({ refreshOnMount: false, enabled });
  return <p>{billing.state}</p>;
}

test("a caller that knows the install is self-hosted reads self and never requests billing", async () => {
  await React.act(async () => root.render(<Probe enabled={false} />));
  expect(host.textContent).toBe("self");
  expect(calls).toEqual([]);
});

test("billing is still read by default", async () => {
  await React.act(async () => root.render(<Probe />));
  expect(calls).toEqual(["/api/billing"]);
});
