/**
 * #1159 final review: when turning desktop control off could not be saved,
 * the daemon still turns it off and answers 500. The hook skipped its refresh
 * on that error, so the switch kept showing "on" while the daemon read "off".
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let useSettingsData: typeof import("./useSettingsData").useSettingsData;
const realFetch = globalThis.fetch;
let daemonDesktop = true;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ useSettingsData } = await import("./useSettingsData"));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/config/desktop" && init?.method === "POST") {
      daemonDesktop = false; // off in force, but not saved
      return Response.json({ error: "Desktop control is off for now, but the choice could not be saved" }, { status: 500 });
    }
    if (url === "/api/config") return Response.json({ desktop: { enabled: daemonDesktop } });
    return new Response(null, { status: 404 }); // read as "not available"
  }) as never;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

test("after a failed save the switch shows what the daemon reads", async () => {
  let hook: ReturnType<typeof useSettingsData> | null = null;
  function Probe() { hook = useSettingsData(); return null; }
  const host = document.createElement("div");
  root = createRoot(host);
  await act(async () => { root!.render(<Probe />); });
  await act(async () => { await Bun.sleep(20); });
  expect(hook!.rootCfg?.desktop).toEqual({ enabled: true });
  let result: { ok: boolean } | null = null;
  await act(async () => { result = await hook!.setDesktopEnabled(false); });
  expect(result!.ok).toBe(false);
  expect(hook!.rootCfg?.desktop).toEqual({ enabled: false });
});
