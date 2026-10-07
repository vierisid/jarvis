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
import { OpportunitiesController } from "./controller";
import type { OpportunitiesBinding } from "./OpportunitiesRoom";
import {
  makeOpportunitiesFixture,
  OPPORTUNITIES_SCOPE,
  type OpportunityExample,
} from "./fixtures";
let React: typeof import("react"),
  createRoot: typeof import("react-dom/client").createRoot;
let Room: typeof import("./OpportunitiesRoom").OpportunitiesRoom;
let host: HTMLDivElement,
  root: Root,
  f: ReturnType<typeof makeOpportunitiesFixture>,
  shell: BriefShellPort;
beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ OpportunitiesRoom: Room } = await import("./OpportunitiesRoom"));
});
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  f = makeOpportunitiesFixture();
  shell = {
    mode: "preview",
    theme: "light",
    sidebar: "expanded",
    chatOpen: false,
    setTheme: () => {},
    setSidebar: () => {},
    setChatOpen: () => {},
    route: { room: "opportunities", selection: {} },
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
const wait = () => new Promise((r) => setTimeout(r, 20));
const binding = (): OpportunitiesBinding => ({
  source: "fixture",
  scopeId: OPPORTUNITIES_SCOPE,
  controller: f.controller,
});
async function render(b: OpportunitiesBinding | undefined = binding()) {
  await React.act(async () => root.render(<Room shell={shell} binding={b} />));
  await React.act(wait);
}
const button = (label: string) =>
  Array.from(host.querySelectorAll("button")).find(
    (b) =>
      (
        b.getAttribute("aria-label") ??
        b.querySelector(".brief-button__label")?.textContent ??
        b.textContent
      )?.trim() === label,
  )!;
async function click(label: string) {
  expect(button(label)).toBeTruthy();
  await React.act(async () => {
    button(label).focus();
    button(label).click();
    await wait();
  });
}
async function scenario(example: OpportunityExample) {
  f.controller.retire();
  f = makeOpportunitiesFixture(example);
  await render();
}
test("wrong source, wrong scope and missing live capability fail closed without reads", async () => {
  await render({ ...binding(), scopeId: "other" });
  expect(f.stats().reads).toBe(0);
  expect(host.textContent).toContain("unavailable");
  shell = { ...shell, mode: "live" };
  await render();
  expect(f.stats().reads).toBe(0);
});
test("list and detail retain exact selected identity through shell changes and refresh", async () => {
  await render();
  await click("Weekly investor update");
  expect(host.querySelector("article")?.getAttribute("data-proposal")).toBe(
    "fixture-proposal-1",
  );
  expect(shell.route.selection.opportunityId).toBe("fixture-proposal-1");
  shell = { ...shell, sidebar: "rail", chatOpen: true, theme: "dark" };
  await render();
  expect(button("Weekly investor update").getAttribute("aria-pressed")).toBe(
    "true",
  );
  f.reorder();
  await click("Refresh opportunities");
  expect(host.querySelector("article")?.getAttribute("data-proposal")).toBe(
    "fixture-proposal-1",
  );
});
test("a routed proposal selects its real identity once available", async () => {
  shell.route = {
    room: "opportunities",
    selection: { opportunityId: "fixture-proposal-1" },
  };
  await render();
  expect(host.querySelector("article")?.getAttribute("data-proposal")).toBe(
    "fixture-proposal-1",
  );
});
test("finished output stays qualified and legacy chrome remains absent", async () => {
  await render();
  expect(host.textContent).toContain("Illustrative output preview");
  expect(host.textContent).toContain("Better answers");
  for (const text of [
    "For You",
    "Saved",
    "Authority Rules Apply",
    "Create workflow",
    "Wednesday",
  ])
    expect(host.textContent).not.toContain(text);
  expect(host.querySelectorAll('[role="tab"]')).toHaveLength(0);
});
test("approval resolves locally, does not navigate, and advances focus to the next choice", async () => {
  await render();
  await click("Approve & enable");
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, 950));
  });
  expect(f.calls.length).toBe(1);
  expect(shell.route.room).toBe("opportunities");
  expect(host.querySelector("article")?.getAttribute("data-proposal")).toBe(
    "fixture-proposal-1",
  );
  expect(document.activeElement).toBe(button("Weekly investor update"));
});
test("late acknowledgement does not steal focus from the composer", async () => {
  f.controller.retire();
  f = makeOpportunitiesFixture("ready", 40);
  await render();
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  await React.act(async () => {
    button("Approve & enable").click();
  });
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, 950));
  });
  expect(document.activeElement).toBe(input);
  input.remove();
});
test.each(["registration pending", "registration blocked"] as const)(
  "%s keeps the proposal visible and distinguishes saved from enabled",
  async (example) => {
    await scenario(example);
    await click("Approve & enable");
    expect(host.querySelector(".brief-finished-status")?.textContent).toContain(
      "Approval saved",
    );
    expect(host.querySelector("article")?.getAttribute("data-proposal")).toBe(
      "fixture-proposal-0",
    );
    expect(button("Approve & enable").disabled).toBe(true);
    expect(button("Check result")).toBeTruthy();
  },
);
test("unknown acknowledgement shows recovery and cannot duplicate the approval", async () => {
  await scenario("lost response");
  await click("Approve & enable");
  expect(host.textContent).toContain("not confirmed");
  expect(button("Dismiss").disabled).toBe(true);
  await click("Check result");
  await React.act(wait);
  expect(f.calls.length).toBe(1);
  expect(f.stats().recoveries).toBe(1);
});
test.each(["preparing", "blocked", "stale"] as const)(
  "%s cannot visually or behaviorally promote a proposal to ready",
  async (example) => {
    await scenario(example);
    expect(button("Approve & enable").disabled).toBe(true);
    expect(
      host.querySelector(".brief-finished-status")?.textContent,
    ).not.toContain("Ready to enable");
    expect(f.calls.length).toBe(0);
  },
);
test("missing preview has an explicit unavailable state, no invented output", async () => {
  await scenario("missing preview");
  expect(host.textContent).toContain("A preview is not available");
  expect(host.textContent).not.toContain("Angles for your pilot pitch");
});
test("definitive refusal explains refresh without pretending the result is pending", async () => {
  await scenario("refused");
  await click("Approve & enable");
  expect(host.querySelector(".brief-finished-status")?.textContent).toContain(
    "Decision not saved",
  );
  expect(host.textContent).toContain("Refresh before deciding again");
  expect(button("Check result")).toBeUndefined();
  await click("Refresh opportunities");
  expect(button("Approve & enable").disabled).toBe(false);
});
test("room unmount/remount preserves pending decisions and selection in the owner", async () => {
  await scenario("registration pending");
  await click("Approve & enable");
  await React.act(async () => root.render(<div>Another room</div>));
  await render();
  expect(host.querySelector(".brief-finished-status")?.textContent).toContain(
    "Approval saved",
  );
  expect(button("Approve & enable").disabled).toBe(true);
});
test("R2: selector and brief retain independent positions on return; another proposal starts at its heading", async () => {
  await scenario("many proposals");
  await click("Prepared opportunity 10");
  const list = () =>
    host.querySelector<HTMLElement>(".brief-opportunity-list")!;
  const detail = () => host.querySelector<HTMLElement>(".brief-finished")!;
  list().scrollTop = 500;
  list().scrollLeft = 300;
  list().dispatchEvent(new Event("scroll"));
  detail().scrollTop = 180;
  detail().dispatchEvent(new Event("scroll"));
  await React.act(async () => root.render(<div>Another room</div>));
  shell = { ...shell, sidebar: "rail", chatOpen: true, theme: "dark" };
  await render();
  expect(detail().getAttribute("data-proposal")).toBe("fixture-proposal-9");
  expect(list().scrollTop).toBe(500);
  expect(list().scrollLeft).toBe(300);
  expect(detail().scrollTop).toBe(180);
  await click("Competitor watch");
  expect(detail().scrollTop).toBe(0);
  expect(f.controller.scrollTop).toBe(0);
  expect(list().scrollTop).toBe(500);
});

test("activation capability changes immediately update rendered controls", async () => {
  const c = new OpportunitiesController("live", OPPORTUNITIES_SCOPE, f.port);
  shell = { ...shell, mode: "live" };
  const ready = {
    supported: true,
    ready: true,
    enabled: true,
    state: "ready",
    reason: null,
  };
  const b = (enabled: boolean): OpportunitiesBinding => ({
    source: "live",
    scopeId: OPPORTUNITIES_SCOPE,
    controller: c,
    capabilities: {
      contractVersion: 1,
      capabilities: {
        preparedOpportunities: ready,
        opportunityActivation: { ...ready, enabled },
      },
    },
  });
  try {
    await render(b(true));
    expect(button("Approve & enable").disabled).toBe(false);
    await render(b(false));
    expect(button("Approve & enable").disabled).toBe(true);
    await render(b(true));
    expect(button("Approve & enable").disabled).toBe(false);
  } finally {
    c.retire();
  }
});
