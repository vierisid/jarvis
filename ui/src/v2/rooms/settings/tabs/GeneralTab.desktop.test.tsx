/**
 * #1159: desktop.enabled (#905) had no Settings control, so a hosted install,
 * which cannot edit config.yaml, could not turn desktop control off. The
 * General tab shows the switch as the daemon reads it and flips it through
 * setDesktopEnabled.
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

async function render(rootCfg: unknown, calls: boolean[], toasts: string[]) {
  const data = {
    autostart: null, personality: null, role: null, rootCfg,
    setDesktopEnabled: async (enabled: boolean) => { calls.push(enabled); return { ok: true, message: enabled ? "on" : "off" }; },
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<GeneralTab data={data as never} onToast={(t) => toasts.push(t)} />);
  });
  const section = Array.from(host.querySelectorAll("section"))
    .find((s) => s.querySelector(".v2-set__section-title")?.textContent === "Desktop control");
  if (!section) throw new Error("no Desktop control section");
  return section;
}

for (const enabled of [true, false]) {
  test(`the switch shows ${enabled ? "on" : "off"} and asks for the opposite`, async () => {
    const calls: boolean[] = [];
    const toasts: string[] = [];
    const section = await render({ desktop: { enabled } }, calls, toasts);
    const toggle = section.querySelector('button[role="switch"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe(String(enabled));
    await act(async () => { toggle.click(); });
    expect(calls).toEqual([!enabled]);
    expect(toasts).toEqual([!enabled ? "on" : "off"]);
  });
}

test("an older daemon that does not report it gets no switch", async () => {
  const section = await render({}, [], []);
  expect(section.querySelector('button[role="switch"]')).toBeNull();
  expect(section.textContent).toContain("Desktop setting unavailable.");
});
