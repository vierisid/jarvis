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
import type { WorkflowManagementBinding } from "./WorkflowManagementRoom";
import {
  makeManagementFixture,
  MANAGEMENT_SCOPE,
  MANAGEMENT_CAPABILITY,
} from "./fixtures";
let React: typeof import("react"),
  createRoot: typeof import("react-dom/client").createRoot;
let Room: typeof import("./WorkflowManagementRoom").WorkflowManagementRoom,
  available: typeof import("./WorkflowManagementRoom").managementAvailable;
let host: HTMLDivElement,
  root: Root,
  f: ReturnType<typeof makeManagementFixture>,
  shell: BriefShellPort;
beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ WorkflowManagementRoom: Room, managementAvailable: available } =
    await import("./WorkflowManagementRoom"));
});
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  f = makeManagementFixture();
  shell = {
    mode: "preview",
    theme: "light",
    sidebar: "expanded",
    chatOpen: false,
    setTheme: () => {},
    setSidebar: () => {},
    setChatOpen: () => {},
    route: { room: "all-workflows", selection: {} },
    navigate: (route) => {
      shell = { ...shell, route };
    },
  };
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  f.controller.retire();
  host.remove();
});
afterAll(() => GlobalRegistrator.unregister());
const binding = (): WorkflowManagementBinding => ({
  source: "fixture",
  scopeId: MANAGEMENT_SCOPE,
  capabilities: MANAGEMENT_CAPABILITY,
  controller: f.controller,
});
async function render(b = binding()) {
  await React.act(async () => {
    root.render(<Room shell={shell} binding={b} />);
  });
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
}
const button = (name: string) =>
  Array.from(host.querySelectorAll("button")).find(
    (b) =>
      (
        b.getAttribute("aria-label") ??
        b.querySelector(".brief-button__label")?.textContent ??
        b.textContent
      )?.trim() === name,
  )!;
async function click(name: string) {
  const b = button(name);
  expect(b).toBeTruthy();
  await React.act(async () => {
    b.click();
    await new Promise((r) => setTimeout(r, 5));
  });
}
const row = (id: string) =>
  host.querySelector<HTMLElement>(`[data-flow="${id}"]`)!;
test("missing, wrong-source, wrong-owner and capability-off binding fail closed", async () => {
  expect(available({ ...shell, mode: "live" }, binding())).toBe(false);
  expect(available(shell, { ...binding(), scopeId: "wrong" })).toBe(false);
  await render({ ...binding(), capabilities: null });
  expect(host.textContent).toContain("Workflow management is unavailable");
  expect(f.stats().reads).toBe(0);
});
test("switch and bin are separate targets; only the name opens the exact workflow", async () => {
  await render();
  await click("Enable Meeting follow-ups");
  expect(shell.route.room).toBe("all-workflows");
  expect(button("Enable Meeting follow-ups").getAttribute("aria-checked")).toBe(
    "false",
  );
  await click("Delete Meeting follow-ups");
  expect(shell.route.room).toBe("all-workflows");
  await click("Cancel");
  await click("Meeting follow-ups");
  expect(shell.route).toEqual({
    room: "workflow",
    selection: { flowId: "meeting", versionId: "meeting-v3" },
  });
});
test("inline confirm is keyboard reachable; Escape restores focus to the same bin", async () => {
  await render();
  await click("Delete Meeting follow-ups");
  expect(document.activeElement).toBe(button("Cancel"));
  await React.act(async () =>
    button("Cancel").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(document.activeElement).toBe(button("Delete Meeting follow-ups"));
  expect(f.stats().calls).toBe(0);
});
test("acknowledged deletion hides and inerts only its row, Undo restores it paused", async () => {
  await render();
  await click("Delete Meeting follow-ups");
  await click("Delete");
  expect(
    row("meeting").closest("[data-removed]")!.getAttribute("data-removed"),
  ).toBe("true");
  expect(row("meeting").closest("[inert]")).toBeTruthy();
  expect(document.activeElement).toBe(button("Undo delete Meeting follow-ups"));
  expect(host.textContent).toContain("3 workflows");
  await click("Undo delete Meeting follow-ups");
  expect(
    row("meeting").closest("[data-removed]")!.getAttribute("data-removed"),
  ).toBe("false");
  expect(button("Enable Meeting follow-ups").getAttribute("aria-checked")).toBe(
    "false",
  );
  expect(document.activeElement).toBe(button("Meeting follow-ups"));
});
test("failed enable exposes blocker and leaves Paused, not Draft", async () => {
  f.setMode("blocked enable");
  await render();
  await click("Enable Weekly investor update");
  expect(
    button("Enable Weekly investor update").getAttribute("aria-checked"),
  ).toBe("false");
  expect(row("investor").textContent).toContain(
    "Connect Notion before enabling.",
  );
  expect(row("investor").textContent).toContain("Paused");
  expect(row("investor").textContent).not.toContain("Draft");
});
test("uncertain mutation exposes Check result instead of another Delete; matching result resolves once", async () => {
  f.setMode("lost response");
  await render();
  await click("Delete Meeting follow-ups");
  await click("Delete");
  expect(button("Delete").disabled).toBe(true);
  expect(button("Refresh workflows").disabled).toBe(true);
  await click("Check result");
  expect(host.textContent).toContain("3 workflows");
  expect(f.stats().calls).toBe(1);
  expect(f.stats().checks).toBe(1);
});
test("all eight shell states and unmount/remount retain activation and removed identity", async () => {
  await render();
  await click("Delete Competitor watch");
  await click("Delete");
  await click("Enable Meeting follow-ups");
  for (const theme of ["light", "dark"] as const)
    for (const sidebar of ["expanded", "rail"] as const)
      for (const chatOpen of [false, true]) {
        shell = { ...shell, theme, sidebar, chatOpen };
        await render();
        expect(
          button("Enable Meeting follow-ups").getAttribute("aria-checked"),
        ).toBe("false");
        expect(button("Undo delete Competitor watch")).toBeTruthy();
      }
  await React.act(async () => root.render(<div />));
  await render();
  expect(button("Undo delete Competitor watch")).toBeTruthy();
  expect(f.stats().reads).toBe(1);
});
test("read failures and missing live capability do not invent a zero-count empty list", async () => {
  f.setMode("unavailable");
  await render();
  expect(host.textContent).toContain("could not be loaded");
  expect(host.textContent).not.toContain("0 workflows");
  expect(host.textContent).not.toContain("No workflows in this list");
});
test("no removed date, subtitle, footer, global creation control or irreversible route appears", async () => {
  await render();
  expect(host.textContent).not.toContain("Wednesday");
  expect(host.textContent).not.toContain("Paused workflows keep their history");
  expect(button("Create workflow")).toBeUndefined();
  const source = await Bun.file(import.meta.dir + "/controller.ts").text();
  expect(source).not.toContain("fetch(");
  expect(source).not.toContain("DELETE");
});

test("a late row acknowledgement does not steal focus from conversation input", async () => {
  f = makeManagementFixture("normal", 50);
  await React.act(async () => {
    root.render(<Room shell={shell} binding={binding()} />);
    await new Promise((r) => setTimeout(r, 90));
  });
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, 90));
  });
  await click("Delete Meeting follow-ups");
  const input = document.createElement("input");
  document.body.append(input);
  await React.act(async () => {
    button("Delete").click();
    input.focus();
    await new Promise((r) => setTimeout(r, 90));
  });
  expect(document.activeElement).toBe(input);
  expect(f.controller.getRow("meeting")!.removed).toBe(true);
  input.remove();
});
