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
import { makeGoalsFixture, GOALS_SCOPE, type GoalExample } from "./fixtures";
import type { GoalsBinding } from "./GoalsRoom";
let React: typeof import("react"),
  createRoot: typeof import("react-dom/client").createRoot,
  Room: typeof import("./GoalsRoom").GoalsRoom;
let host: HTMLDivElement,
  root: Root,
  f: ReturnType<typeof makeGoalsFixture>,
  shell: BriefShellPort;
const wait = () => new Promise((resolve) => setTimeout(resolve, 10));
let originalAnimate: typeof HTMLElement.prototype.animate;
let animated: HTMLElement[] = [];
beforeAll(async () => {
  GlobalRegistrator.register();
  originalAnimate = HTMLElement.prototype.animate;
  HTMLElement.prototype.animate = function () {
    animated.push(this);
    return { finished: Promise.resolve(), cancel() {} } as unknown as Animation;
  };
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ GoalsRoom: Room } = await import("./GoalsRoom"));
});
beforeEach(() => {
  animated = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  f = makeGoalsFixture();
  shell = {
    mode: "preview",
    theme: "light",
    sidebar: "expanded",
    chatOpen: false,
    setTheme: () => {},
    setSidebar: () => {},
    setChatOpen: () => {},
    route: { room: "goals", selection: {} },
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
afterAll(() => {
  HTMLElement.prototype.animate = originalAnimate;
  GlobalRegistrator.unregister();
});
const binding = (): GoalsBinding => ({
  source: "fixture",
  scopeId: GOALS_SCOPE,
  controller: f.controller,
});
async function render(b: GoalsBinding | undefined = binding()) {
  await React.act(async () => {
    root.render(<Room shell={shell} binding={b} />);
    await wait();
  });
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
  await render();
}
async function scenario(example: GoalExample) {
  f.controller.retire();
  f = makeGoalsFixture(example);
  await render();
}
test("approved path, shared segments, and absence of removed headings", async () => {
  await render();
  expect(host.querySelector("h1")?.textContent).toBe("Goals");
  expect(host.querySelectorAll(".brief-goal-stage")).toHaveLength(4);
  expect(
    host.querySelectorAll(
      '.brief-goal-stage[data-current="true"] .brief-outcome-segment',
    ),
  ).toHaveLength(10);
  expect(
    host.querySelector('.brief-goal-stage[data-current="true"] .brief-progress')
      ?.className,
  ).toContain("middle");
  for (const removed of [
    "Archive",
    "Wednesday",
    "Tell Jarvis",
    "Test workflow",
  ])
    expect(host.textContent).not.toContain(removed);
});
test("selection remains across all eight layouts and returns from completed", async () => {
  await render();
  await click("Sharpen the product story");
  for (const theme of ["light", "dark"] as const)
    for (const sidebar of ["expanded", "rail"] as const)
      for (const chatOpen of [false, true]) {
        shell = { ...shell, theme, sidebar, chatOpen };
        await render();
        expect(
          host.querySelector(".brief-goal-path")?.getAttribute("data-goal-id"),
        ).toBe("fixture-story");
      }
  await click("Completed · 2");
  expect(host.textContent).toContain("Get the first 4 pilots ready");
  await click("Active · 3");
  expect(
    host.querySelector(".brief-goal-path")?.getAttribute("data-goal-id"),
  ).toBe("fixture-story");
});
test("next action opens exactly the shared Today work and approval", async () => {
  await render();
  await click("Review follow-up");
  expect(shell.route).toEqual({
    room: "needs-you",
    selection: {
      workItemId: "fixture-work-follow-up",
      approvalId: "fixture-approval-alex",
    },
  });
});
test("score-only and unknown goals never invent measured counts", async () => {
  await scenario("score-only");
  const card = host.querySelector(".brief-goal-stage")!;
  expect(card.textContent).toContain("60%Score");
  expect(card.textContent).not.toContain("/ 10");
  expect(card.querySelector("details")).toBeNull();
  await scenario("unknown");
  expect(host.querySelector(".brief-goal-stage")!.textContent).toContain(
    "Not measured",
  );
  expect(host.querySelector(".brief-goal-stage .brief-progress")).toBeNull();
});
test("decreasing targets retain units, baseline, source and canonical progress", async () => {
  await scenario("decreasing");
  expect(host.querySelector(".brief-goal-stage")!.textContent).toContain(
    "400Target 100",
  );
  expect(host.textContent).toContain("milliseconds");
  expect(host.textContent).toContain("User reported");
  expect(host.textContent).toContain("1,000");
});
test("filter changes expose real paused and failed statuses without an archive", async () => {
  await render();
  for (const status of ["paused", "failed", "draft", "killed"] as const) {
    await React.act(async () => f.controller.setFilter(status));
    expect(
      host.querySelector(".brief-goal-path")?.getAttribute("data-goal-id"),
    ).toBe(`fixture-${status}`);
  }
});
test("refresh changes only the existing value nodes, without replacing unrelated stages", async () => {
  await render();
  const unchanged = host.querySelector(".brief-goal-stage")!;
  const main = host.querySelector('.brief-goal-stage[data-current="true"]')!;
  await React.act(async () => {
    f.update();
    await f.controller.refresh();
  });
  expect(host.querySelector(".brief-goal-stage")).toBe(unchanged);
  expect(host.querySelector('.brief-goal-stage[data-current="true"]')).toBe(
    main,
  );
  expect(main.textContent).toContain("7/ 10");
});
test("stale evidence leaves the path readable but blocks next-step navigation", async () => {
  await scenario("stale");
  expect(button("Review follow-up").disabled).toBe(true);
  expect(host.textContent).toContain("Connection interrupted");
  expect(host.querySelectorAll(".brief-goal-stage")).toHaveLength(4);
});
test("source, scope and capability mismatches fail closed", async () => {
  await render({ ...binding(), scopeId: "different" });
  expect(host.querySelector(".brief-goal-stage")).toBeNull();
  shell = { ...shell, mode: "live" };
  await render();
  expect(host.textContent).toContain("unavailable");
});
test("direct completed route selects the canonical goal and keeps long facts readable", async () => {
  shell = {
    ...shell,
    route: {
      room: "completed-goals",
      selection: { goalId: "fixture-onboarding" },
    },
  };
  await render();
  expect(
    host.querySelector('article[data-goal-id="fixture-onboarding"]')
      ?.textContent,
  ).toContain("Follow up after every call");
  expect(
    host.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
  ).toBe("Completed · 2");
});
test("completed visits remain settled and show real milestones", async () => {
  await render();
  for (let i = 0; i < 3; i++) {
    await click("Completed · 2");
    expect(host.querySelectorAll(".brief-goal-completed")).toHaveLength(2);
    expect(
      host.querySelectorAll('.brief-goal-milestones [data-complete="true"]'),
    ).toHaveLength(7);
    expect(
      animated.filter((node) => node.closest(".brief-goal-completed")),
    ).toHaveLength(0);
    await click("Active · 3");
  }
});
test("a value change animates only the changed glyph, never the entire goal path", async () => {
  await render();
  animated = [];
  await React.act(async () => {
    f.update();
    await f.controller.refresh();
  });
  expect(animated.length).toBe(1);
  expect(animated[0]?.hasAttribute("data-value-glyph")).toBe(true);
});
