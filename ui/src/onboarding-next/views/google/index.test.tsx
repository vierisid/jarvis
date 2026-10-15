import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { GoogleConnectionState, GoogleViewProps } from "./index";

let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let GoogleView: typeof import("./index").GoogleView;
let host: HTMLElement;
let root: ReturnType<typeof createRoot> | undefined;
let props: GoogleViewProps;
let intents: string[];
let networkCalls = 0;
let externalCalls = 0;
const realFetch = globalThis.fetch;
const previousAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ GoogleView } = await import("./index"));
  globalThis.fetch = Object.assign(async () => { networkCalls++; throw new Error("UI must not perform OAuth"); }, { preconnect: realFetch.preconnect });
  window.open = () => { externalCalls++; return null; };
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

async function mount(connection: GoogleConnectionState = { state: "idle" }) {
  intents = []; networkCalls = 0; externalCalls = 0;
  props = {
    model: { theme: "light", connection, navigation: { kind: "ready" }, progress: { current: 3, total: 6 } },
    onConnect: () => intents.push("connect"), onCancel: id => intents.push(`cancel:${id}`),
    onBack: () => intents.push("back"), onSkip: () => intents.push("skip"), onContinue: () => intents.push("continue"),
  };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await render();
}
async function render() { await act(async () => root!.render(<GoogleView {...props} />)); }
function button(label: string) { return Array.from(host.querySelectorAll("button")).find(el => el.textContent === label)!; }
async function click(label: string) { await act(async () => button(label).click()); }
async function setConnection(connection: GoogleConnectionState) { props.model = { ...props.model, connection }; await render(); }
const connected: GoogleConnectionState = { state: "connected", attemptId: "attempt-1", accountLabel: "founder@example.com", grantedAccessSummary: "Read your calendar. Gmail access was not granted." };

describe("ON-U-03 Google connection view", () => {
  test("Connect emits an intent without OAuth, storage writes, Telegram or optimistic success", async () => {
    await mount();
    localStorage.setItem("setup", "unchanged"); sessionStorage.setItem("journey", "unchanged");
    await click("Connect");
    expect(intents).toEqual(["connect"]);
    expect(host.textContent).not.toContain("Connected");
    expect(host.textContent).not.toContain("Telegram");
    expect(host.textContent).not.toContain("Read-only access");
    expect(networkCalls).toBe(0); expect(externalCalls).toBe(0);
    expect(localStorage.length).toBe(1); expect(localStorage.getItem("setup")).toBe("unchanged");
    expect(sessionStorage.length).toBe(1); expect(sessionStorage.getItem("journey")).toBe("unchanged");
    expect(host.querySelector("h2")?.textContent).toBe("Google");
  });
  test("waiting preserves the focused control, never reports success and cancels the exact attempt", async () => {
    await mount();
    const connect = button("Connect"); connect.focus();
    await setConnection({ state: "pending", attemptId: "attempt-42", accountLabel: "founder@example.com" });
    expect(document.activeElement).toBe(connect);
    expect(button("Cancel sign-in")).toBe(connect);
    expect(host.textContent).toContain("Waiting for Google");
    expect(host.textContent).not.toContain("Connected");
    await click("Continue"); expect(intents).toEqual([]);
    await click("Cancel sign-in"); expect(intents).toEqual(["cancel:attempt-42"]);
    expect(host.textContent).toContain("Waiting for Google"); // Provider must acknowledge cancellation.
  });
  test.each(["cancelled", "expired"] as const)("%s permits retry with the same focused target", async state => {
    await mount({ state: "pending", attemptId: "old" });
    const cancel = button("Cancel sign-in"); cancel.focus();
    await setConnection({ state, attemptId: "old" });
    expect(button("Try again")).toBe(cancel); expect(document.activeElement).toBe(cancel);
    expect(host.textContent).toContain(state);
    await click("Try again"); expect(intents).toEqual(["connect"]);
    expect(host.textContent).not.toContain("Connected");
  });
  test.each([
    "Google consent was denied. Try again, or skip for now.",
    "The sign-in window could not be opened. Try again, or skip for now.",
  ])("announces and recovers from %s", async message => {
    await mount({ state: "error", attemptId: "attempt-1", message });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(message);
    await click("Try again"); expect(intents).toEqual(["connect"]);
    await setConnection({ state: "pending", attemptId: "attempt-2" });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("");
    expect(host.textContent).not.toContain("Connected");
  });
  test("connected renders only verified account/access details, without assuming send rights", async () => {
    await mount({ state: "pending", attemptId: "attempt-1" });
    const cancel = button("Cancel sign-in"); cancel.focus();
    await setConnection(connected);
    expect(button("Connected")).toBe(cancel); expect(document.activeElement).toBe(cancel);
    expect(host.textContent).toContain("founder@example.com");
    expect(host.textContent).toContain("Read your calendar. Gmail access was not granted.");
    expect(host.textContent).not.toContain("Connect Gmail and Calendar");
    await click("Connected"); expect(intents).toEqual([]);
    await click("Continue"); expect(intents).toEqual(["continue"]);
  });
  test("missing access summary is unknown, never a read or send grant", async () => {
    await mount({ state: "connected", attemptId: null, accountLabel: "", grantedAccessSummary: " " });
    expect(host.textContent).toContain("Granted access details are unavailable.");
    expect(host.textContent).not.toContain("Read-only");
    expect(host.querySelector(".on-google__account")?.textContent).toBe("Google account");
  });
  test.each(["Back", "Skip for now"])("%s remains available while waiting and cannot manufacture a connection", async label => {
    await mount({ state: "pending", attemptId: "attempt-3" });
    await click(label); expect(intents).toEqual([label === "Back" ? "back" : "skip"]);
    expect(host.textContent).toContain("Waiting for Google");
    expect(host.textContent).not.toContain("Connected");
    expect(networkCalls).toBe(0); expect(externalCalls).toBe(0);
  });
  test("unavailable is distinct from connected and retains deliberate navigation", async () => {
    await mount({ state: "unavailable", message: "Google connection is not available on this instance." });
    await click("Unavailable"); expect(intents).toEqual([]);
    await click("Skip for now"); await click("Continue");
    expect(intents).toEqual(["skip", "continue"]);
    expect(host.textContent).not.toContain("Connected");
  });
  test("navigation pending blocks all intents without losing focus; an error restores retry", async () => {
    await mount(); const next = button("Continue"); next.focus();
    props.model.navigation = { kind: "pending", message: "Opening the next step…" }; await render();
    for (const label of ["Connect", "Back", "Skip for now", "Continue"]) await click(label);
    expect(intents).toEqual([]); expect(document.activeElement).toBe(next);
    props.model = { ...props.model, theme: "dark", navigation: { kind: "error", message: "Could not continue. Try again." } }; await render();
    expect(document.activeElement).toBe(next); expect(button("Continue")).toBe(next);
    expect(host.querySelector("section")?.dataset.theme).toBe("dark");
    expect(host.textContent).toContain("Could not continue. Try again.");
    expect(host.textContent).not.toContain("Opening the next step");
    await click("Continue"); expect(intents).toEqual(["continue"]);
  });
  test("long account and provider messages remain escaped text with labelled non-submit controls", async () => {
    const account = "founder-and-customer-research-team-".repeat(8) + "@example.com";
    await mount({ ...connected, state: "connected", accountLabel: account });
    expect(host.querySelector(".on-google__account")?.textContent).toBe(account);
    await setConnection({ state: "error", attemptId: null, message: "Could not connect <img src=x onerror=alert(1)>" });
    expect(host.querySelector("img")).toBeNull(); expect(host.textContent).toContain("<img");
    expect(host.querySelector("section")?.getAttribute("aria-labelledby")).toBe(host.querySelector("h1")?.id ?? "");
    expect(Array.from(host.querySelectorAll("button")).every(el => el.type === "button")).toBe(true);
  });
  test("journey progress is injected, bounded and absent when unknown", async () => {
    await mount(); expect(host.textContent).toContain("Step 3 of 6");
    expect(host.querySelectorAll('[data-position="current"]').length).toBe(1);
    props.model.progress = undefined; await render(); expect(host.textContent).not.toContain("Step 3");
    props.model.progress = { current: 3, total: 100000 }; await render();
    expect(host.querySelector(".on-google__segments")).toBeNull();
  });
});
