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
import type { BriefShellPort } from "../../contracts";
import type { ProfileBinding } from "./ProfileWorkspace";
import { makeProfileFixture, PROFILE_SCOPE } from "./fixtures";
import { guardProfileNavigation } from "./navigation";
let React: typeof import("react"),
  createRoot: (typeof import("react-dom/client"))["createRoot"],
  Workspace: (typeof import("./ProfileWorkspace"))["ProfileWorkspace"];
let root: Root,
  host: HTMLDivElement,
  fixture: ReturnType<typeof makeProfileFixture>;
const wait = () => new Promise((r) => setTimeout(r, 10));
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ ProfileWorkspace: Workspace } = await import("./ProfileWorkspace"));
});
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture = makeProfileFixture();
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
    route: { room: "profile", selection: {} },
    theme: "light",
    sidebar: "expanded",
    chatOpen: false,
    setTheme() {},
    setChatOpen() {},
    setSidebar() {},
    navigate() {},
    ...overrides,
  };
}
const binding = (): ProfileBinding => ({
  source: "fixture",
  scopeId: PROFILE_SCOPE,
  controller: fixture.controller,
});
async function settle() {
  for (let i = 0; i < 100; i++) {
    await wait();
    if (
      !fixture.controller.snapshot().reading &&
      fixture.controller.snapshot().phase !== "saving"
    )
      return;
  }
  throw Error("Profile did not settle");
}
async function render(
  options: Partial<BriefShellPort> = {},
  bind = binding(),
  key = "room",
  guarded = true,
) {
  await React.act(async () => {
    const port = shell(options);
    root.render(
      <Workspace
        key={key}
        shell={
          guarded ? guardProfileNavigation(port, fixture.controller) : port
        }
        binding={bind}
      />,
    );
  });
  await React.act(settle);
}
function field(label: string) {
  const node = [...host.querySelectorAll("label")].find(
    (n) => n.textContent === label,
  )!;
  return host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[id="${node.htmlFor}"]`,
  )!;
}
function button(label: string) {
  const node = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (n) =>
      (
        n.querySelector(".brief-button__label")?.textContent ?? n.textContent
      )?.trim() === label,
  );
  if (!node) throw Error(`Missing ${label}`);
  return node;
}
async function edit(label: string, value: string) {
  await React.act(async () => {
    const node = field(label);
    const proto =
      node.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(label: string) {
  await React.act(async () => {
    button(label).click();
  });
  await React.act(settle);
}

test("renders the six approved accessible fields without fabricating account identity", async () => {
  await render();
  expect(host.querySelectorAll("label")).toHaveLength(6);
  expect(field("Full name").value).toBe("");
  expect(field("Full name").disabled).toBe(true);
  expect(field("Full name").getAttribute("aria-describedby")).toBeTruthy();
  expect(field("Role").tagName).toBe("TEXTAREA");
  expect(field("What should Jarvis call you?").value).toBe("Alex");
  expect(button("Save changes").disabled).toBe(true);
});
test("typing submits only the changed canonical answer and remount reads saved values", async () => {
  await render();
  await edit("Company", "  New studio  ");
  await click("Save changes");
  expect(fixture.writes[0]!.answers).toEqual({ company: "New studio" });
  expect(button("Saved").disabled).toBe(true);
  await render({}, binding(), "remount");
  expect(field("Company").value).toBe("New studio");
  expect(fixture.current().answers.interests).toBe("Walking and astronomy");
});
test("validation retains a long pasted draft, associates the error, and blocks submission", async () => {
  await render();
  await edit("What are you building?", "x".repeat(4001));
  const node = field("What are you building?");
  expect(node.value.length).toBe(4001);
  expect(node.getAttribute("aria-invalid")).toBe("true");
  expect(
    host.querySelector(`[id="${node.getAttribute("aria-describedby")}"]`)
      ?.textContent,
  ).toContain("4,000");
  expect(button("Save changes").disabled).toBe(true);
  expect(fixture.writes).toHaveLength(0);
});
test("chat, sidebar, theme and room remount retain the draft and ordinary rerenders retain focus", async () => {
  await render();
  await edit("Company", "Draft studio");
  field("Company").focus();
  await render({ chatOpen: true, sidebar: "rail", theme: "dark" });
  expect(document.activeElement).toBe(field("Company"));
  expect(field("Company").value).toBe("Draft studio");
  fixture.change({ company: "External studio" });
  await render({}, binding(), "remount");
  expect(field("Company").value).toBe("Draft studio");
});
test("Cancel opens a modal; keep editing and Escape preserve the draft and return focus", async () => {
  await render();
  await edit("Company", "Draft studio");
  button("Cancel").focus();
  await click("Cancel");
  expect(host.querySelector("dialog")!.open).toBe(true);
  await click("Keep editing");
  expect(host.querySelector("dialog")!.open).toBe(false);
  expect(field("Company").value).toBe("Draft studio");
  expect(document.activeElement).toBe(button("Cancel"));
  await click("Cancel");
  await React.act(async () => {
    host
      .querySelector("dialog")!
      .dispatchEvent(new Event("cancel", { cancelable: true }));
  });
  expect(fixture.controller.snapshot().prompt).toBeNull();
  expect(field("Company").value).toBe("Draft studio");
});
test("discard only replaces the draft after a successful canonical reload", async () => {
  await render();
  await edit("Company", "Draft studio");
  fixture.failReads(true);
  await click("Cancel");
  await click("Discard edits");
  expect(field("Company").value).toBe("Draft studio");
  expect(fixture.writes).toHaveLength(0);
  fixture.failReads(false);
  await click("Refresh profile");
  fixture.change({ company: "Current studio" });
  await click("Cancel");
  await click("Discard edits");
  expect(field("Company").value).toBe("Current studio");
});
test("lost response retains edits and explicitly retrying can confirm the canonical save", async () => {
  fixture = makeProfileFixture("lost-response");
  await render();
  await edit("Company", "Saved studio");
  await click("Save changes");
  expect(field("Company").value).toBe("Saved studio");
  expect(field("Company").readOnly).toBe(true);
  expect(fixture.writes).toHaveLength(1);
  fixture.recoverWrites();
  await click("Retry save");
  expect(button("Saved").disabled).toBe(true);
  expect(fixture.writes).toHaveLength(2);
});
test("new text entered while a save is pending remains editable and unsaved", async () => {
  fixture = makeProfileFixture("ready", 60);
  await render();
  await edit("Company", "Submitted");
  await React.act(async () => {
    button("Save changes").click();
  });
  expect(button("Saving…").getAttribute("aria-disabled")).toBe("true");
  expect(field("Company").readOnly).toBe(false);
  await edit("Company", "Newer draft");
  await React.act(settle);
  expect(field("Company").value).toBe("Newer draft");
  expect(fixture.current().answers.company).toBe("Submitted");
  expect(button("Save changes").disabled).toBe(false);
});
test("navigation uses the shared guard and only leaves after explicit discard", async () => {
  const routes: string[] = [];
  const port = guardProfileNavigation(
    shell({ navigate: (r) => routes.push(r.room) }),
    fixture.controller,
  );
  await render();
  await edit("Company", "Draft");
  await React.act(async () => {
    port.navigate({ room: "today", selection: {} });
  });
  expect(routes).toEqual([]);
  expect(host.querySelector("dialog")!.open).toBe(true);
  await click("Keep editing");
  expect(routes).toEqual([]);
  await React.act(async () => {
    port.navigate({ room: "billing", selection: {} });
  });
  await click("Leave without saving");
  expect(routes).toEqual(["billing"]);
  expect(fixture.writes).toHaveLength(0);
});
test("a scope change between confirmation and navigation cancels the obsolete route", async () => {
  await render();
  let moved = false;
  await React.act(async () => {
    const leaving = fixture.controller.navigateAway(() => {
      moved = true;
    });
    fixture.controller.setAccess(false);
    await leaving;
  });
  expect(moved).toBe(false);
});
test("beforeunload warns only while a draft is dirty", async () => {
  await render();
  let event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  await edit("Company", "Draft");
  event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await click("Save changes");
  event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});
test("read-only profile and stale reads cannot send a mutation", async () => {
  fixture = makeProfileFixture("read-only");
  await render();
  expect(field("Company").disabled).toBe(true);
  expect(host.textContent).toContain("Read-only profile");
  expect(button("Save changes").disabled).toBe(true);
  await React.act(async () => {
    fixture.controller.retire();
  });
  fixture = makeProfileFixture();
  await render();
  await edit("Company", "Draft");
  fixture.failReads(true);
  await React.act(async () => {
    await fixture.controller.refresh();
  });
  expect(field("Company").readOnly).toBe(true);
  expect(button("Save changes").disabled).toBe(true);
  expect(field("Company").value).toBe("Draft");
  expect(fixture.writes).toHaveLength(0);
});
for (const example of ["empty", "unavailable", "unsupported", "error"] as const)
  test(`${example} is represented without writable invented values`, async () => {
    fixture = makeProfileFixture(example);
    await render();
    expect(fixture.writes).toHaveLength(0);
    if (example === "empty") expect(field("Company").value).toBe("");
    else {
      expect(host.querySelector("form")).toBeNull();
      expect(button("Retry")).toBeTruthy();
    }
  });
test("live/fixture mixing, scope mismatch, and missing navigation guard fail closed and purge the old draft", async () => {
  await render();
  await edit("Company", "Private draft");
  await render({ mode: "live" });
  expect(host.textContent).toContain("unavailable here");
  expect(fixture.controller.snapshot().draft).toEqual({});
  await render({}, { ...binding(), scopeId: "different" });
  expect(host.querySelector("form")).toBeNull();
  await render({}, binding(), "room", false);
  expect(host.querySelector("form")).toBeNull();
  expect(fixture.writes).toHaveLength(0);
});

test("live form requires the enabled F23 capability and loses its draft when that capability is removed", async () => {
  const { ProfileController } = await import("./controller");
  fixture = {
    ...fixture,
    controller: new ProfileController({ ...fixture.port, source: "live" }),
  };
  const live: ProfileBinding = {
    controller: fixture.controller,
    source: "live",
    scopeId: PROFILE_SCOPE,
    capabilities: {
      contractVersion: 1,
      capabilities: {
        profileSettings: {
          supported: true,
          ready: true,
          enabled: true,
          state: "ready",
          reason: null,
        },
      },
    },
  };
  await render({ mode: "live" }, live);
  await edit("Company", "Scope-private draft");
  expect(field("Company").value).toBe("Scope-private draft");
  await render({ mode: "live" }, { ...live, capabilities: null });
  expect(host.querySelector("form")).toBeNull();
  expect(fixture.controller.snapshot().base).toBeNull();
  expect(fixture.controller.snapshot().draft).toEqual({});
  expect(fixture.writes).toHaveLength(0);
});
