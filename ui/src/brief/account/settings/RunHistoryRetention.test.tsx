import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let Component: typeof import("./RunHistoryRetention").RunHistoryRetention, format: typeof import("./RunHistoryRetention").formatHistorySize;
let root: Root, host: HTMLDivElement;
let calls: Array<{ url: string; method: string; body?: string }>;
let state: { keep: string; runs: number; bytes: number; would: number; patchOk: boolean; readOk: boolean };
const realFetch = globalThis.fetch;
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react"); ({ createRoot } = await import("react-dom/client"));
  ({ RunHistoryRetention: Component, formatHistorySize: format } = await import("./RunHistoryRetention"));
});
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  state = { keep: "forever", runs: 1234, bytes: 8.2 * 1024 * 1024, would: 40, patchOk: true, readOk: true };
  calls = [];
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
    if (init?.method === "PATCH") {
      if (!state.patchOk) return new Response("{}", { status: 500 });
      state.keep = JSON.parse(String(init.body)).keep; return Response.json({ keep: state.keep });
    }
    if (!state.readOk) return new Response("{}", { status: 500 });
    return Response.json({ keep: state.keep, runs: state.runs, bytes: state.bytes, ...(String(url).includes("keep=") ? { wouldRemoveRuns: state.would } : {}) });
  };
});
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); (globalThis as any).fetch = realFetch; });
afterAll(() => GlobalRegistrator.unregister());
const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const select = () => host.querySelector("select") as HTMLSelectElement;
async function choose(value: string) {
  await React.act(async () => {
    const el = select(); el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
  });
}
const click = (label: string) => React.act(async () => {
  [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().includes(label))!.click();
  await new Promise((r) => setTimeout(r, 20));
});
const show = async () => { await React.act(async () => root.render(<Component />)); await settle(); };

test("shows the setting and how much history there is", async () => {
  await show();
  expect(host.textContent).toContain("Keep run history for");
  expect(host.textContent).toContain("Stored now: 1,234 runs, about 8.2 MB.");
  expect(host.textContent).toContain("never deleted");
  expect(select().value).toBe("forever");
  expect([...select().options].map((o) => o.textContent)).toEqual(["Forever", "1 year", "90 days", "30 days"]);
});

test("a limit says how many runs it deletes and waits for a yes", async () => {
  await show();
  await choose("90d");
  expect(host.textContent).toContain("This deletes 40 finished runs older than 90 days, with their logs. It cannot be undone.");
  expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  await click("Delete older runs");
  expect(calls.find((c) => c.method === "PATCH")!.body).toBe(JSON.stringify({ keep: "90d" }));
  expect(host.textContent).toContain("Saved. Older finished runs are being cleared.");
});

test("keeping everything instead changes nothing", async () => {
  await show();
  await choose("30d");
  await click("Keep everything");
  expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  expect(host.textContent).not.toContain("cannot be undone");
});

test("a limit that deletes nothing, and Forever, save at once", async () => {
  await show();
  state.would = 0;
  await choose("1y");
  expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  await choose("forever");
  expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2);
  expect(host.textContent).toContain("Saved. Run history is kept forever.");
});

test("a failed save or read says so in plain words", async () => {
  await show();
  state.patchOk = false; state.would = 0;
  await choose("90d");
  expect(host.textContent).toContain("Could not save that. Try again.");
  await React.act(async () => root.unmount());
  root = createRoot(host); state.readOk = false;
  await show();
  expect(host.textContent).toContain("Run history could not be read right now.");
  expect(select().disabled).toBe(true);
});

test("sizes read as words", () => {
  expect(format(512)).toBe("512 B");
  expect(format(340 * 1024)).toBe("340 KB");
  expect(format(250 * 1024 * 1024)).toBe("250 MB");
  expect(format(3.4 * 1024 * 1024 * 1024)).toBe("3.4 GB");
});
