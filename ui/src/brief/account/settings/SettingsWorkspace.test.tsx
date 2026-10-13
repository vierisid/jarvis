import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  test,
  expect,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type { BriefShellPort } from "../../contracts";
import type { SettingsBinding } from "./SettingsWorkspace";
import { makeSettingsFixture, SETTINGS_SCOPE } from "./fixtures";
import { SettingsController } from "./controller";
let React: typeof import("react"),
  createRoot: typeof import("react-dom/client").createRoot,
  Workspace: typeof import("./SettingsWorkspace").SettingsWorkspace;
let root: Root, host: HTMLDivElement, f: ReturnType<typeof makeSettingsFixture>;
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ SettingsWorkspace: Workspace } = await import("./SettingsWorkspace"));
});
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  f = makeSettingsFixture();
});
afterEach(async () => {
  await React.act(async () => {
    root.unmount();
    f.controller.retire();
  });
  host.remove();
});
afterAll(() => GlobalRegistrator.unregister());
const shell = (overrides: Partial<BriefShellPort> = {}): BriefShellPort => ({
  mode: "preview",
  route: { room: "settings", selection: {} },
  theme: "light",
  sidebar: "expanded",
  chatOpen: false,
  setTheme() {},
  setChatOpen() {},
  setSidebar() {},
  navigate() {},
  ...overrides,
});
const binding = (): SettingsBinding => ({
  source: "fixture",
  scopeId: SETTINGS_SCOPE,
  controller: f.controller,
});
async function settle() {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (
      !f.controller.snapshot().reading &&
      f.controller.snapshot().phase !== "saving"
    )
      return;
  }
  throw Error("Settings did not settle");
}
async function render(options: Partial<BriefShellPort> = {}, bind = binding()) {
  await React.act(async () =>
    root.render(<Workspace shell={shell(options)} binding={bind} />),
  );
  await React.act(settle);
}
function button(label: string) {
  const b = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (n) =>
      (
        n.querySelector(".brief-button__label")?.textContent ?? n.textContent
      )?.trim() === label,
  );
  if (!b) throw Error(`Missing ${label}`);
  return b;
}
async function click(label: string) {
  await React.act(async () => button(label).click());
  await React.act(settle);
}
async function select(value: string) {
  await React.act(async () => {
    const el = host.querySelector("select")!;
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await React.act(settle);
}
test("approved groups expose only canonical voice choices and honest unavailable preferences", async () => {
  await render();
  expect(
    [...host.querySelectorAll("h2")].slice(0, 3).map((n) => n.textContent),
  ).toEqual(["Conversation", "Check-ins", "Workspace controls"]);
  expect([...host.querySelectorAll("option")].map((n) => n.value)).toEqual(
    f.current().voice.choices.map((c) => c.id),
  );
  for (const label of ["Less often", "Balanced", "More often"]) {
    const input = [
      ...host.querySelectorAll<HTMLInputElement>("input[type=radio]"),
    ].find((n) => n.closest("label")?.textContent === label)!;
    expect(input.disabled).toBe(true);
    expect(input.checked).toBe(false);
  }
  expect(host.textContent).toContain(
    "Check-in preferences are not supported yet",
  );
  expect(host.textContent).not.toContain("Marin");
  expect(f.writes).toHaveLength(0);
});
test("voice autosave keeps the select mounted and pending recovery is explicit", async () => {
  f = makeSettingsFixture("lost-response");
  await render();
  const selectNode = host.querySelector("select")!;
  selectNode.focus();
  await select("en-US-GuyNeural");
  expect(host.querySelector("select")).toBe(selectNode);
  expect(selectNode.value).toBe("en-US-GuyNeural");
  expect(button("Retry save").disabled).toBe(false);
  await render({ theme: "dark", chatOpen: true, sidebar: "rail" });
  expect(document.activeElement).toBe(selectNode);
  f.recoverWrites();
  await click("Retry save");
  expect(f.writes).toHaveLength(1);
  expect(host.textContent).toContain("Live application is unconfirmed");
});
test("saved application failure stays visible across canonical polls", async () => {
  f = makeSettingsFixture("apply-failure");
  await render();
  await select("en-US-GuyNeural");
  await React.act(async () => {
    await f.controller.refresh();
  });
  expect(host.textContent).toContain("could not be applied");
  expect(f.writes).toHaveLength(1);
});
test("hosted controls never expose provider selection; tutorial requires confirmation and restores focus", async () => {
  f = makeSettingsFixture("hosted");
  await render();
  expect(host.textContent).toContain(
    "Provider setup is managed by your hosted service",
  );
  expect(host.querySelectorAll("select")).toHaveLength(1);
  button("Replay").focus();
  await click("Replay");
  expect(host.querySelector("dialog")!.open).toBe(true);
  await click("Keep settings");
  expect(document.activeElement).toBe(button("Replay"));
  expect(f.replays).toHaveLength(0);
  await click("Replay");
  await React.act(async () =>
    host
      .querySelector("dialog")!
      .dispatchEvent(new Event("cancel", { cancelable: true })),
  );
  expect(host.querySelector("dialog")!.open).toBe(false);
  await click("Replay");
  await click("Replay tutorial");
  expect(f.replays).toEqual(["tutorial"]);
  expect(f.writes).toHaveLength(0);
});
test("read-only and stale settings cannot mutate or replay", async () => {
  f = makeSettingsFixture("read-only");
  await render();
  expect(host.querySelector("select")!.disabled).toBe(true);
  expect(button("Replay").disabled).toBe(true);
  expect(host.textContent).toContain("Read-only settings");
  await React.act(async () => f.controller.retire());
  f = makeSettingsFixture();
  await render();
  f.failReads(true);
  await click("Refresh settings");
  expect(host.querySelector("select")!.disabled).toBe(true);
  expect(button("Replay").disabled).toBe(true);
  expect(f.writes).toHaveLength(0);
});
test("scope mismatch and fixture/live mixing purge settings", async () => {
  await render();
  await render({ mode: "live" });
  expect(host.querySelector("select")).toBeNull();
  expect(f.controller.snapshot().base).toBeNull();
  await render({}, { ...binding(), scopeId: "another-account" });
  expect(host.querySelector("select")).toBeNull();
});
test("live settings require both F23 and F25 and all destination callbacks", async () => {
  f.controller.retire();
  f = {
    ...f,
    controller: new SettingsController({ ...f.port, source: "live" }),
  };
  const enabled = {
    supported: true,
    ready: true,
    enabled: true,
    state: "ready",
    reason: null,
  };
  const live: SettingsBinding = {
    ...binding(),
    source: "live",
    capabilities: {
      contractVersion: 1,
      capabilities: {
        profileSettings: enabled,
        navigationCompatibility: enabled,
      },
    },
  };
  await render({ mode: "live" }, live);
  expect(host.querySelector("select")).not.toBeNull();
  for (const cap of ["profileSettings", "navigationCompatibility"]) {
    await render(
      { mode: "live" },
      {
        ...live,
        capabilities: { contractVersion: 1, capabilities: { [cap]: enabled } },
      },
    );
    expect(host.querySelector("select")).toBeNull();
    expect(f.controller.snapshot().base).toBeNull();
  }
  await render({ mode: "live" }, live);
  (f.controller.destinations as { "advanced-settings": boolean })[
    "advanced-settings"
  ] = false;
  await render({ mode: "live" }, live);
  expect(host.querySelector("select")).toBeNull();
});
