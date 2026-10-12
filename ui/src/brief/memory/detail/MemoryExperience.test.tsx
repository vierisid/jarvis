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
import { makeMemoryDetailFixture, DETAIL_SCOPE } from "./fixtures";
import type { MemoryExperienceBinding } from "./MemoryExperience";
let React: typeof import("react"),
  createRoot: typeof import("react-dom/client").createRoot;
let Experience: typeof import("./MemoryExperience").MemoryExperience,
  nearest: typeof import("./MemoryExperience").nearestReturnId;
let host: HTMLDivElement,
  root: Root,
  fixture: ReturnType<typeof makeMemoryDetailFixture>;
const wait = () => new Promise((resolve) => setTimeout(resolve, 15));
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ MemoryExperience: Experience, nearestReturnId: nearest } =
    await import("./MemoryExperience"));
});
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture = makeMemoryDetailFixture();
});
afterEach(async () => {
  await React.act(async () => {
    root.unmount();
    fixture.controller.retire();
    fixture.stream.retire();
  });
  host.remove();
});
afterAll(() => GlobalRegistrator.unregister());
const binding = (): MemoryExperienceBinding => ({
  detail: fixture.controller,
  stream: {
    source: "fixture",
    scopeId: DETAIL_SCOPE,
    controller: fixture.stream,
  },
});
function Harness({
  bind = binding(),
  route = { room: "memory", selection: {} } as BriefShellPort["route"],
  theme = "light",
  sidebar = "expanded",
  chatOpen = false,
  mode = "preview",
}: {
  bind?: MemoryExperienceBinding;
  route?: BriefShellPort["route"];
  theme?: "light" | "dark";
  sidebar?: "expanded" | "rail";
  chatOpen?: boolean;
  mode?: "live" | "preview";
}) {
  const [current, navigate] = React.useState(route);
  const shell: BriefShellPort = {
    mode,
    route: current,
    navigate,
    theme,
    sidebar,
    chatOpen,
    setTheme() {},
    setSidebar() {},
    setChatOpen() {},
  };
  return (
    <div className="brief-root brief-workspace-content">
      <Experience shell={shell} binding={bind} />
    </div>
  );
}
async function render(props: Parameters<typeof Harness>[0] = {}) {
  await React.act(async () => {
    root.render(<Harness {...props} />);
    await wait();
  });
}
function button(label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) =>
      !node.closest("[hidden]") &&
      (
        node.querySelector(".brief-button__label")?.textContent ??
        node.textContent
      )?.trim() === label,
  );
  if (!result) throw new Error(`Missing ${label}: ${host.textContent}`);
  return result;
}
async function click(label: string) {
  await React.act(async () => {
    button(label).click();
    await wait();
  });
}
async function open(id = "fixture-memory-0") {
  await React.act(async () => {
    host
      .querySelector<HTMLButtonElement>(
        `.brief-memory-row[data-fact-id="${id}"]`,
      )!
      .click();
    await wait();
  });
}
async function fill(label: string, value: string) {
  const field = [...host.querySelectorAll("label")].find(
    (node) => node.textContent === label,
  )!;
  const editor = document.getElementById(field.htmlFor) as HTMLTextAreaElement;
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(editor, value);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await React.act(async () => {
    host
      .querySelector('form[aria-label="Correct memory"]')!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await wait();
  });
}
test("sentence transfer is cancelled when returning during motion", async () => {
  const originalAnimate = HTMLElement.prototype.animate;
  const originalMedia = window.matchMedia;
  let calls = 0,
    cancelled = 0;
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as any;
  HTMLElement.prototype.animate = (() => {
    calls++;
    return {
      finished: new Promise(() => {}),
      cancel() {
        cancelled++;
      },
    } as unknown as Animation;
  }) as typeof HTMLElement.prototype.animate;
  try {
    await render();
    await open();
    expect(calls).toBe(1);
    await click("All memories");
    expect(cancelled).toBe(1);
    expect(document.activeElement?.getAttribute("data-fact-id")).toBe(
      "fixture-memory-0",
    );
  } finally {
    HTMLElement.prototype.animate = originalAnimate;
    window.matchMedia = originalMedia;
  }
});
test("reduced motion skips sentence transfer while preserving detail focus and return", async () => {
  const originalAnimate = HTMLElement.prototype.animate;
  const originalMedia = window.matchMedia;
  let calls = 0;
  window.matchMedia = (() => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  })) as any;
  HTMLElement.prototype.animate = (() => {
    calls++;
    throw new Error("Motion should be skipped");
  }) as typeof HTMLElement.prototype.animate;
  try {
    await render();
    await open();
    expect(calls).toBe(0);
    expect(document.activeElement?.id).toBe("brief-memory-detail-title");
    await click("All memories");
    expect(document.activeElement?.getAttribute("data-fact-id")).toBe(
      "fixture-memory-0",
    );
  } finally {
    HTMLElement.prototype.animate = originalAnimate;
    window.matchMedia = originalMedia;
  }
});
test("direct canonical detail route loads, focuses its title and keeps source/use/history subordinate", async () => {
  await render({
    route: { room: "memory-detail", selection: { factId: "fixture-memory-0" } },
  });
  expect(
    host.querySelector(".brief-memory-detail-sentence")?.textContent,
  ).toContain("Keep emails short");
  expect(document.activeElement?.id).toBe("brief-memory-detail-title");
  expect(
    [...host.querySelectorAll(".brief-memory-detail-context h3")].map(
      (x) => x.textContent,
    ),
  ).toEqual(["Where it came from", "Where it helps", "History"]);
});
test("cancel returns to the same filtered row with focus and a brief identification", async () => {
  await render();
  await React.act(async () => {
    fixture.stream.setFilters({ source: "Conversation", search: "emails" }, 0);
    await wait();
  });
  await open();
  await click("Edit memory");
  await fill("Correct value", "Discarded draft");
  await fill("Reason or source", "Draft source");
  await click("Cancel");
  expect(fixture.writes()).toBe(0);
  expect(document.activeElement).toBe(button("Edit memory"));
  await click("All memories");
  await React.act(wait);
  expect(document.activeElement?.getAttribute("data-fact-id")).toBe(
    "fixture-memory-0",
  );
  expect(document.activeElement?.getAttribute("data-returned")).toBe("true");
  expect(fixture.stream.snapshot().filters.search).toBe("emails");
  expect(fixture.stream.snapshot().filters.source).toBe("Conversation");
});
test("saved correction renders fresh replacement and returns to its row without losing the query", async () => {
  await render();
  await React.act(async () => {
    fixture.stream.setFilters({ search: "emails" }, 0);
    await wait();
  });
  await open();
  await click("Edit memory");
  await fill("Correct value", "Keep emails concise.");
  await fill("Reason or source", "Owner correction");
  await submit();
  const id = fixture.controller.snapshot().factId!;
  expect(id).not.toBe("fixture-memory-0");
  expect(host.querySelector(".brief-memory-detail-sentence")?.textContent).toBe(
    "Keep emails concise.",
  );
  await click("All memories");
  await React.act(wait);
  expect(document.activeElement?.getAttribute("data-fact-id")).toBe(id);
  expect(fixture.stream.snapshot().filters.search).toBe("emails");
});
test("Forget is a local confirmation, cancel is harmless, and deletion returns to nearest filtered neighbor", async () => {
  await render();
  await React.act(async () => {
    fixture.stream.setFilters({ source: "Conversation" }, 0);
    await wait();
  });
  await open();
  await click("Forget");
  expect(host.textContent).toContain(
    "Original messages, source documents and backups remain.",
  );
  expect(fixture.writes()).toBe(0);
  expect(document.activeElement?.className).toBe("brief-memory-detail-panel");
  await click("Cancel");
  expect(fixture.facts.has("fixture-memory-0")).toBe(true);
  await click("Forget");
  await click("Forget this memory");
  expect(host.querySelector(".brief-memory-detail")?.textContent).not.toContain(
    "Keep emails short",
  );
  await click("All memories");
  await React.act(wait);
  expect(document.activeElement?.getAttribute("data-fact-id")).toBe(
    "fixture-memory-2",
  );
  expect(fixture.stream.snapshot().filters.source).toBe("Conversation");
});
test("conflicts preserve text in the editor and disable submission until reload", async () => {
  fixture.controller.retire();
  fixture.stream.retire();
  fixture = makeMemoryDetailFixture("conflict");
  await render();
  await open();
  await click("Edit memory");
  await fill("Correct value", "My corrected value");
  await fill("Reason or source", "Checked");
  await submit();
  expect(host.textContent).toContain("This fact changed");
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
    "My corrected value",
  );
  expect(button("Save confirmed value").disabled).toBe(true);
  await click("Reload current fact");
  expect(fixture.writes()).toBe(1);
});
test("all eight layout combinations keep an in-progress correction draft", async () => {
  await render();
  await open();
  await click("Edit memory");
  await fill("Correct value", "Unsubmitted input");
  for (const theme of ["light", "dark"] as const)
    for (const sidebar of ["expanded", "rail"] as const)
      for (const chatOpen of [false, true]) {
        await render({ theme, sidebar, chatOpen });
        expect(
          (host.querySelector("textarea") as HTMLTextAreaElement).value,
        ).toBe("Unsubmitted input");
      }
  expect(fixture.writes()).toBe(0);
});
test("fixture data cannot cross into a live shell", async () => {
  await render({
    mode: "live",
    route: { room: "memory-detail", selection: { factId: "fixture-memory-0" } },
  });
  expect(host.textContent).not.toContain("Keep emails short");
  expect(host.textContent).toContain("unavailable");
});
test("disabled per-fact writers stay disabled in the detail UI", async () => {
  fixture.controller.retire();
  fixture.stream.retire();
  fixture = makeMemoryDetailFixture("read-only");
  await render();
  await open();
  expect(button("Edit memory").disabled).toBe(true);
  expect(button("Forget").disabled).toBe(true);
  expect(fixture.writes()).toBe(0);
});
test("scope replacement cannot display the old fact or old editor", async () => {
  await render();
  await open();
  await click("Edit memory");
  await fill("Correct value", "Old scope draft");
  const invalid = {
    ...binding(),
    stream: { ...binding().stream, scopeId: "different-scope" },
  };
  await render({ bind: invalid });
  expect(host.textContent).not.toContain("Old scope draft");
  expect(host.textContent).not.toContain("Keep emails short");
  expect(fixture.controller.snapshot().object).toBe("");
});
test("return chooses corrected identity, then next/previous surviving neighbor, then empty fallback", () => {
  const ids = ["a", "b", "c", "d"];
  expect(nearest(ids, "b", ["c", "d"])).toBe("c");
  expect(nearest(ids, "b", ["a", "d"])).toBe("a");
  expect(nearest(ids, "b", ["new", "a"], "new")).toBe("new");
  expect(nearest(ids, "b", [])).toBeNull();
});

test("detail remount preserves an unsubmitted draft for the same authenticated fact", async () => {
  await render();
  await open();
  await click("Edit memory");
  await fill("Correct value", "Draft survives remount");
  await React.act(async () => {
    root.render(
      <Harness
        key="remounted"
        route={{
          room: "memory-detail",
          selection: { factId: "fixture-memory-0" },
        }}
      />,
    );
    await wait();
  });
  expect(
    (host.querySelector(".brief-memory-detail textarea") as HTMLTextAreaElement)
      .value,
  ).toBe("Draft survives remount");
  expect(fixture.writes()).toBe(0);
});
test("return reloads the previously loaded page window and focuses a neighbor beyond page one", async () => {
  fixture.controller.retire();
  fixture.stream.retire();
  fixture = makeMemoryDetailFixture("many");
  await render();
  await click("Load more memories");
  expect(host.querySelectorAll(".brief-memory-row")).toHaveLength(100);
  await open("fixture-many-080");
  await click("Forget");
  await click("Forget this memory");
  await click("All memories");
  await React.act(wait);
  expect(host.querySelectorAll(".brief-memory-row")).toHaveLength(100);
  expect(document.activeElement?.getAttribute("data-fact-id")).toBe(
    "fixture-many-081",
  );
});
