import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type { BriefShellPort } from "../contracts";
import { AUTHORITY_SCOPE, makeAuthorityFixture } from "./fixtures";
import { ACTION_CATEGORIES, CATEGORY_LABELS } from "./model";
import type { AuthorityBinding } from "./AuthorityWorkspace";
import { BRIEF_CONTRACT_VERSION } from "../../../../src/brief/contracts";
let React: typeof import("react"),
  createRoot: (typeof import("react-dom/client"))["createRoot"],
  Workspace: (typeof import("./AuthorityWorkspace"))["AuthorityWorkspace"];
let host: HTMLDivElement,
  root: Root,
  fixture: ReturnType<typeof makeAuthorityFixture>;
const wait = () => new Promise((r) => setTimeout(r, 20));
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ AuthorityWorkspace: Workspace } = await import("./AuthorityWorkspace"));
  HTMLElement.prototype.setPointerCapture = () => {};
});
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture = makeAuthorityFixture();
});
afterEach(async () => {
  await React.act(async () => {
    root.unmount();
    fixture.controller.retire();
  });
  host.remove();
});
afterAll(() => GlobalRegistrator.unregister());
function shell(overrides: Partial<BriefShellPort> = {}): BriefShellPort {
  return {
    mode: "preview",
    route: { room: "authority", selection: {} },
    theme: "light",
    sidebar: "expanded",
    chatOpen: false,
    setTheme() {},
    setSidebar() {},
    setChatOpen() {},
    navigate() {},
    ...overrides,
  };
}
function binding(): AuthorityBinding {
  return {
    source: "fixture",
    scopeId: AUTHORITY_SCOPE,
    controller: fixture.controller,
  };
}
async function render(
  overrides: Partial<BriefShellPort> = {},
  bind: AuthorityBinding | undefined = binding(),
  key = "room",
) {
  await React.act(async () => {
    root.render(
      <Workspace key={key} shell={shell(overrides)} binding={bind} />,
    );
    await wait();
  });
  await React.act(settle);
}
const slider = () =>
  host.querySelector<HTMLInputElement>('input[type="range"]')!;
function button(label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (n) =>
      (
        n.getAttribute("aria-label") ??
        n.querySelector(".brief-button__label")?.textContent ??
        n.textContent
      )?.trim() === label,
  );
  if (!result) throw Error(`Missing ${label}`);
  return result;
}
async function settle() {
  await wait();
  for (
    let i = 0;
    i < 100 &&
    (fixture.controller.snapshot().reading ||
      fixture.controller.snapshot().phase === "saving");
    i++
  )
    await wait();
  expect(fixture.controller.snapshot().reading).toBe(false);
  expect(fixture.controller.snapshot().phase).not.toBe("saving");
}
async function click(label: string) {
  await React.act(async () => {
    button(label).click();
    await settle();
  });
}
async function key(key: string) {
  await React.act(async () => {
    slider().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true }),
    );
  });
}
async function pointer(type: string, value?: number) {
  await React.act(async () => {
    if (value !== undefined) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(slider(), value);
      slider().dispatchEvent(new Event("input", { bubbles: true }));
    } else
      slider().dispatchEvent(
        new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1 }),
      );
  });
}
test("all thirteen current categories are readable with distinct on/off semantics", async () => {
  await render();
  expect(host.querySelector("h1")?.textContent).toBe("Authority");
  expect(host.querySelectorAll('[role="switch"]')).toHaveLength(13);
  for (const category of ACTION_CATEGORIES)
    expect(button(CATEGORY_LABELS[category]).getAttribute("aria-checked")).toBe(
      String(fixture.current().governed_categories.includes(category)),
    );
  expect(host.textContent).toContain(
    "Off uses the authority level and other rules",
  );
  expect(host.querySelector('[role="tablist"]')).toBeNull();
  expect(host.textContent).not.toMatch(/Add a rule|Oct 12|always require/i);
});
test("keyboard steps and Home/End agree with restored canonical values after explicit save", async () => {
  await render();
  await key("ArrowRight");
  expect(slider().value).toBe("4");
  await key("ArrowLeft");
  expect(slider().value).toBe("3");
  await key("Home");
  await key("ArrowLeft");
  expect(slider().value).toBe("1");
  await key("End");
  await key("ArrowRight");
  expect(slider().value).toBe("10");
  expect(slider().getAttribute("aria-valuenow")).toBe("10");
  expect(fixture.writes).toHaveLength(0);
  await click("Save changes");
  expect(host.textContent).toContain("Changes saved and checked.");
  expect(fixture.current().default_level).toBe(10);
  await render({}, binding(), "remounted");
  expect(slider().value).toBe("10");
});
test("pointer position stays continuous until release and focus refresh cannot interrupt a clean drag", async () => {
  await render();
  await pointer("pointerdown");
  await pointer("input", 6.4);
  expect(slider().value).toBe("6.4");
  expect(slider().getAttribute("aria-valuenow")).toBe("6");
  expect(fixture.controller.snapshot().draft?.default_level).toBe(3);
  await React.act(async () => {
    fixture.change({ default_level: 8 });
    window.dispatchEvent(new Event("focus"));
    await wait();
  });
  expect(slider().disabled).toBe(false);
  expect(slider().value).toBe("6.4");
  await pointer("pointerup");
  expect(slider().value).toBe("6");
  expect(fixture.controller.snapshot().draft?.default_level).toBe(6);
  expect(fixture.writes).toHaveLength(0);
});
test("pointer cancellation restores the starting level and releases the refresh lock", async () => {
  await render();
  await pointer("pointerdown");
  await pointer("input", 7.7);
  await pointer("pointercancel");
  expect(slider().value).toBe("3");
  expect(fixture.controller.snapshot().phase).toBe("clean");
  await React.act(async () => {
    fixture.change({ default_level: 9 });
    await fixture.controller.refresh();
  });
  expect(slider().value).toBe("9");
});
test("unsaved level and category edits survive room remount and all eight shell states", async () => {
  await render();
  await key("End");
  await click("Send email");
  for (const theme of ["light", "dark"] as const)
    for (const sidebar of ["expanded", "rail"] as const)
      for (const chatOpen of [false, true]) {
        await render(
          { theme, sidebar, chatOpen },
          binding(),
          `${theme}-${sidebar}-${chatOpen}`,
        );
        expect(slider().value).toBe("10");
        expect(button("Send email").getAttribute("aria-checked")).toBe("false");
        expect(host.textContent).toContain("Unsaved changes");
      }
  expect(fixture.writes).toHaveLength(0);
});
test("read-only keeps on/off values visible but all write controls disabled", async () => {
  fixture.controller.retire();
  fixture = makeAuthorityFixture("read-only");
  await render();
  expect(slider().disabled).toBe(true);
  expect(button("Send email").disabled).toBe(true);
  expect(button("Send email").getAttribute("aria-checked")).toBe("true");
  expect(button("Read data").getAttribute("aria-checked")).toBe("false");
  expect(button("Save changes").disabled).toBe(true);
  await key("End");
  expect(slider().value).toBe("3");
  await click("Emergency controls");
  expect(fixture.navigations).toEqual(["emergency-controls"]);
});
test("review regression: read-only reports stale values and recovers without enabling writes", async () => {
  fixture.controller.retire();
  fixture = makeAuthorityFixture("read-only");
  await render();
  await React.act(async () => {
    fixture.failReads(true);
    await fixture.controller.refresh();
  });
  expect(host.textContent).toContain("Read-only settings");
  expect(host.textContent).toContain("Could not load current settings");
  expect(slider().value).toBe("3");
  expect(slider().disabled).toBe(true);
  expect(button("Save changes").disabled).toBe(true);
  fixture.failReads(false);
  await click("Reload settings");
  expect(host.textContent).not.toContain("Could not load current settings");
  expect(host.textContent).toContain("Read-only settings");
  expect(slider().disabled).toBe(true);
  fixture.host.request = async () => new Response(null, { status: 403 });
  await click("Reload settings");
  expect(slider()).toBeNull();
});
for (const example of [
  "save-failure",
  "persistence-failure",
  "lost-response",
  "conflict",
] as const)
  test(`${example} leaves editable values visible without claiming Saved`, async () => {
    fixture.controller.retire();
    fixture = makeAuthorityFixture(example);
    await render();
    await key("End");
    await click("Save changes");
    expect(slider().value).toBe("10");
    expect(slider().disabled).toBe(true);
    expect(host.querySelector(".brief-authority-save p")?.textContent).toMatch(
      /not confirmed|changed elsewhere/,
    );
    expect(
      button(example === "conflict" ? "Save changes" : "Retry save").disabled,
    ).toBe(true);
    await click("Advanced overrides");
    expect(fixture.navigations).toEqual(["advanced-authority"]);
    await click("Reload settings");
    expect(slider().disabled).toBe(false);
    if (example !== "conflict") {
      expect(slider().value).toBe("10");
      expect(button("Retry save").disabled).toBe(false);
      expect(button("Discard retry").disabled).toBe(false);
      expect(fixture.writes).toHaveLength(1);
      fixture.recoverWrites();
      await click("Retry save");
      expect(host.textContent).toContain("Changes saved and checked.");
      expect(fixture.writes).toHaveLength(2);
    }
  });
test("live emergency banner changes while edits stay visible and unsaved", async () => {
  await render();
  await key("End");
  for (const state of ["paused", "normal", "killed", "normal"] as const) {
    await React.act(async () => {
      fixture.changeEmergency(state);
      await fixture.controller.refresh();
    });
    expect(host.textContent?.includes("Authority is paused.")).toBe(
      state === "paused",
    );
    expect(host.textContent?.includes("Emergency stop is active.")).toBe(
      state === "killed",
    );
    expect(slider().value).toBe("10");
    expect(button("Save changes").disabled).toBe(false);
    expect(fixture.writes).toHaveLength(0);
  }
});
test("discard retry remains an explicit alternative without displaying Saved", async () => {
  fixture.controller.retire();
  fixture = makeAuthorityFixture("persistence-failure");
  await render();
  await key("Home");
  await click("Save changes");
  await click("Reload settings");
  await click("Discard retry");
  expect(slider().value).toBe("1");
  expect(button("Save changes").disabled).toBe(true);
  expect(host.textContent).toContain("previous save was not confirmed");
  expect(host.textContent).not.toContain("Changes saved and checked.");
  expect(fixture.writes).toHaveLength(1);
});
test("stale values are non-editable and permission loss removes their content", async () => {
  await render();
  await React.act(async () => {
    fixture.failReads(true);
    await fixture.controller.refresh();
  });
  expect(slider().disabled).toBe(true);
  expect(host.textContent).toContain("Refresh before editing");
  fixture.host.request = async () => new Response(null, { status: 403 });
  await click("Reload settings");
  expect(slider()).toBeNull();
  expect(host.querySelectorAll('[role="switch"]')).toHaveLength(0);
});
test("live activation rejects fixtures, scope mismatches and a missing F-25 gate or destinations", async () => {
  await render({ mode: "live" });
  expect(slider()).toBeNull();
  await render({}, { ...binding(), scopeId: "different" });
  expect(slider()).toBeNull();
  fixture.controller.retire();
  const { AuthorityController } = await import("./controller");
  fixture.controller = new AuthorityController({
    ...fixture.port,
    source: "live",
  });
  const live: AuthorityBinding = { ...binding(), source: "live" };
  await render({ mode: "live" }, live);
  expect(slider()).toBeNull();
  live.capabilities = {
    contractVersion: BRIEF_CONTRACT_VERSION,
    capabilities: {
      navigationCompatibility: {
        supported: true,
        ready: true,
        enabled: true,
        state: "ready",
        reason: null,
      },
    },
  };
  await render({ mode: "live" }, live);
  expect(slider()).not.toBeNull();
  (fixture.port.destinations as Record<string, boolean>)["emergency-controls"] =
    false;
  await render({ mode: "live" }, live);
  expect(slider()).toBeNull();
  expect(fixture.controller.snapshot().saved).toBeNull();
});
test("replacing the scope binding purges and disables the old controller", async () => {
  await render();
  const old = fixture;
  fixture = makeAuthorityFixture("read-only");
  await render();
  expect(old.controller.snapshot().saved).toBeNull();
  expect(old.controller.editable()).toBe(false);
  expect(slider().disabled).toBe(true);
  old.controller.retire();
});

test("background focus refresh preserves a focused clean keyboard control", async () => {
  await render();
  slider().focus();
  await React.act(async () => {
    fixture.change({ default_level: 8 });
    window.dispatchEvent(new Event("focus"));
    await wait();
  });
  expect(document.activeElement).toBe(slider());
  expect(slider().disabled).toBe(false);
  expect(slider().value).toBe("3");
  slider().blur();
  await React.act(async () => {
    window.dispatchEvent(new Event("focus"));
    await wait();
  });
  expect(slider().value).toBe("8");
});
