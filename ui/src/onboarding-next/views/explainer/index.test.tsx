import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ExplainerModel, ExplainerViewProps } from "./index";

let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let ExplainerView: typeof import("./index").ExplainerView;
let explainerCopy: typeof import("./index").explainerCopy;
let host: HTMLElement;
let root: ReturnType<typeof createRoot> | undefined;
const realFetch = globalThis.fetch;
const previousAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
let networkCalls = 0;
let intents: string[];
let props: ExplainerViewProps;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ ExplainerView, explainerCopy } = await import("./index"));
  globalThis.fetch = Object.assign(async () => {
    networkCalls++;
    throw new Error("The explainer must not call a service");
  }, { preconnect: realFetch.preconnect });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  localStorage.clear();
  sessionStorage.clear();
});
afterAll(() => {
  globalThis.fetch = realFetch;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousAct;
  GlobalRegistrator.unregister();
});

async function mount(model: Partial<ExplainerModel> = {}) {
  intents = [];
  networkCalls = 0;
  props = {
    model: { theme: "light", state: { kind: "ready" }, ...model },
    onBack: () => intents.push("back"),
    onContinue: () => intents.push("continue"),
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render();
}
async function render() { await act(async () => root!.render(<ExplainerView {...props} />)); }
function button(label: string) { return Array.from(host.querySelectorAll("button")).find(el => el.textContent === label)!; }
async function click(label: string) { await act(async () => button(label).click()); }

describe("ON-U-02 optional explainer", () => {
  test("explains the ordered relationship and conditional Awareness without starting anything", async () => {
    await mount();
    expect(host.querySelector("ol")?.getAttribute("aria-label")).toBe("From repetition to your goal");
    expect(Array.from(host.querySelectorAll("li h2")).map(el => el.textContent)).toEqual([
      "Jarvis notices", "A workflow takes shape", "Your goal moves forward",
    ]);
    expect(host.textContent).toContain("With Awareness on");
    expect(host.textContent).toContain("Describe it in Workflows.");
    expect(host.querySelectorAll("button").length).toBe(2);
    expect(host.querySelector("input")).toBeNull();
    expect(networkCalls).toBe(0);
  });
  test.each(["Back", "Continue"])("%s emits exactly one intent without setup, permissions or theme writes", async label => {
    await mount();
    localStorage.setItem("jarvis-theme", "dark");
    sessionStorage.setItem("setup", "unchanged");
    await click(label);
    expect(intents).toEqual([label.toLowerCase()]);
    expect(networkCalls).toBe(0);
    expect(localStorage.length).toBe(1);
    expect(sessionStorage.length).toBe(1);
    expect(localStorage.getItem("jarvis-theme")).toBe("dark");
    expect(sessionStorage.getItem("setup")).toBe("unchanged");
    expect(host.querySelector("section")?.dataset.theme).toBe("light");
  });
  test("pending retains focus and control identity while blocking both navigation intents", async () => {
    await mount();
    const next = button("Continue");
    next.focus();
    props.model = { ...props.model, state: { kind: "pending", message: "Opening the next step…" } };
    await render();
    await click("Continue");
    await click("Back");
    expect(intents).toEqual([]);
    expect(button("Continue")).toBe(next);
    expect(document.activeElement).toBe(next);
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Opening the next step…");
  });
  test("failed navigation is plain text, announced locally and can be retried", async () => {
    await mount({ state: { kind: "error", message: "Could not continue <img src=x onerror=alert(1)>" } });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("<img");
    expect(host.querySelector("img")).toBeNull();
    await click("Continue");
    expect(intents).toEqual(["continue"]);
  });
  test("theme/state updates preserve focus and clear obsolete feedback", async () => {
    await mount({ state: { kind: "pending", message: "Opening…" } });
    const back = button("Back");
    back.focus();
    props.model = { theme: "dark", state: { kind: "error", message: "Please try again." } };
    await render();
    expect(host.querySelector("section")?.dataset.theme).toBe("dark");
    expect(document.activeElement).toBe(back);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("");
    props.model = { theme: "light", state: { kind: "ready" } };
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("");
    expect(button("Back")).toBe(back);
    await click("Back");
    expect(intents).toEqual(["back"]);
  });
  test("long translated copy remains text and the labelled region has non-submit controls", async () => {
    await mount();
    const long = "An intentionally longer description of repetitive work. ".repeat(15);
    props.copy = { ...explainerCopy, title: long, steps: explainerCopy.steps.map(step => ({ ...step, description: long })) as unknown as typeof explainerCopy.steps };
    await render();
    expect(host.querySelector("h1")?.textContent).toBe(long);
    expect(host.querySelector("section")?.getAttribute("aria-labelledby")).toBe(host.querySelector("h1")?.id ?? "");
    expect(Array.from(host.querySelectorAll("button")).every(el => el.type === "button")).toBe(true);
    expect(host.querySelectorAll("li").length).toBe(3);
  });
});
