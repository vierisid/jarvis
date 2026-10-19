import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type { WorkflowRunsBinding } from "./WorkflowRunsRoom";
import type { BriefShellPort } from "../../contracts";
import { makeRunsFixture, RUN_SCOPE, RUN_CAPABILITY } from "./fixtures";
let React: typeof import("react"),
  createRoot: typeof import("react-dom/client").createRoot;
let Room: typeof import("./WorkflowRunsRoom").WorkflowRunsRoom,
  available: typeof import("./WorkflowRunsRoom").runsAvailable;
let host: HTMLDivElement,
  root: Root,
  fixture: ReturnType<typeof makeRunsFixture>,
  shell: BriefShellPort;
beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ WorkflowRunsRoom: Room, runsAvailable: available } =
    await import("./WorkflowRunsRoom"));
});
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture = makeRunsFixture();
  shell = {
    mode: "preview",
    route: {
      room: "workflow-runs",
      selection: { flowId: RUN_SCOPE.flowId, versionId: RUN_SCOPE.versionId },
    },
    theme: "light",
    sidebar: "expanded",
    chatOpen: false,
    setTheme: () => {},
    setSidebar: () => {},
    setChatOpen: () => {},
    navigate: (route) => {
      shell = { ...shell, route };
    },
  };
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  fixture.controller.retire();
  host.remove();
});
afterAll(() => GlobalRegistrator.unregister());
const binding = (): WorkflowRunsBinding => ({
  ...RUN_SCOPE,
  source: "fixture" as const,
  title: "Meeting follow-ups",
  capabilities: RUN_CAPABILITY,
  controller: fixture.controller,
});
async function render(b = binding()) {
  await React.act(async () => root.render(<Room shell={shell} binding={b} />));
}
const button = (name: string) =>
  Array.from(host.querySelectorAll("button")).find(
    (b) =>
      (
        b.getAttribute("aria-label") ??
        b.querySelector(".brief-button__label")?.textContent ??
        b.textContent ??
        ""
      ).trim() === name,
  )!;
const text = () => host.textContent ?? "";
test("gate refuses missing capability, wrong owner/version and source without reads", async () => {
  for (const patch of [
    { capabilities: null },
    { scopeId: "other" },
    { versionId: "other" },
    { source: "live" as const },
  ])
    expect(available(shell, { ...binding(), ...patch })).toBe(false);
  await render({ ...binding(), capabilities: null });
  expect(fixture.stats().reads).toBe(0);
  expect(text()).toContain("unavailable");
});
test("one inline document follows selection through all shell combinations", async () => {
  await render();
  expect(host.querySelectorAll("article").length).toBe(1);
  expect(text()).toContain("Follow-up drafted. Nothing sent.");
  await React.act(async () => button("Open Run 006").click());
  await render();
  for (const theme of ["light", "dark"] as const)
    for (const sidebar of ["expanded", "rail"] as const)
      for (const chatOpen of [false, true]) {
        shell = { ...shell, theme, sidebar, chatOpen };
        await render();
        expect(
          host.querySelector("[data-run-id]")?.getAttribute("data-run-id"),
        ).toBe("meeting-run-006");
        expect(text()).toContain("confirmation was not received");
        expect(host.querySelectorAll("article").length).toBe(1);
        expect(host.querySelector('[role="dialog"]')).toBeNull();
      }
});
test("redacted fields do not leak and inspection treats arbitrary markup as text", async () => {
  fixture.records.get("meeting-run-012")!.steps[1]!.fields[0]!.value =
    '<img src=x onerror="window.privateValue=1">';
  await render();
  expect(text()).not.toContain("PRIVATE_CANARY");
  expect(text()).toContain("Redacted");
  expect(host.querySelector("img")).toBeNull();
  expect(text()).toContain("<img src=x");
  expect(text()).toContain("Email approval");
});
test("missing deep-linked run never falls back to latest", async () => {
  shell = {
    ...shell,
    route: {
      ...shell.route,
      selection: { ...shell.route.selection, runId: "missing-run" },
    },
  };
  await render();
  expect(fixture.controller.getSnapshot().selectedId).toBe("missing-run");
  expect(host.querySelector("[data-run-id]")).toBeNull();
  expect(text()).not.toContain("Follow-up drafted. Nothing sent.");
});
test("manual request navigates to its receipt and room return retains it", async () => {
  await render();
  await React.act(async () => {
    button("Run workflow").click();
    await new Promise((r) => setTimeout(r, 380));
  });
  await render();
  expect(shell.route.selection.runId).toBe("meeting-run-013");
  expect(host.querySelector("[data-run-id]")?.getAttribute("data-run-id")).toBe(
    "meeting-run-013",
  );
  await React.act(async () => root.render(null));
  await render();
  expect(host.querySelector("[data-run-id]")?.getAttribute("data-run-id")).toBe(
    "meeting-run-013",
  );
  expect(fixture.stats().requests).toBe(1);
});
test("slow command does not navigate a room after it unmounts", async () => {
  await render();
  await React.act(async () => button("Run workflow").click());
  await React.act(async () => root.render(null));
  await React.act(async () => new Promise((r) => setTimeout(r, 380)));
  expect(shell.route.selection.runId).toBeUndefined();
  expect(fixture.controller.getSnapshot().selectedId).toBe("meeting-run-013");
});
test("failure and empty history remain distinct", async () => {
  fixture.setMode("unavailable");
  await render();
  expect(text()).toContain("could not be loaded");
  expect(text()).not.toContain("No runs yet");
  fixture.setMode("empty");
  await React.act(async () => fixture.controller.refresh());
  expect(text()).toContain("No runs yet.");
});

test("queued history does not present creation time as a start time", async () => {
  await render();
  expect(button("Open Run 009").querySelector("time")?.textContent).toBe(
    "Not started",
  );
});
