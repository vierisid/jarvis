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
import type { WorkflowContextBinding } from "./WorkflowContextRoom";
import { makeContextFixture } from "./fixtures";
import { RUN_CAPABILITY, RUN_SCOPE } from "../runs/fixtures";
let React: typeof import("react"),
  createRoot: typeof import("react-dom/client").createRoot;
let Room: typeof import("./WorkflowContextRoom").WorkflowContextRoom,
  available: typeof import("./WorkflowContextRoom").contextAvailable;
let host: HTMLDivElement,
  root: Root,
  f: ReturnType<typeof makeContextFixture>,
  shell: BriefShellPort;
beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ WorkflowContextRoom: Room, contextAvailable: available } =
    await import("./WorkflowContextRoom"));
});
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  f = makeContextFixture();
  shell = {
    mode: "preview",
    theme: "light",
    sidebar: "expanded",
    chatOpen: false,
    setTheme: () => {},
    setSidebar: () => {},
    setChatOpen: () => {},
    route: {
      room: "workflow-context",
      selection: {
        flowId: RUN_SCOPE.flowId,
        versionId: RUN_SCOPE.versionId,
        runId: "meeting-run-001",
      },
    },
    navigate: (route) => {
      shell = { ...shell, route };
    },
  };
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  f.controller.retire();
  f.runs.controller.retire();
  host.remove();
});
afterAll(() => GlobalRegistrator.unregister());
const binding = (): WorkflowContextBinding => ({
  ...RUN_SCOPE,
  source: "fixture",
  title: "Meeting follow-ups",
  capabilities: RUN_CAPABILITY,
  controller: f.controller,
  runs: f.runs.controller,
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
async function basis(value: string) {
  await React.act(async () =>
    host.querySelector<HTMLInputElement>(`input[value="${value}"]`)!.click(),
  );
}
test("gates reject unsupported/source/scope/flow/version mismatches before any read", async () => {
  for (const patch of [
    { capabilities: null },
    { scopeId: "wrong" },
    { flowId: "wrong" },
    { versionId: "wrong" },
    { source: "live" as const },
  ])
    expect(available(shell, { ...binding(), ...patch })).toBe(false);
  await render({ ...binding(), capabilities: null });
  expect(f.stats().reads).toBe(0);
  expect(text()).toContain("unavailable");
});
test("configured and used-by-run views show their own goal and exact version", async () => {
  await render();
  expect(text()).toContain("Win 10 design partners");
  expect(text()).not.toContain("Start three pilots");
  await basis("recorded");
  expect(text()).toContain("Start three pilots");
  expect(text()).not.toContain("Win 10 design partners");
  expect(
    host
      .querySelector("[data-context-version]")
      ?.getAttribute("data-context-version"),
  ).toBe("meeting-v2");
  expect(text()).toContain("Source removed");
  await basis("configured");
  expect(text()).toContain("Win 10 design partners");
});
test("all eight shell states and remount preserve mode and recorded identity", async () => {
  await render();
  await basis("recorded");
  for (const theme of ["light", "dark"] as const)
    for (const sidebar of ["expanded", "rail"] as const)
      for (const chatOpen of [false, true]) {
        shell = { ...shell, theme, sidebar, chatOpen };
        await render();
        expect(
          host
            .querySelector("[data-context-run]")
            ?.getAttribute("data-context-run"),
        ).toBe("meeting-run-001");
      }
  await React.act(async () => root.render(null));
  await render();
  expect(
    host.querySelector<HTMLInputElement>('input[value="recorded"]')!.checked,
  ).toBe(true);
  expect(text()).toContain("Start three pilots");
});
test("source actions carry exact IDs; missing/removed sources have no false target", async () => {
  const opened: unknown[] = [];
  const b = {
    ...binding(),
    openSource: (source: unknown) => opened.push(source),
  };
  await render(b);
  await React.act(async () => button("Open goal goal-design-partners").click());
  expect(opened).toEqual([{ kind: "goal", id: "goal-design-partners" }]);
  f.setMode("missing");
  await React.act(async () => f.controller.refresh({ basis: "configured" }));
  expect(button("Open goal goal-design-partners")).toBeUndefined();
  expect(button("Open fact fact-email-preferences")).toBeUndefined();
  expect(button("Open connection connection-gmail")).toBeDefined();
  expect(text()).toContain("Needs checking");
});
test("no selected run disables the recorded choice without inventing usage", async () => {
  shell.route = {
    room: "workflow-context",
    selection: { flowId: RUN_SCOPE.flowId },
  };
  await render();
  expect(
    host.querySelector<HTMLInputElement>('input[value="recorded"]')!.disabled,
  ).toBe(true);
  expect(text()).not.toContain("None recorded");
});
test("partial context does not replace unknown usage with configured facts", async () => {
  f.setMode("partial");
  await render();
  await basis("recorded");
  expect(text()).toContain("Recorded usage is unavailable");
  expect(text()).not.toContain("Your tone, sign-off");
  expect(text()).toContain("This group may be out of date");
});
test("unavailable, unsupported and empty have distinct UI", async () => {
  for (const [mode, message] of [
    ["unavailable", "Context could not be loaded"],
    ["unsupported", "not supported"],
    ["empty", "No context is configured"],
  ] as const) {
    f.setMode(mode);
    await React.act(async () => f.controller.refresh({ basis: "configured" }));
    await render();
    expect(text()).toContain(message);
  }
});
test("long arbitrary text renders as text; explicit redaction hides all marked fields", async () => {
  const original = f.port.read;
  f.port.read = async (...args) => {
    const r = await original(...args);
    if (r.status === "ready")
      r.data.groups.memory = {
        status: "ready",
        data: [
          {
            id: "safe",
            label: "<b>source</b>",
            value: "<img src=x onerror=secret()>".repeat(40),
            availability: "available",
            source: null,
          },
          {
            id: "hidden",
            label: "PRIVATE",
            value: "PRIVATE",
            availability: "redacted",
            source: { kind: "fact", id: "PRIVATE" },
          },
        ],
      };
    return r;
  };
  await render();
  expect(text()).toContain("<img src=x");
  expect(text()).not.toContain("PRIVATE");
  expect(host.querySelector("img")).toBeNull();
  expect(text()).toContain("Redacted");
});
test("header destinations retain flow/version/run and no removed chrome returns", async () => {
  await render();
  await React.act(async () => button("Canvas").click());
  expect(shell.route).toEqual({
    room: "workflow",
    selection: {
      flowId: RUN_SCOPE.flowId,
      versionId: RUN_SCOPE.versionId,
      runId: "meeting-run-001",
    },
  });
  expect(text()).not.toContain("Wednesday");
  expect(host.querySelector("footer")).toBeNull();
});
test("Run shares the Runs owner and selects its receipt; uncertainty stays locked", async () => {
  await render();
  await React.act(async () => {
    button("Run workflow").click();
    await new Promise((r) => setTimeout(r, 380));
  });
  expect(shell.route.room).toBe("workflow-runs");
  expect(shell.route.selection.runId).toBe("meeting-run-013");
  f.runs.setMode("uncertain-command");
  await render();
  await React.act(async () => {
    button("Run workflow").click();
    await new Promise((r) => setTimeout(r, 380));
  });
  expect(button("Run workflow").disabled).toBe(true);
  expect(text()).toContain("could not be confirmed");
  await React.act(async () => root.render(null));
  await render();
  expect(button("Run workflow").disabled).toBe(true);
});
test("a wrong-scope command owner is disabled", async () => {
  const other = makeContextFixture();
  Object.assign(other.runs.controller.scope, { scopeId: "other" });
  await render({ ...binding(), runs: other.runs.controller });
  expect(button("Run workflow").disabled).toBe(true);
  other.controller.retire();
  other.runs.controller.retire();
});

test("returning from another room refreshes configured context without losing the chosen basis", async () => {
  await render();
  expect(text()).not.toContain("Missing source");
  await React.act(async () => root.render(null));
  f.setMode("missing");
  await render();
  expect(text()).toContain("Missing source");
  expect(
    host.querySelector<HTMLInputElement>('input[value="configured"]')!.checked,
  ).toBe(true);
});
test("changed source and permission links preserve their separate source identities", async () => {
  const opened: unknown[] = [];
  await render({ ...binding(), openSource: (source) => opened.push(source) });
  await React.act(async () => button("Open workflow meeting").click());
  await React.act(async () => button("Open step step-draft").click());
  expect(opened).toEqual([
    { kind: "workflow", id: "meeting" },
    { kind: "step", id: "step-draft" },
  ]);
});
test("late run acknowledgement cannot navigate a replaced command owner", async () => {
  let resolve!: () => void;
  const original = f.runs.port.start!;
  f.runs.port.start = async (request) => {
    const accepted = await original(request);
    return new Promise((r) => {
      resolve = () => r(accepted);
    });
  };
  await render();
  await React.act(async () => {
    button("Run workflow").click();
    await new Promise((r) => setTimeout(r, 380));
  });
  const replacement = makeContextFixture();
  await render({ ...binding(), runs: replacement.runs.controller });
  await React.act(async () => {
    resolve();
    await Promise.resolve();
  });
  expect(shell.route.room).toBe("workflow-context");
  replacement.controller.retire();
  replacement.runs.controller.retire();
});
