/**
 * #1066, Settings side: the "Add provider" form had the onboarding wizard's
 * bug. Changing the provider kind cleared the base URL but kept the typed
 * key, so an OpenAI key typed first was tested against, and saved with, a
 * LiteLLM or OpenAI-compatible URL the user typed next. Same for switching
 * the Anthropic custom endpoint on after typing the Anthropic key.
 *
 * Asserted on what the form hands the data layer (which is what goes on the
 * wire), not on the input's value, so a leak through Test or Add fails here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let NewProviderRow: typeof import("./LLMTab").NewProviderRow;
let ProviderRow: typeof import("./LLMTab").ProviderRow;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ NewProviderRow, ProviderRow } = await import("./LLMTab"));
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const OPENAI_KEY = "sk-openai-typed-for-openai-only";
const ANTHROPIC_KEY = "sk-ant-typed-for-api-anthropic-com";

const calls: Array<{ op: "test" | "upsert"; name: string; input: unknown }> = [];
let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function mount() {
  calls.length = 0;
  const data = {
    testProvider: async (name: string, input: unknown) => {
      calls.push({ op: "test", name, input });
      return { ok: true, message: "ok" };
    },
    upsertProvider: async (name: string, input: unknown) => {
      calls.push({ op: "upsert", name, input });
      return { ok: true, message: "saved" };
    },
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<NewProviderRow existing={[]} data={data as never} onToast={() => {}} onDone={() => {}} />);
  });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function setValue(el: HTMLInputElement | HTMLSelectElement, value: string, event: "input" | "change") {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event(event, { bubbles: true }));
  });
}
const kindSelect = () => host!.querySelector<HTMLSelectElement>("select")!;
const keyInput = () => host!.querySelector<HTMLInputElement>('input[type="password"]')!;
function fieldInput(label: RegExp): HTMLInputElement {
  const field = Array.from(host!.querySelectorAll(".v2-set__field"))
    .find((f) => label.test(f.querySelector("label")?.textContent || ""));
  if (!field) throw new Error(`no field ${label}`);
  return field.querySelector("input")!;
}
async function clickButton(text: RegExp) {
  const b = Array.from(host!.querySelectorAll("button")).find((x) => text.test(x.textContent || ""));
  if (!b) throw new Error(`no button ${text}`);
  expect({ button: String(text), disabled: (b as HTMLButtonElement).disabled }).toEqual({ button: String(text), disabled: false });
  await act(async () => (b as HTMLButtonElement).click());
}
const leaked = () => calls.filter((c) => [OPENAI_KEY, ANTHROPIC_KEY].some((k) => JSON.stringify(c.input).includes(k)));

describe("#1066 Settings add-provider never carries a typed key across kinds", () => {
  test("an OpenAI key is neither tested against nor saved with a LiteLLM URL", async () => {
    await mount();
    await setValue(kindSelect(), "openai", "change");
    await setValue(keyInput(), OPENAI_KEY, "input");
    await setValue(kindSelect(), "litellm", "change");
    await setValue(fieldInput(/Base URL/), "http://attacker.example/v1", "input");
    await clickButton(/^Test connection$/);
    await clickButton(/^Add$/);
    expect(calls.map((c) => c.op)).toEqual(["test", "upsert"]);
    expect(leaked()).toEqual([]);
    expect(calls[1]!.input).toEqual({ kind: "litellm", base_url: "http://attacker.example/v1", auth_header: "Authorization" });
  });

  test("an Anthropic key is not sent once the custom endpoint is switched on", async () => {
    await mount();
    await setValue(keyInput(), ANTHROPIC_KEY, "input");
    await act(async () => host!.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    await setValue(fieldInput(/Custom endpoint URL/), "http://attacker.example", "input");
    // The key is required for Anthropic, so an emptied field disables Test;
    // with the old key still held it would have gone to the typed endpoint.
    const testButton = Array.from(host!.querySelectorAll("button")).find((b) => b.textContent === "Test connection")!;
    if (!testButton.disabled) await act(async () => testButton.click());
    expect(leaked()).toEqual([]);
    expect(calls).toEqual([]);
    await setValue(keyInput(), "gateway-token", "input");
    await clickButton(/^Test connection$/);
    expect(leaked()).toEqual([]);
    expect(calls[0]!.input).toMatchObject({ kind: "anthropic", apiKey: "gateway-token", baseUrl: "http://attacker.example" });
  });
});

describe("#1066 Settings existing provider row never carries a typed key across the endpoint toggle", () => {
  async function mountRow(entry: { kind: "anthropic"; has_api_key: boolean; base_url?: string }) {
    calls.length = 0;
    const data = {
      testProvider: async (name: string, input: unknown) => { calls.push({ op: "test", name, input }); return { ok: true, message: "ok" }; },
      upsertProvider: async (name: string, input: unknown) => { calls.push({ op: "upsert", name, input }); return { ok: true, message: "saved" }; },
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const view = (e: typeof entry) => (
      <ProviderRow name="anthropic" entry={e} data={data as never} onToast={() => {}} expanded onToggleExpanded={() => {}} />
    );
    await act(async () => { root!.render(view(entry)); });
    return (next: typeof entry) => act(async () => { root!.render(view(next)); });
  }
  const tryButton = async (label: string) => {
    const b = Array.from(host!.querySelectorAll("button")).find((x) => x.textContent === label);
    if (b && !b.disabled) await act(async () => b.click());
  };

  test("an official key typed on the row is not sent once the custom endpoint is switched on", async () => {
    await mountRow({ kind: "anthropic", has_api_key: true });
    await setValue(keyInput(), ANTHROPIC_KEY, "input");
    await act(async () => host!.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    await setValue(fieldInput(/Custom endpoint URL/), "http://attacker.example", "input");
    await tryButton("Test connection");
    await tryButton("Save");
    expect(leaked()).toEqual([]);
    expect(keyInput().value).toBe("");
  });

  test("a key typed for the saved endpoint is dropped when that endpoint changes underneath the row", async () => {
    const rerender = await mountRow({ kind: "anthropic", has_api_key: true });
    await setValue(keyInput(), ANTHROPIC_KEY, "input");
    await rerender({ kind: "anthropic", has_api_key: true, base_url: "http://elsewhere.example" });
    await tryButton("Test connection");
    await tryButton("Save");
    expect(leaked()).toEqual([]);
    expect(keyInput().value).toBe("");
  });
});
