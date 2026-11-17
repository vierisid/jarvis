/**
 * The model picker and the first provider.
 *
 * On an install with no provider yet, the picker is on the page before any
 * provider exists. The owner, 17 November 2026, setting up his AI from the
 * notch's day one: "I had to insert the API key on the single model, go to
 * the multi-model, where I could select a specific model, and then come back
 * to single model."
 *
 * The picker kept the provider it was created with: none. So it showed a
 * free-text field in place of the provider's models, and what was typed there
 * was thrown away, because no provider was picked. Switching the mode made a
 * new picker, which is all the workaround did.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let ModelSelector: typeof import("./LLMTab").ModelSelector;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ ModelSelector } = await import("./LLMTab"));
});
afterAll(() => { GlobalRegistrator.unregister(); });

let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

type Providers = Parameters<typeof ModelSelector>[0]["providers"];
const anthropic = { kind: "anthropic", has_api_key: true } as unknown as Providers[string];
const openai = { kind: "openai", has_api_key: true } as unknown as Providers[string];

async function show(providers: Providers, value: string | null, onChange: (ref: string | null) => void) {
  if (!root) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(<ModelSelector label="Default model" value={value} providers={providers} ollamaModels={null} providerCatalogs={{}} allowClear onChange={onChange} />);
  });
}
const selects = () => [...host!.querySelectorAll<HTMLSelectElement>("select")];
async function pick(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event("change", { bubbles: true })); });
}

describe("the model picker, on an install with no provider yet", () => {
  test("the first provider that is added is the one its models are listed for, and one can be picked", async () => {
    const saved: Array<string | null> = [];
    await show({}, null, (ref) => saved.push(ref));
    expect(host!.textContent).toContain("No providers configured");
    // The person adds their account and its key. The same picker is still on the page.
    await show({ main: anthropic }, null, (ref) => saved.push(ref));
    const [provider, model] = selects();
    expect(provider!.value).toBe("main");
    // A list of that provider's models, not a bare text field.
    expect(model).toBeDefined();
    expect(host!.querySelector('input[placeholder="model id"]')).toBeNull();
    const offered = [...model!.options].map((option) => option.value).filter((value) => value && value !== "__custom__");
    expect(offered.length).toBeGreaterThan(0);
    await pick(model!, offered[0]!);
    expect(saved).toEqual([`main:${offered[0]}`]);
  });

  test("a provider that is taken away again leaves the picker on one that is there", async () => {
    const saved: Array<string | null> = [];
    await show({ a: anthropic, b: openai }, null, (ref) => saved.push(ref));
    await pick(selects()[0]!, "b");
    saved.length = 0;
    // "b" is removed while nothing was saved for this slot.
    await show({ a: anthropic }, null, (ref) => saved.push(ref));
    const [provider, model] = selects();
    expect(provider!.value).toBe("a");
    const offered = [...model!.options].map((option) => option.value).filter((value) => value && value !== "__custom__");
    await pick(model!, offered[0]!);
    expect(saved).toEqual([`a:${offered[0]}`]);
  });

  test("a saved choice is shown as it is, whatever was added since", async () => {
    await show({ a: anthropic }, null, () => {});
    await show({ a: anthropic, b: openai }, "b:gpt-test-model", () => {});
    expect(selects()[0]!.value).toBe("b");
    expect(host!.textContent).toContain("b:gpt-test-model");
  });
});
