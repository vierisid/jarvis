/**
 * #913, Settings > Channels: emptying the Discord "Guild ID" field and saving
 * sent `guild_id: undefined`, which JSON drops, so the daemon kept the old
 * guild and the restriction could not be removed from the dashboard. The
 * daemon clears it on `guild_id: null` (#883). Asserted on what reaches
 * setDiscord and on the JSON body that would be posted.
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

const OWNER = "123456789012345678";
const GUILD = "876543210987654321";
const OTHER_GUILD = "111111111111111111";
let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** Render with a saved guild, optionally type into the Guild ID field, then press Save Discord. */
async function saveDiscordWithGuildField(typed: string | null): Promise<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  const data = {
    channelStatus: null, sttCfg: null, ttsCfg: null,
    channelCfg: {
      telegram: { enabled: false, has_token: false, allowed_users: [] },
      discord: { enabled: true, has_token: true, allowed_users: [OWNER], guild_id: GUILD },
    },
    setDiscord: async (input: Record<string, unknown>) => { sent.push(input); return { ok: true, message: "ok" }; },
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ChannelsTab data={data as never} onToast={() => {}} />);
  });
  const field = Array.from(host.querySelectorAll(".v2-set__field"))
    .find((f) => f.querySelector("label")?.textContent?.startsWith("Guild ID"));
  if (!field) throw new Error("no Guild ID field");
  const input = field.querySelector<HTMLInputElement>("input")!;
  // Seeded from the saved config, so an untouched field is not "empty".
  expect(input.value).toBe(GUILD);
  if (typed !== null) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, typed);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const save = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Save Discord")!;
  await act(async () => save.click());
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

test("emptying the Guild ID field sends null, so the saved guild restriction is cleared", async () => {
  const input = await saveDiscordWithGuildField("");
  expect(input.guild_id).toBeNull();
  // What the hook posts: the key must survive JSON, which drops undefined.
  expect(JSON.parse(JSON.stringify({ discord: input })).discord).toHaveProperty("guild_id", null);
});

test("a Guild ID field holding only spaces is empty too", async () => {
  const input = await saveDiscordWithGuildField("   ");
  expect(input.guild_id).toBeNull();
});

test("controls: an untouched field resends the saved guild and a new one is sent as typed", async () => {
  // Pass with and without #913; they pin that only an EMPTY field clears.
  expect((await saveDiscordWithGuildField(null)).guild_id).toBe(GUILD);
  await act(async () => root!.unmount());
  host?.remove();
  root = null;
  expect((await saveDiscordWithGuildField(OTHER_GUILD)).guild_id).toBe(OTHER_GUILD);
});

test("with no config loaded the empty field says nothing, so an unseen saved guild is kept", async () => {
  // The section renders before the settings GET answers (or after it fails),
  // with the field empty because nothing seeded it. The user has not cleared
  // anything, so the save must not send null.
  const sent: Array<Record<string, unknown>> = [];
  const data = {
    channelStatus: null, sttCfg: null, ttsCfg: null, channelCfg: null,
    setDiscord: async (input: Record<string, unknown>) => { sent.push(input); return { ok: true, message: "ok" }; },
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ChannelsTab data={data as never} onToast={() => {}} />);
  });
  const save = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Save Discord")!;
  await act(async () => save.click());
  expect(sent).toHaveLength(1);
  expect(sent[0]!.guild_id).toBeUndefined();
  expect(JSON.stringify(sent[0])).not.toContain("guild_id");
});
