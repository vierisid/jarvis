/**
 * #1166, Settings > Channels: when Microsoft's service refuses this install's
 * Edge TTS requests (some regions now need a token this client does not
 * implement), voice goes silent. Settings must say so and point at another
 * provider.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let ChannelsTab: typeof import("./ChannelsTab").ChannelsTab;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ ChannelsTab } = await import("./ChannelsTab"));
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

async function hints(ttsCfg: Record<string, unknown>): Promise<Array<{ text: string; warn: boolean }>> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const data = { channelStatus: null, channelCfg: null, sttCfg: null, ttsCfg };
  await act(async () => { root!.render(<ChannelsTab data={data as never} onToast={() => {}} />); });
  return Array.from(host.querySelectorAll(".v2-set__hint"))
    .filter((h) => h.textContent?.includes("Edge TTS"))
    .map((h) => ({ text: h.textContent ?? "", warn: h.classList.contains("v2-set__hint--warn") }));
}

const edge = { enabled: true, provider: "edge", voice: "en-US-AriaNeural", rate: "+0%", volume: "+0%" };

test("Edge refused here: a warning that names the cause and the way out", async () => {
  const shown = await hints({ ...edge, edge_unavailable: true });
  expect(shown).toHaveLength(1);
  expect(shown[0]!.warn).toBe(true);
  expect(shown[0]!.text).toContain("Edge TTS is unavailable in this region");
  expect(shown[0]!.text).toContain("Choose another provider");
});

test("Edge not known to be refused: a plain note, not a warning", async () => {
  const shown = await hints({ ...edge, edge_unavailable: false });
  expect(shown).toHaveLength(1);
  expect(shown[0]!.warn).toBe(false);
  expect(shown[0]!.text).not.toContain("is unavailable");
});

test("another provider: no Edge hint at all", async () => {
  expect(await hints({ ...edge, provider: "sarvam", edge_unavailable: true })).toEqual([]);
});
