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
import type { BriefShellPort } from "../contracts";
import {
  makeDecisionsFixture,
  DECISIONS_SCOPE,
  type DecisionExample,
} from "./fixtures";
import type { DecisionsBinding } from "./DecisionsRoom";
let React: typeof import("react"),
  createRoot: typeof import("react-dom/client").createRoot,
  Room: typeof import("./DecisionsRoom").DecisionsRoom;
let host: HTMLDivElement,
  root: Root,
  f: ReturnType<typeof makeDecisionsFixture>,
  shell: BriefShellPort;
const wait = () => new Promise((r) => setTimeout(r, 25));
beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ DecisionsRoom: Room } = await import("./DecisionsRoom"));
});
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  f = makeDecisionsFixture("ready", 0);
  shell = {
    mode: "preview",
    theme: "light",
    sidebar: "expanded",
    chatOpen: false,
    setTheme: () => {},
    setSidebar: () => {},
    setChatOpen: () => {},
    route: { room: "needs-you", selection: {} },
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
const binding = (): DecisionsBinding => ({
  source: "fixture",
  scopeId: DECISIONS_SCOPE,
  controller: f.controller,
});
async function render(b: DecisionsBinding | undefined = binding()) {
  await React.act(async () => root.render(<Room shell={shell} binding={b} />));
  await React.act(wait);
}
function button(name: string) {
  return [...host.querySelectorAll("button")].find(
    (b) =>
      (
        b.getAttribute("aria-label") ||
        b.querySelector(".brief-button__label")?.textContent ||
        b.textContent
      )?.trim() === name,
  )!;
}
async function click(name: string) {
  expect(button(name)).toBeTruthy();
  await React.act(async () => {
    button(name).focus();
    button(name).click();
    await wait();
  });
}
async function scenario(example: DecisionExample) {
  f.controller.retire();
  f = makeDecisionsFixture(example, 0);
  await render();
}
test("clean heading, same Today identity, only unresolved text highlighted", async () => {
  await render();
  expect(host.querySelector("h1")?.textContent).toBe("Needs you");
  expect(host.querySelector("article")?.dataset.decision).toBe(
    "fixture-decision-follow-up",
  );
  expect(host.querySelector("mark")?.textContent).toBe(
    "Does [pilot date] work for your team?",
  );
  expect(button("Approve & send")).toBeTruthy();
  expect(host.querySelector('[role="tablist"]')).toBeNull();
  expect(host.textContent).not.toContain("Wednesday");
});
test("selection survives every theme/sidebar/chat combination and routes by approval ID", async () => {
  await render();
  await click("Pilot invitation");
  expect(shell.route.selection.approvalId).toBe("fixture-approval-maya");
  for (const theme of ["light", "dark"] as const)
    for (const sidebar of ["expanded", "rail"] as const)
      for (const chatOpen of [false, true]) {
        shell = { ...shell, theme, sidebar, chatOpen };
        await render();
        expect(host.querySelector("article")?.dataset.decision).toBe(
          "fixture-decision-invitation",
        );
        expect(button("Pilot invitation").getAttribute("aria-pressed")).toBe(
          "true",
        );
      }
});
test("direct Today review alias opens the matching document", async () => {
  shell.route.selection = { approvalId: "fixture-approval-maya" };
  await render();
  expect(host.querySelector("h2")?.textContent).toBe("Pilot invitation");
});
test("editing keeps the document/actions mounted and blocks selection/approval", async () => {
  await render();
  const paper = host.querySelector("article"),
    actions = host.querySelector(".brief-decision-actions");
  await click("Edit draft");
  expect(host.querySelector("article")).toBe(paper);
  expect(host.querySelector(".brief-decision-actions")).toBe(actions);
  expect(host.querySelector('textarea[aria-label="Message"]')).toBeTruthy();
  expect(button("Pilot invitation").disabled).toBe(true);
  expect(button("Keep draft").disabled).toBe(true);
  await click("Cancel edit");
  expect(host.querySelectorAll("textarea").length).toBe(0);
  expect(f.calls.length).toBe(0);
});
test("unsupported edits stay disabled with a visible reason", async () => {
  await scenario("read-only");
  expect(button("Edit draft").disabled).toBe(true);
  expect(button("Approve & send").disabled).toBe(true);
  expect(host.textContent).toContain("cannot be edited");
});
test("uncertainty retains the selected document until read-only recovery", async () => {
  await scenario("uncertain");
  await click("Approve & send");
  expect(host.querySelector("article")?.dataset.decision).toBe(
    "fixture-decision-follow-up",
  );
  expect(button("Approve & send").disabled).toBe(true);
  expect(host.textContent).toContain("not confirmed");
  await click("Check result");
  expect(host.querySelector("article")?.dataset.decision).toBe(
    "fixture-decision-invitation",
  );
  expect(f.calls.length).toBe(1);
});
test("calendar preview includes readonly options, not raw tool arguments", async () => {
  await scenario("calendar");
  expect(host.textContent).toContain("All attendees");
  await click("Edit draft");
  expect(host.querySelector('textarea[aria-label="Starts"]')).toBeTruthy();
  expect(host.textContent).toContain("All attendees");
  expect(host.textContent).not.toContain("auth");
});
test("missing live capability, fixture/live mismatch and wrong scope fail closed", async () => {
  await render({ ...binding(), scopeId: "other" });
  expect(host.textContent).toContain("unavailable");
  expect(host.querySelector("article")).toBeNull();
  shell.mode = "live";
  await render();
  expect(host.querySelector("article")).toBeNull();
  expect(f.calls.length).toBe(0);
});
test("ten decisions are real buttons, not truncated previews", async () => {
  await scenario("many");
  expect(host.querySelectorAll(".brief-decision-choice").length).toBe(10);
  await click("Follow-up 10");
  expect(button("Follow-up 10").getAttribute("aria-pressed")).toBe("true");
});
test("empty is not confused with unavailable", async () => {
  await scenario("empty");
  expect(host.textContent).toContain("Nothing needs your review");
  await scenario("unavailable");
  expect(host.textContent).toContain("Decisions are unavailable");
  expect(host.textContent).not.toContain("Nothing needs your review");
});

test("keep draft advancement updates the return route instead of reopening the deferred item", async () => {
  await render();
  await click("Pilot invitation");
  await render();
  await click("Keep draft");
  expect(host.querySelector("article")?.dataset.decision).toBe(
    "fixture-decision-follow-up",
  );
  expect(shell.route.selection.approvalId).toBe("fixture-approval-alex");
  await React.act(async () => root.render(null));
  await render();
  expect(host.querySelector("article")?.dataset.decision).toBe(
    "fixture-decision-follow-up",
  );
});
test("room return restores document and selector reading positions from its retained owner", async () => {
  await scenario("long");
  f.controller.scrollTop = 120;
  f.controller.listScrollLeft = 24;
  await React.act(async () => root.render(null));
  await render();
  expect(host.querySelector("article")!.scrollTop).toBe(120);
  expect(host.querySelector("nav")!.scrollLeft).toBe(24);
});

test("R1: a settled save removes Check result before the next edit", async () => {
  await render();
  await click("Edit draft");
  await click("Save draft");
  expect(button("Check result")).toBeUndefined();
  await click("Edit draft");
  expect(button("Check result")).toBeUndefined();
  expect(button("Save draft").disabled).toBe(false);
  expect(button("Cancel edit").disabled).toBe(false);
});

test("R2: a remotely removed second edit keeps its text and Cancel reachable through chat reflow", async () => {
  await render();
  await click("Edit draft");
  await click("Save draft");
  await click("Edit draft");
  await React.act(async () => {
    const input = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message"]',
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, "Keep this unsaved writing");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(f.controller.snapshot().draft!.document).toMatchObject({
    body: "Keep this unsaved writing",
  });
  f.port.read = async () => ({ status: "ready", data: f.rows().slice(1) });
  await click("Refresh decisions");
  for (const chatOpen of [true, false]) {
    shell = { ...shell, chatOpen };
    await render();
    expect(
      host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')
        ?.value,
    ).toBe("Keep this unsaved writing");
    expect(button("Cancel edit").disabled).toBe(false);
    expect(button("Save draft").disabled).toBe(true);
  }
  await click("Cancel edit");
  expect(host.querySelector("article")?.dataset.decision).toBe(
    "fixture-decision-invitation",
  );
  expect(button("Approve & send").disabled).toBe(false);
});
