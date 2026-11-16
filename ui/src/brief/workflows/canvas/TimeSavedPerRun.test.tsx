import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Flow } from "../../../v2/rooms/workflows/useWorkflowsData";

GlobalRegistrator.register({ url: "http://localhost:4390/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let TimeSavedPerRun: typeof import("./TimeSavedPerRun").TimeSavedPerRun;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeAll(async () => {
  React = await import("react"); ({ createRoot } = await import("react-dom/client")); ({ TimeSavedPerRun } = await import("./TimeSavedPerRun"));
});
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());

const flow = (extra: Partial<Flow> = {}) => ({ id: "f1", displayName: "Daily", estimatedTimeSavedPerRun: 12, timeSavedPerRun: null, ...extra }) as Flow;
const button = (label: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.includes(label)) as HTMLButtonElement;
async function type(value: string) {
  const input = host.querySelector("input")!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await React.act(async () => { set.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

test("shows the estimate when unset and saves the owner's minutes with a validated PATCH", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const request = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return Response.json({}); }) as unknown as typeof fetch;
  let changed = 0;
  await React.act(async () => root.render(<TimeSavedPerRun flow={flow()} request={request} onChanged={() => { changed++; }} />));
  expect(host.textContent).toContain("Saves about 12 min per run, estimated from the steps.");
  await React.act(async () => button("Set minutes").click());
  await type("1.5"); expect(button("Save").disabled).toBe(true);
  await type("1441"); expect(button("Save").disabled).toBe(true);
  await type("20"); expect(button("Save").disabled).toBe(false);
  await React.act(async () => button("Save").click());
  expect(calls).toEqual([{ url: "/api/workflows/f1", body: { timeSavedPerRun: 20 } }]); expect(changed).toBe(1);
  expect(host.textContent).toContain("Saves 20 min per run. You set this.");
  await React.act(async () => button("Use the estimate").click());
  expect(calls[1]!.body).toEqual({ timeSavedPerRun: null }); expect(host.textContent).toContain("Saves about 12 min per run");
});

test("a refused save keeps the old value and says so in plain words", async () => {
  const request = (async () => Response.json({ error: "no" }, { status: 400 })) as unknown as typeof fetch;
  await React.act(async () => root.render(<TimeSavedPerRun flow={flow({ timeSavedPerRun: 5 })} request={request} />));
  expect(host.textContent).toContain("Saves 5 min per run. You set this.");
  await React.act(async () => button("Change").click()); await type("9");
  await React.act(async () => button("Save").click());
  expect(host.textContent).toContain("Could not save. Try again."); expect(host.querySelector("input")).not.toBeNull();
});
