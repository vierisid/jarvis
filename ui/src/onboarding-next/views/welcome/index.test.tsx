import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WelcomeModel, WelcomeViewProps } from "./index";

let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let WelcomeView: typeof import("./index").WelcomeView;
let host: HTMLElement;
let root: ReturnType<typeof createRoot> | undefined;
const realFetch = globalThis.fetch;
const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
let networkCalls = 0;
let intents: string[];
let props: WelcomeViewProps;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ WelcomeView } = await import("./index"));
  globalThis.fetch = Object.assign(
    async () => { networkCalls++; throw new Error("A controlled view must not fetch"); },
    { preconnect: realFetch.preconnect },
  );
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  GlobalRegistrator.unregister();
});

async function mount(model: Partial<WelcomeModel> = {}) {
  intents = [];
  networkCalls = 0;
  props = {
    model: { theme: "light", installMode: "hosted", state: { kind: "ready" }, ...model },
    onSetUp: () => intents.push("setup"),
    onExit: () => intents.push("exit"),
    onThemeChange: (theme) => intents.push(theme),
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render();
}
async function render() { await act(async () => root!.render(<WelcomeView {...props} />)); }
function button(label: string) { return Array.from(host.querySelectorAll("button")).find((el) => el.textContent === label)!; }
async function click(label: string) { await act(async () => button(label).click()); }

describe("ON-U-01 isolated welcome", () => {
  test("renders with no provider, emits one setup intent and does not mutate storage or call services", async () => {
    await mount();
    localStorage.setItem("jarvis-theme", "dark");
    await click("Set up Jarvis");
    expect(intents).toEqual(["setup"]);
    expect(networkCalls).toBe(0);
    expect(localStorage.getItem("jarvis-theme")).toBe("dark");
    expect(host.querySelector("h1")?.textContent).toBe("Your AI Co-Founder.Let’s make room to build.");
  });
  test("exit is a distinct intent and never marks setup complete", async () => {
    await mount();
    await click("I’ll do this later");
    expect(intents).toEqual(["exit"]);
    expect(networkCalls).toBe(0);
  });
  test("pending blocks both intents while leaving focus and the action label stable", async () => {
    await mount();
    const start = button("Set up Jarvis");
    start.focus();
    props.model = { ...props.model, state: { kind: "pending", message: "Opening setup…" } };
    await render();
    await click("Set up Jarvis");
    await click("I’ll do this later");
    expect(intents).toEqual([]);
    expect(document.activeElement === start).toBe(true);
    expect(start.getAttribute("aria-disabled")).toBe("true");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Opening setup…");
  });
  test("error is announced, escapes provider text and permits a retry", async () => {
    await mount({ state: { kind: "error", message: "Could not continue <img src=x onerror=alert(1)>" } });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("<img");
    expect(host.querySelector("img")).toBeNull();
    await click("Set up Jarvis");
    expect(intents).toEqual(["setup"]);
  });
  test("theme emits an intent, waits for its controlled model and retains the focused button", async () => {
    await mount();
    const dark = button("Dark");
    dark.focus();
    await click("Dark");
    expect(intents).toEqual(["dark"]);
    expect(host.querySelector("section")?.dataset.theme).toBe("light");
    props.model = { ...props.model, theme: "dark" };
    await render();
    expect(document.activeElement === dark).toBe(true);
    expect(dark.getAttribute("aria-pressed")).toBe("true");
    expect(button("Light").getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector("section")?.dataset.theme).toBe("dark");
    await click("Dark");
    expect(intents).toEqual(["dark"]);
  });
  test.each(["self", "unknown"] as const)("%s never inherits the hosted plan claim", async (installMode) => {
    await mount({ installMode });
    expect(host.textContent).not.toContain("included with your plan");
    expect(host.querySelector("input")).toBeNull();
  });
  test("pending to error to ready preserves the same controls and clears stale status", async () => {
    await mount({ state: { kind: "pending", message: "Opening setup…" } });
    const start = button("Set up Jarvis");
    for (const state of [{ kind: "error", message: "Try again." }, { kind: "ready" }] as const) {
      props.model = { ...props.model, state };
      await render();
      expect(button("Set up Jarvis") === start).toBe(true);
      expect(host.querySelector('[role="status"]')?.textContent).toBe("");
    }
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("");
    await click("Set up Jarvis");
    expect(intents).toEqual(["setup"]);
  });
  test("long copy remains real text and both actions remain ordinary non-submit buttons", async () => {
    await mount();
    const long = "A longer welcome sentence. ".repeat(25);
    props.copy = { title: long, subtitle: "Make room to build.", description: long };
    await render();
    expect(host.querySelector("h1")?.textContent).toContain(long);
    expect(Array.from(host.querySelectorAll("button")).every((el) => el.type === "button")).toBe(true);
    expect(host.querySelector("section")?.getAttribute("aria-labelledby")).toBe(host.querySelector("h1")?.id ?? "");
  });
});
