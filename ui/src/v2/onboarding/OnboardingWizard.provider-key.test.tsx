/**
 * #1066: a key typed for one provider must never travel to another.
 *
 * The wizard used to keep ONE apiKey across provider switches. A user who
 * typed an OpenAI key and then picked LiteLLM, OpenAI-compatible or OmniRoute
 * (all optional-key kinds that send to a URL the user types) had that OpenAI
 * key sent to the typed base URL by the OmniRoute catalog fetch, by Test, and
 * by the setup POST, which also saved it under the new provider. The same
 * component backs the Brief onboarding (F-26), so it is fixed in one place.
 *
 * Every assertion here is on a request body the wizard actually sent, read
 * from a fetch stub, so a key that never left the browser cannot pass by
 * accident and a leak through any of the three paths fails the test.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let OnboardingWizard: typeof import("./OnboardingWizard").OnboardingWizard;
type OnboardingStatus = import("./useOnboardingStatus").OnboardingStatus;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ OnboardingWizard } = await import("./OnboardingWizard"));
});

afterAll(() => {
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

/** A fresh install: nothing completed, so the wizard starts at Welcome. */
const FRESH: OnboardingStatus = {
  setup_completed: false,
  setup_completed_at: null,
  setup_skipped_profile: false,
  profile_completed: false,
  tutorial_completed: false,
  tutorial_completed_at: null,
  tutorial_dismissed: false,
  tutorial_progress_step: null,
  last_reset_at: null,
};

const OPENAI_KEY = "sk-openai-typed-for-openai-only";
const STT_OPENAI_KEY = "sk-stt-typed-for-openai-whisper";
const ANTHROPIC_KEY = "sk-ant-typed-for-api-anthropic-com";

type Sent = { url: string; body: Record<string, unknown> | null };
const sent: Sent[] = [];
let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

async function mount() {
  sent.length = 0;
  globalThis.fetch = (async (input: string, init?: { method?: string; body?: string }) => {
    const url = String(input);
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { body = null; }
    }
    sent.push({ url, body });
    if (url === "/api/config/llm") return json({ hosted_llm: false });
    if (url === "/api/config/llm/test") return json({ ok: true, model: (body?.model as string) ?? "m" });
    if (url === "/api/config/llm/omniroute/models") return json({ ok: true, models: ["auto"] });
    if (url === "/api/onboarding/setup") return json({});
    return json({});
  }) as never;

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<OnboardingWizard status={FRESH} onComplete={() => {}} />);
  });
  // Let the hosted probe resolve so the self-hosted brain step is reachable.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

const buttons = () => Array.from(host!.querySelectorAll("button"));
function button(text: RegExp): HTMLButtonElement {
  const found = buttons().find((b) => text.test(b.textContent || ""));
  if (!found) throw new Error(`no button matching ${text}; have: ${buttons().map((b) => b.textContent).join(" | ")}`);
  return found as HTMLButtonElement;
}
async function click(text: RegExp) {
  await act(async () => button(text).click());
}
function provider(name: string): HTMLButtonElement {
  const found = Array.from(host!.querySelectorAll<HTMLButtonElement>(".obw-prov"))
    .find((b) => b.querySelector(".pn")?.textContent === name);
  if (!found) throw new Error(`no provider tile ${name}`);
  return found;
}
async function pick(name: string) {
  await act(async () => provider(name).click());
}

/** React tracks the last value it rendered on the node, so a plain `.value =`
 *  is swallowed as a no-op. Setting it through the prototype setter, then
 *  firing `input`, is what a keystroke looks like to onChange. */
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const keyInput = () => host!.querySelector<HTMLInputElement>('.obw-provdetail input[type="password"]')!;
const urlInput = () => {
  const found = Array.from(host!.querySelectorAll<HTMLInputElement>(".obw-provdetail input.obw-inp"))
    .find((i) => i.type !== "password" && i.placeholder.startsWith("http"));
  if (!found) throw new Error("no base URL input");
  return found;
};
/** Past the 400ms debounce the catalog fetches use. */
async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
}

const keysSent = () =>
  sent.flatMap(({ url, body }) => {
    const text = JSON.stringify(body ?? {});
    return [OPENAI_KEY, STT_OPENAI_KEY, ANTHROPIC_KEY].some((key) => text.includes(key)) ? [url] : [];
  });

async function toBrain() {
  await mount();
  await click(/^Set up Jarvis$/);
  await click(/^Continue$/);
  expect(host!.textContent).toContain("Pick a brain for Jarvis.");
}

describe("#1066 provider switch never carries a typed key", () => {
  test('voice preview failure releases Preview and leaves setup navigable', async () => {
    await toBrain(); await pick('LiteLLM'); await type(urlInput(), 'http://localhost:4000/v1');
    await click(/^Test connection$/); await click(/^Continue$/); await click(/^Continue$/);
    const prior = globalThis.fetch;
    let previewSignal: AbortSignal | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/tts/preview') { previewSignal = init?.signal ?? undefined; return new Response('', { status: 503 }); }
      return prior(input, init);
    }) as typeof fetch;
    await click(/^Preview$/);
    expect(previewSignal).toBeDefined();
    expect(host!.textContent).toContain('Voice preview is unavailable');
    expect(button(/^Preview$/).disabled).toBe(false);
    await click(/^Continue$/);
    expect(sent.some(s => s.url === '/api/onboarding/setup')).toBe(true);
  });

  test("an OpenAI key is not sent by OmniRoute's catalog read or its Test", async () => {
    await toBrain();
    await pick("OpenAI");
    await type(keyInput(), OPENAI_KEY);
    await pick("OmniRoute");
    // OmniRoute prefills its URL, so the catalog read fires on its own.
    await settle();
    expect(sent.some((s) => s.url === "/api/config/llm/omniroute/models")).toBe(true);
    await click(/^Test connection$/);
    expect(sent.some((s) => s.url === "/api/config/llm/test")).toBe(true);
    expect(keysSent()).toEqual([]);
    expect(keyInput().value).toBe("");
  });

  test("an OpenAI key is neither tested against nor saved for a LiteLLM URL", async () => {
    await toBrain();
    await pick("OpenAI");
    await type(keyInput(), OPENAI_KEY);
    await pick("LiteLLM");
    await type(urlInput(), "http://attacker.example/v1");
    await click(/^Test connection$/);
    expect(sent.some((s) => s.url === "/api/config/llm/test" && s.body?.provider === "litellm")).toBe(true);
    // Through Hearing and Speaking to the setup POST, which fires on leaving Speaking.
    await click(/^Continue$/);
    await click(/^Continue$/);
    await click(/^Continue$/);
    const setup = sent.find((s) => s.url === "/api/onboarding/setup");
    expect(setup).toBeDefined();
    expect((setup!.body as { llm: { providers: Record<string, unknown> } }).llm.providers)
      .toEqual({ litellm: { kind: "litellm", base_url: "http://attacker.example/v1" } });
    expect(keysSent()).toEqual([]);
  });

  test("switching back restores the key to the provider it was typed for", async () => {
    await toBrain();
    await pick("OpenAI");
    await type(keyInput(), OPENAI_KEY);
    await pick("LiteLLM");
    expect(keyInput().value).toBe("");
    await pick("OpenAI");
    expect(keyInput().value).toBe(OPENAI_KEY);
    await click(/^Test connection$/);
    const openaiTest = sent.find((s) => s.url === "/api/config/llm/test");
    expect(openaiTest?.body).toMatchObject({ provider: "openai", api_key: OPENAI_KEY });
  });

  test("an Anthropic key is not sent once the custom endpoint is switched on", async () => {
    await toBrain();
    await type(keyInput(), ANTHROPIC_KEY);
    await act(async () => host!.querySelector<HTMLButtonElement>('.obw-provdetail [role="switch"]')!.click());
    await type(urlInput(), "http://attacker.example");
    // The key is required here, so with the field emptied Test refuses locally
    // instead of sending anything; a token typed for the gateway is what goes.
    await click(/^Test connection$/);
    expect(sent.some((s) => s.url === "/api/config/llm/test")).toBe(false);
    await type(keyInput(), "gateway-token");
    await click(/^Test connection$/);
    expect(sent.find((s) => s.url === "/api/config/llm/test")?.body)
      .toMatchObject({ provider: "anthropic", base_url: "http://attacker.example", api_key: "gateway-token" });
    expect(keysSent()).toEqual([]);
  });

  test("a Whisper key typed for OpenAI is not saved for Groq", async () => {
    await toBrain();
    await pick("LiteLLM");
    await type(urlInput(), "http://localhost:4000/v1");
    await click(/^Test connection$/);
    await click(/^Continue$/);
    expect(host!.textContent).toContain("How should Jarvis hear you?");
    await click(/OpenAI Whisper/);
    await type(host!.querySelector<HTMLInputElement>('.obw-subctl input[type="password"]')!, STT_OPENAI_KEY);
    await click(/Groq Whisper/);
    const groqKey = host!.querySelector<HTMLInputElement>('.obw-subctl input[type="password"]')!.value;
    await click(/^Continue$/);
    await click(/^Continue$/);
    const setup = sent.find((s) => s.url === "/api/onboarding/setup");
    expect(setup?.body?.stt).toEqual({ provider: "groq" });
    expect(keysSent()).toEqual([]);
    expect(groqKey).toBe("");
  });

  test("Test and the setup POST name the official origin, so a gateway saved earlier is not inherited", async () => {
    // The daemon fills an omitted kind or base_url from the provider saved
    // under the same name (src/daemon/llm-settings.ts testLLMProvider and
    // saveLLMSettings). An explicit empty base_url means the provider's own
    // origin; src/daemon/api-llm-test.test.ts pins that a fresh key with
    // base_url "" goes to api.anthropic.com and not to the saved gateway.
    await toBrain();
    await type(keyInput(), ANTHROPIC_KEY);
    await click(/^Test connection$/);
    expect(sent.find((s) => s.url === "/api/config/llm/test")?.body)
      .toMatchObject({ provider: "anthropic", kind: "anthropic", base_url: "", auth_header: "", api_key: ANTHROPIC_KEY });
    await click(/^Continue$/);
    await click(/^Continue$/);
    await click(/^Continue$/);
    const setup = sent.find((s) => s.url === "/api/onboarding/setup");
    expect((setup!.body as { llm: { providers: Record<string, unknown> } }).llm.providers)
      .toEqual({ anthropic: { kind: "anthropic", api_key: ANTHROPIC_KEY, base_url: "", auth_header: "" } });
  });

  test("a gateway token does not outlive its gateway URL across custom endpoint toggles", async () => {
    await toBrain();
    const toggle = () => act(async () => host!.querySelector<HTMLButtonElement>('.obw-provdetail [role="switch"]')!.click());
    await toggle();
    await type(urlInput(), "http://first-gateway.example");
    await type(keyInput(), "first-gateway-token");
    await toggle();
    await toggle();
    expect(keyInput().value).toBe("");
  });

  test("OmniRoute's catalog read never sends its key to another provider's URL", async () => {
    await toBrain();
    await pick("OmniRoute");
    await type(keyInput(), "omniroute-key");
    await type(urlInput(), "http://omniroute.example/v1");
    await settle();
    await pick("LiteLLM");
    await type(urlInput(), "http://litellm.example/v1");
    await pick("OmniRoute");
    await settle();
    const reads = sent.filter((s) => s.url === "/api/config/llm/omniroute/models").map((s) => s.body?.base_url);
    // Reads of OmniRoute's own URLs (default or typed) are fine; the
    // LiteLLM URL must never receive OmniRoute's key.
    expect({ typed: reads.includes("http://omniroute.example/v1"), litellm: reads.includes("http://litellm.example/v1") })
      .toEqual({ typed: true, litellm: false });
  });
});
