/**
 * #1066, Settings > Channels: the speech-to-text key field was one shared
 * string. Typing an OpenAI key, then picking Groq (which saves the provider
 * at once and relabels the field "API key for groq"), left the OpenAI key in
 * the masked field, and Save key stored it as Groq's key, so the daemon sent
 * it to Groq. Asserted on what reaches setSTTProvider.
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

const OPENAI_KEY = "sk-openai-typed-for-whisper";
let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

test("an OpenAI speech key is not saved as the Groq key after switching provider", async () => {
  const saved: Array<{ provider: string; extra: unknown }> = [];
  const data = (provider: string) => ({
    channelStatus: null, channelCfg: null, ttsCfg: null,
    sttCfg: { provider },
    setSTTProvider: async (p: string, extra?: unknown) => { saved.push({ provider: p, extra }); return { ok: true, message: "ok" }; },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const render = (provider: string) => act(async () => {
    root!.render(<ChannelsTab data={data(provider) as never} onToast={() => {}} />);
  });
  await render("openai");
  // Telegram and Discord token fields share the placeholder; find the STT one by its label.
  const keyInput = () => {
    const field = Array.from(host!.querySelectorAll(".v2-set__field"))
      .find((f) => f.querySelector("label")?.textContent?.startsWith("API key for "));
    if (!field) throw new Error("no speech-to-text key field");
    return field.querySelector<HTMLInputElement>('input[type="password"]')!;
  };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(keyInput(), OPENAI_KEY);
    keyInput().dispatchEvent(new Event("input", { bubbles: true }));
  });
  // The provider select saves at once; the refreshed config names Groq.
  await render("groq");
  const save = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Save key")!;
  if (!save.disabled) await act(async () => save.click());
  expect(keyInput().closest(".v2-set__field")!.querySelector("label")!.textContent).toBe("API key for groq");
  expect(saved.filter((s) => JSON.stringify(s.extra ?? {}).includes(OPENAI_KEY))).toEqual([]);
  expect(keyInput().value).toBe("");
  // Back on OpenAI, the key typed for it is still there to save.
  await render("openai");
  expect(keyInput().value).toBe(OPENAI_KEY);
});
