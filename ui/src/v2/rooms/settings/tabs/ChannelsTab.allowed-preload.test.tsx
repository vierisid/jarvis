/**
 * #1155, Settings > Channels: Save pressed before the settings GET answered
 * (or after it failed) sent `allowed_users: []` from the field nothing had
 * seeded yet, and the daemon accepts an empty list for a disabled channel, so
 * the saved list was wiped unseen. Guarded as #913 guards the Discord guild:
 * before the config has loaded an empty field says nothing and is not sent.
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

type Sent = { telegram: Array<Record<string, unknown>>; discord: Array<Record<string, unknown>> };

async function render(channelCfg: unknown): Promise<{ sent: Sent; host: HTMLElement }> {
  const sent: Sent = { telegram: [], discord: [] };
  const data = {
    channelStatus: null, sttCfg: null, ttsCfg: null, channelCfg,
    setTelegram: async (input: Record<string, unknown>) => { sent.telegram.push(input); return { ok: true, message: "ok" }; },
    setDiscord: async (input: Record<string, unknown>) => { sent.discord.push(input); return { ok: true, message: "ok" }; },
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ChannelsTab data={data as never} onToast={() => {}} />);
  });
  return { sent, host };
}

async function type(h: HTMLElement, section: number, label: string, value: string) {
  const sections = h.querySelectorAll("section");
  const field = Array.from(sections[section]!.querySelectorAll(".v2-set__field"))
    .find((f) => f.querySelector("label")?.textContent?.startsWith(label));
  const input = field!.querySelector<HTMLInputElement>("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(h: HTMLElement, label: string) {
  const button = Array.from(h.querySelectorAll("button")).find((b) => b.textContent === label)!;
  await act(async () => button.click());
}

test("before the config loads, Save sends no allowed_users for an untouched field, so the saved list is kept", async () => {
  const { sent, host: h } = await render(null);
  await press(h, "Save Telegram");
  await press(h, "Save Discord");
  expect(sent.telegram).toHaveLength(1);
  expect(sent.discord).toHaveLength(1);
  expect(sent.telegram[0]!.allowed_users).toBeUndefined();
  expect(sent.discord[0]!.allowed_users).toBeUndefined();
  expect(JSON.stringify(sent)).not.toContain("allowed_users");
});

test("before the config loads, IDs the user typed are still sent: that field says something", async () => {
  const { sent, host: h } = await render(null);
  await type(h, 0, "Allowed user IDs", "42");
  await type(h, 1, "Allowed user IDs", "123456789012345678");
  await press(h, "Save Telegram");
  await press(h, "Save Discord");
  expect(sent.telegram[0]!.allowed_users).toEqual([42]);
  expect(sent.discord[0]!.allowed_users).toEqual(["123456789012345678"]);
});

test("control: once loaded, emptying the field and saving sends the empty list, as the user asked", async () => {
  const { sent, host: h } = await render({
    telegram: { enabled: false, has_token: true, allowed_users: [42], allowed_users_entries: ["42"] },
    discord: { enabled: false, has_token: true, allowed_users: ["123456789012345678"], allowed_users_entries: ["123456789012345678"], guild_id: null },
  });
  await type(h, 0, "Allowed user IDs", "");
  await type(h, 1, "Allowed user IDs", "");
  await press(h, "Save Telegram");
  await press(h, "Save Discord");
  expect(sent.telegram[0]!.allowed_users).toEqual([]);
  expect(sent.discord[0]!.allowed_users).toEqual([]);
});
