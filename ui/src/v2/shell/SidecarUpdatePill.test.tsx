import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let SidecarUpdatePill: typeof import("./SidecarUpdatePill").SidecarUpdatePill;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ SidecarUpdatePill } = await import("./SidecarUpdatePill"));
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  globalThis.fetch = originalFetch;
  window.location.hash = "";
});
afterAll(() => GlobalRegistrator.unregister());

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<SidecarUpdatePill />); });
  // Let the first poll land.
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}

const sidecar = {
  id: "sid-1", name: "laptop", hostname: "laptop.local", connected: true, os: "windows",
  version: "0.9.7", latest_version: "0.10.0", update_available: true, features: ["update_prompt"],
};

test("hidden when every sidecar is current", async () => {
  globalThis.fetch = (async () => NativeResponse.json([{ ...sidecar, update_available: false }])) as unknown as typeof fetch;
  await mount();
  expect(host.querySelector("button")).toBeNull();
});

test("opens the sidecar's own update prompt", async () => {
  const posts: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posts.push(url); return NativeResponse.json({ ok: true }); }
    return NativeResponse.json([sidecar]);
  }) as unknown as typeof fetch;
  await mount();
  const button = host.querySelector("button");
  expect(button?.textContent).toContain("sidecar update");
  await act(async () => { button!.click(); await new Promise((r) => setTimeout(r, 10)); });
  expect(posts).toEqual(["/api/sidecars/sid-1/update-prompt"]);
  expect(host.querySelector('[role="status"]')?.textContent).toContain("laptop.local");
});

test("several outdated sidecars go to Settings > Sidecar", async () => {
  globalThis.fetch = (async () => NativeResponse.json([sidecar, { ...sidecar, id: "sid-2", name: "desktop" }])) as unknown as typeof fetch;
  await mount();
  const button = host.querySelector("button");
  expect(button?.textContent).toContain("2 sidecar updates");
  await act(async () => { button!.click(); });
  expect(window.location.hash).toBe("#/_room_settings");
});
