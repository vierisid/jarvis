/**
 * #1033: the General tab offered "Set aggressiveness (write)" buttons that
 * could only toast "not yet wired", for a daemon that has no heartbeat write
 * endpoint and ignores the interval and active hours entirely. What it still
 * reads, the aggressiveness, is shown read-only.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let GeneralTab: typeof import("./GeneralTab").GeneralTab;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ GeneralTab } = await import("./GeneralTab"));
  globalThis.fetch = (async () => Response.json({})) as never;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

test("the heartbeat section shows the aggressiveness read-only and offers no write", async () => {
  const data = {
    autostart: null, personality: null, role: null,
    rootCfg: { heartbeat: { interval_minutes: 15, active_hours: { start: 8, end: 22 }, aggressiveness: "moderate" } },
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<GeneralTab data={data as never} onToast={() => {}} />);
  });
  const section = Array.from(host.querySelectorAll("section"))
    .find((s) => s.querySelector(".v2-set__section-title")?.textContent === "Heartbeat");
  if (!section) throw new Error("no Heartbeat section");
  const rows = Array.from(section.querySelectorAll(".v2-set__row"))
    .map((r) => `${r.querySelector(".v2-set__row-label")?.textContent}: ${r.querySelector(".v2-set__row-value")?.textContent}`);
  expect(rows).toEqual(["Aggressiveness: moderate"]);
  expect(Array.from(section.querySelectorAll("button")).map((b) => b.textContent)).toEqual([]);
  expect(section.textContent).not.toMatch(/not yet wired|checks in/i);
});
