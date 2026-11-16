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
test("failed enable exposes blocker and leaves Off, not Draft", async () => {
  f.setMode("blocked enable");
  await render();
  await click("Enable Weekly investor update");
  expect(
    button("Enable Weekly investor update").getAttribute("aria-checked"),
  ).toBe("false");
  expect(row("investor").textContent).toContain(
    "Connect Notion before enabling.",
  );
  expect(row("investor").textContent).toContain("Off");
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

test("R1: Refresh reveals an externally restored workflow and removes its obsolete Undo", async () => {
  await render();
  const original = structuredClone(f.records.get("inbox")!);
  await click("Delete Morning inbox brief");
  await click("Delete");
  expect(button("Undo delete Morning inbox brief")).toBeTruthy();
  f.records.set("inbox", { ...original, revision: "3", activation: "ENABLED" });
  f.tombstones.delete("inbox");
  await click("Refresh workflows");
  expect(
    row("inbox").closest("[data-removed]")!.getAttribute("data-removed"),
  ).toBe("false");
  expect(button("Undo delete Morning inbox brief")).toBeUndefined();
  expect(
    button("Enable Morning inbox brief").getAttribute("aria-checked"),
  ).toBe("true");
  expect(host.textContent).toContain("4 workflows");
  await click("Enable Morning inbox brief");
  expect(
    button("Enable Morning inbox brief").getAttribute("aria-checked"),
  ).toBe("false");
});

test("R2: Refresh cannot show an Enabled switch beside obsolete paused feedback", async () => {
  await render();
  await click("Enable Meeting follow-ups");
  expect(row("meeting").textContent).toContain("Workflow is off.");
  f.records.set("meeting", {
    ...f.records.get("meeting")!,
    revision: "3",
    activation: "ENABLED",
  });
  await click("Refresh workflows");
  expect(button("Enable Meeting follow-ups").getAttribute("aria-checked")).toBe(
    "true",
  );
  expect(row("meeting").textContent).not.toContain("Workflow is off.");
});
test("the list says before any switch that pausing stops queued and waiting runs (Q-06)", async () => {
  await render();
  expect(host.querySelector(".brief-management-hint")?.textContent).toBe(
    "Turning a workflow off stops its queued and waiting runs.",
  );
});
const field = (label: string) =>
  Array.from(
    host.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input,select"),
  ).find(
    (e) => host.querySelector(`label[for="${e.id}"]`)?.textContent === label,
  )!;
async function type(label: string, value: string) {
  const el = field(label) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await React.act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function pick(label: string, value: string) {
  const el = field(label) as HTMLSelectElement;
  await React.act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const rowNames = () =>
  Array.from(host.querySelectorAll(".brief-management-open")).map(
    (e) => e.textContent,
  );
test("search narrows by name, filter by state, and an empty match says so", async () => {
  await render();
  expect(rowNames().length).toBe(4);
  await type("Search workflows", "  INBOX ");
  expect(rowNames()).toEqual(["Morning inbox brief"]);
  expect(host.textContent).toContain("1 of 4 workflows");
  await type("Search workflows", "zzz");
  expect(rowNames()).toEqual([]);
  expect(host.textContent).toContain("No workflows match.");
  await click("Clear search and filter");
  expect(rowNames().length).toBe(4);
  await pick("Show", "off");
  const off = rowNames().length;
  await pick("Show", "on");
  expect(off + rowNames().length).toBe(4);
});
test("a long list draws one page and Show more adds the next", async () => {
  f.controller.retire();
  f = makeManagementFixture("long list");
  await render();
  expect(rowNames().length).toBe(50);
  expect(host.querySelectorAll("[data-flow]").length).toBe(50);
  expect(host.textContent).toContain("124 workflows");
  await type("Search workflows", "research 11");
  expect(rowNames().length).toBeLessThan(50);
  await type("Search workflows", "");
  await click("Show 50 more (74 left)");
  expect(rowNames().length).toBe(100);
  await click("Show 24 more (24 left)");
  expect(rowNames().length).toBe(124);
  expect(button("Show 24 more (24 left)")).toBeUndefined();
});
test("a row acted on under a filter stays drawn with its outcome until the filter changes", async () => {
  await render();
  await pick("Show", "on");
  await click("Enable Meeting follow-ups");
  expect(row("meeting")).toBeTruthy();
  expect(row("meeting").textContent).toContain(
    "queued and waiting runs were stopped",
  );
  expect(host.textContent).toContain("2 of 4 workflows");
  await pick("Show", "off");
  await pick("Show", "on");
  expect(row("meeting")).toBeNull();
});
test("search, filter and the page survive leaving the room, so the opened row is focused on return", async () => {
  f.controller.retire();
  f = makeManagementFixture("long list");
  await render();
  await type("Search workflows", "research");
  await click("Show 50 more (70 left)");
  const name = row("long-80").querySelector<HTMLElement>(
    ".brief-management-open",
  )!;
  await React.act(async () => name.click());
  expect(shell.route.room).toBe("workflow");
  await React.act(async () => root.render(<div />));
  await render();
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
  expect((field("Search workflows") as HTMLInputElement).value).toBe(
    "research",
  );
  expect(row("long-80")).toBeTruthy();
  expect(document.activeElement).toBe(
    row("long-80").querySelector(".brief-management-open"),
  );
});
test("search and filter stay reachable while they hide every row", async () => {
  await render();
  await click("Delete Meeting follow-ups");
  await click("Delete");
  await click("Delete Competitor watch");
  await click("Delete");
  await type("Search workflows", "investor");
  await click("Delete Weekly investor update");
  await click("Delete");
  expect(host.textContent).toContain("0 of 1 workflow");
  expect(host.textContent).toContain("No workflows match.");
  expect(field("Search workflows")).toBeTruthy();
  await click("Clear search and filter");
  expect(
    Array.from(
      host.querySelectorAll('[data-removed="false"] .brief-management-open'),
    ).map((e) => e.textContent),
  ).toEqual(["Morning inbox brief"]);
});
test("U2: an unpublished workflow says Off, then On after the switch, with no stale subtitle", async () => {
  await render();
  expect(
    button("Enable Weekly investor update").getAttribute("aria-checked"),
  ).toBe("false");
  expect(row("investor").textContent).not.toMatch(/Unpublished|Ready|Paused/);
  await click("Enable Weekly investor update");
  expect(
    button("Enable Weekly investor update").getAttribute("aria-checked"),
  ).toBe("true");
  expect(row("investor").textContent).not.toMatch(/Unpublished|Ready|Paused|Enabled/);
});
