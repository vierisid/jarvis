import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let SidecarUpdatePill: typeof import("./SidecarUpdatePill").SidecarUpdatePill;
let takeRequestedSettingsTab: typeof import("./settings-tab-request").takeRequestedSettingsTab;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
const originalConfirm = window.confirm;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ SidecarUpdatePill } = await import("./SidecarUpdatePill"));
  ({ takeRequestedSettingsTab } = await import("./settings-tab-request"));
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  globalThis.fetch = originalFetch;
  window.confirm = originalConfirm;
  window.location.hash = "";
  takeRequestedSettingsTab();
});
afterAll(() => GlobalRegistrator.unregister());

/** Poll cond inside act until it holds (no fixed sleeps: CI can be slow). */
async function waitFor(cond: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<SidecarUpdatePill />); });
}

const sidecar = {
  id: "sid-1", name: "laptop", hostname: "laptop.local", connected: true, os: "windows",
  version: "0.9.7", latest_version: "0.10.0", update_available: true, features: ["update_prompt"],
};

function serve(list: unknown[], post?: (url: string) => Response) {
  const posts: string[] = [];
  const gets = { n: 0 };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posts.push(url); return post ? post(url) : NativeResponse.json({ ok: true }); }
    gets.n++;
    return NativeResponse.json(list);
  }) as unknown as typeof fetch;
  return { posts, gets };
}

const pill = () => host.querySelector("button");
const status = () => host.querySelector('[role="status"]')?.textContent ?? "";

test("hidden when every sidecar is current, and nothing else shows", async () => {
  const { gets } = serve([{ ...sidecar, update_available: false }]);
  await mount();
  await waitFor(() => gets.n > 0, "the first poll");
  expect(pill()).toBeNull();
  expect(host.querySelector(".rs-chip")).toBeNull();
});

test("opens the sidecar's own update prompt", async () => {
  const { posts } = serve([sidecar]);
  await mount();
  await waitFor(() => pill() !== null, "the pill");
  expect(pill()!.textContent).toContain("sidecar update");
  // No empty note chip beside it.
  expect(host.querySelectorAll(".rs-chip").length).toBe(1);
  await act(async () => { pill()!.click(); });
  await waitFor(() => status().includes("laptop.local"), "the result");
  expect(posts).toEqual(["/api/sidecars/sid-1/update-prompt"]);
});

test("a Linux sidecar is confirmed here, then installed", async () => {
  const { posts } = serve([{ ...sidecar, os: "linux", features: ["update_apply"] }]);
  let asked = "";
  window.confirm = (m?: string) => { asked = String(m); return true; };
  await mount();
  await waitFor(() => pill() !== null, "the pill");
  await act(async () => { pill()!.click(); });
  await waitFor(() => posts.length === 1, "the POST");
  expect(asked).toContain("0.10.0");
  expect(posts).toEqual(["/api/sidecars/sid-1/update"]);
});

test("declining the confirmation sends nothing", async () => {
  const { posts } = serve([{ ...sidecar, os: "linux", features: ["update_apply"] }]);
  window.confirm = () => false;
  await mount();
  await waitFor(() => pill() !== null, "the pill");
  await act(async () => { pill()!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(posts).toEqual([]);
});

test("a refusal is announced", async () => {
  serve([sidecar], () => NativeResponse.json({ error: "no sidecar update is available" }, { status: 409 }));
  await mount();
  await waitFor(() => pill() !== null, "the pill");
  await act(async () => { pill()!.click(); });
  await waitFor(() => status().includes("no sidecar update is available"), "the refusal");
});

test("an install already running is not started again", async () => {
  const { posts } = serve([{ ...sidecar, update_state: { phase: "downloading", version: "0.10.0", at: new Date().toISOString() } }]);
  await mount();
  await waitFor(() => pill() !== null, "the pill");
  expect(pill()!.textContent).toContain("downloading");
  await act(async () => { pill()!.click(); });
  await waitFor(() => status().includes("Already updating"), "the note");
  expect(posts).toEqual([]);
});

test("several outdated sidecars open Settings on the Sidecar tab", async () => {
  serve([sidecar, { ...sidecar, id: "sid-2", name: "desktop" }]);
  await mount();
  await waitFor(() => pill() !== null, "the pill");
  expect(pill()!.textContent).toContain("2 sidecar updates");
  await act(async () => { pill()!.click(); });
  expect(window.location.hash).toBe("#/_room_settings");
  expect(takeRequestedSettingsTab()).toBe("sidecar");
});
