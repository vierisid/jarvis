import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let Guide: typeof import("./ProviderSetupGuide").ProviderSetupGuideButton;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ ProviderSetupGuideButton: Guide } = await import("./ProviderSetupGuide"));
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
});
afterAll(() => GlobalRegistrator.unregister());

async function mount(kind: string) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Guide kind={kind} />));
}
async function click(selector: string) {
  await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
}

describe("provider setup guides", () => {
  for (const [kind, title, url] of [
    ["ollama", "Ollama", "http://localhost:11434"],
    ["omniroute", "OmniRoute", "http://localhost:20128/v1"],
    ["litellm", "LiteLLM", "http://localhost:4000/v1"],
    ["openai_compatible", "OpenAI-compatible servers", "http://localhost:1234/v1"],
  ]) {
    test(`${kind} opens the correct instructions and closes without submitting`, async () => {
      await mount(kind!);
      expect(host.querySelector("dialog")).toBeNull();
      expect(host.querySelector("button")!.type).toBe("button");
      await click(".provider-guide-link");
      expect(host.querySelector("dialog")!.open).toBe(true);
      expect(host.querySelector("h2")!.textContent).toBe(title!);
      expect(host.textContent).toContain(url!);
      expect(host.querySelectorAll("ol > li").length).toBe(3);
      await click(".provider-guide__footer button");
      expect(host.querySelector("dialog")).toBeNull();
      expect(document.body.style.overflow).toBe("");
    });
  }

  test("unknown and cloud-only providers have no local setup action", async () => {
    await mount("anthropic");
    expect(host.textContent).toBe("");
    await act(async () => root.render(<Guide kind="toString" />));
    expect(host.textContent).toBe("");
  });

  test("copy copies only the displayed value and announces failures honestly", async () => {
    await mount("ollama");
    const original = navigator.clipboard.writeText;
    let copied = "";
    try {
      navigator.clipboard.writeText = async (value) => { copied = value; };
      await click(".provider-guide-link");
      await click('[aria-label="Copy Base URL on the same machine"]');
      expect(copied).toBe("http://localhost:11434");
      expect(host.textContent).toContain("Copied");
      navigator.clipboard.writeText = async () => { throw new Error("denied"); };
      await click('[aria-label="Copy Base URL on the same machine"]');
      expect(host.textContent).toContain("Could not copy. Select the text and copy it manually.");
    } finally { navigator.clipboard.writeText = original; }
  });

  test("Escape cancellation and unmount restore the existing scroll style", async () => {
    document.body.style.overflow = "auto";
    await mount("litellm");
    await click(".provider-guide-link");
    expect(document.body.style.overflow).toBe("hidden");
    await act(async () => { host.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })); });
    expect(host.querySelector("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("auto");
    await click(".provider-guide-link");
    await act(async () => root.render(<Guide kind="openai" />));
    expect(document.body.style.overflow).toBe("auto");
    document.body.style.overflow = "";
  });
});
