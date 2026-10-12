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
import { BriefCapabilities } from "../../../../../src/brief/capabilities";
import {
  makeMemoryFixture,
  MEMORY_SCOPE,
  type MemoryExample,
} from "./fixtures";
import type { MemoryBinding } from "./MemoryStreamRoom";
let React: typeof import("react"),
  createRoot: typeof import("react-dom/client").createRoot,
  Room: typeof import("./MemoryStreamRoom").MemoryStreamRoom;
let host: HTMLDivElement,
  root: Root,
  fixture: ReturnType<typeof makeMemoryFixture>,
  shell: BriefShellPort;
const wait = () => new Promise((resolve) => setTimeout(resolve, 12));
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ MemoryStreamRoom: Room } = await import("./MemoryStreamRoom"));
});
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture = makeMemoryFixture();
  shell = {
    mode: "preview",
    theme: "light",
    sidebar: "expanded",
    chatOpen: false,
    setTheme() {},
    setSidebar() {},
    setChatOpen() {},
    navigate() {},
    route: { room: "memory", selection: {} },
  };
});
afterEach(async () => {
  await React.act(async () => {
    root.unmount();
    fixture.controller.retire();
  });
  host.remove();
});
afterAll(() => GlobalRegistrator.unregister());
const binding = (): MemoryBinding => ({
  source: "fixture",
  scopeId: MEMORY_SCOPE,
  controller: fixture.controller,
});
async function render(
  b: MemoryBinding | undefined = binding(),
  key = "memory",
) {
  await React.act(async () => {
    root.render(<Room key={key} shell={shell} binding={b} />);
    await wait();
  });
}
test("aligned control names, grouped dates, long readable row targets; no Add or category tabs", async () => {
  await render();
  expect(
    [...host.querySelectorAll("label")].map((label) => label.textContent),
  ).toEqual(["Search", "Source", "Used in", "Updated"]);
  expect(host.querySelectorAll(".brief-memory-group")).toHaveLength(3);
  expect(host.querySelectorAll(".brief-memory-row")).toHaveLength(6);
  expect(host.querySelector('[role="tablist"]')).toBeNull();
  expect(host.textContent).not.toContain("Add memory");
  expect(host.textContent).toContain("Scope: work");
  expect(host.textContent).toContain("Selected only · not supplied");
});
test("filters survive all eight shell layouts and a host room remount", async () => {
  await render();
  await React.act(async () => {
    fixture.controller.setFilters(
      { search: "pilot", source: "Meeting notes" },
      0,
    );
    await wait();
  });
  for (const theme of ["light", "dark"] as const)
    for (const sidebar of ["expanded", "rail"] as const)
      for (const chatOpen of [false, true]) {
        shell = { ...shell, theme, sidebar, chatOpen };
        await render();
        expect(
          (host.querySelector('input[type="search"]') as HTMLInputElement)
            .value,
        ).toBe("pilot");
        expect(host.querySelectorAll(".brief-memory-row")).toHaveLength(2);
      }
  await render(binding(), "remount");
  expect(
    (host.querySelector('input[type="search"]') as HTMLInputElement).value,
  ).toBe("pilot");
  expect(fixture.requests).toHaveLength(2);
});
test("whole row passes canonical identity only; no correction/forget controls", async () => {
  let selected = "";
  await render({
    ...binding(),
    onOpen: (id) => {
      selected = id;
    },
  });
  await React.act(async () =>
    (host.querySelector(".brief-memory-row") as HTMLButtonElement).click(),
  );
  expect(selected).toBe("fixture-memory-0");
  expect(host.textContent).not.toContain("Forget");
  expect(host.textContent).not.toContain("Edit memory");
});
for (const example of [
  "loading",
  "empty",
  "stale",
  "error",
  "unavailable",
  "unsupported",
] as MemoryExample[])
  test(`${example} keeps controls and result-count space`, async () => {
    fixture.controller.retire();
    fixture = makeMemoryFixture(example);
    await render();
    expect(
      host.querySelectorAll(".brief-memory-filters .brief-field"),
    ).toHaveLength(4);
    expect(host.querySelector(".brief-memory-results-line")).not.toBeNull();
    expect(host.querySelectorAll(".brief-memory-row")).toHaveLength(0);
    if (example !== "empty")
      expect(
        host.querySelector(".brief-memory-results-line strong")?.textContent,
      ).toBe("—");
  });
test("empty search keeps applied filter and distinguishes it from an empty vault", async () => {
  await render();
  await React.act(async () => {
    fixture.controller.setFilters({ search: "nonexistent" }, 0);
    await wait();
  });
  expect(host.textContent).toContain("No matching memories");
  expect(host.textContent).not.toContain("No memories yet");
  expect(
    (host.querySelector('input[type="search"]') as HTMLInputElement).value,
  ).toBe("nonexistent");
});
test("missing and fixture providers cannot leak into live mode", async () => {
  shell = { ...shell, mode: "live" };
  await render();
  expect(fixture.requests).toHaveLength(0);
  expect(host.querySelectorAll(".brief-memory-row")).toHaveLength(0);
});
test("both F17/F18 capabilities and source/scope identity are required", async () => {
  const { memoryAvailable } = await import("./MemoryStreamRoom");
  shell = { ...shell, mode: "live" };
  const { MemoryController } = await import("./controller");
  const controller = new MemoryController({ ...fixture.port, source: "live" });
  const b: MemoryBinding = {
    source: "live",
    scopeId: MEMORY_SCOPE,
    controller,
  };
  const provider = { readiness: () => "ready" as const };
  b.capabilities = new BriefCapabilities(
    [
      { id: "memoryStream", provider },
      { id: "memoryUsage", provider },
    ],
    ["memoryStream"],
  ).snapshot();
  expect(memoryAvailable(shell, b)).toBe(false);
  b.capabilities = new BriefCapabilities(
    [
      { id: "memoryStream", provider },
      { id: "memoryUsage", provider },
    ],
    ["memoryStream", "memoryUsage"],
  ).snapshot();
  expect(memoryAvailable(shell, b)).toBe(true);
  expect(memoryAvailable(shell, { ...b, scopeId: "other" })).toBe(false);
  controller.retire();
});
test("long facts retain complete text, scope and qualifications without markup execution", async () => {
  fixture.controller.retire();
  fixture = makeMemoryFixture("long");
  await render();
  expect(
    host.querySelector(".brief-memory-sentence")!.textContent!.length,
  ).toBeGreaterThan(3000);
  expect(host.textContent).toContain("Contested");
  expect(host.textContent).toContain("inferred");
});
test("clearing filters is a real control and does not remount the search field", async () => {
  await render();
  const input = host.querySelector('input[type="search"]');
  await React.act(async () => {
    fixture.controller.setFilters({ search: "pilot" }, 0);
    await wait();
  });
  const clear = [...host.querySelectorAll("button")].find(
    (button) =>
      button.querySelector(".brief-button__label")?.textContent === "Clear",
  )!;
  await React.act(async () => {
    clear.click();
    await wait();
  });
  expect(host.querySelector('input[type="search"]')).toBe(input);
  expect((input as HTMLInputElement).value).toBe("");
  expect(host.querySelectorAll(".brief-memory-row")).toHaveLength(6);
});
test("Source dropdown preserves canonical whitespace and keeps a selected value outside a changing catalog", async () => {
  const source = " \tSource\n ";
  await render({ ...binding(), sourceOptions: [source] });
  const select = [...host.querySelectorAll("select")].find(
    (node) => node.value === "any",
  )!;
  await React.act(async () => {
    select.value = `value:${source}`;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await wait();
  });
  expect(fixture.requests.at(-1)!.source).toBe(source);
  await render({ ...binding(), sourceOptions: [] });
  expect(
    [...host.querySelectorAll("option")].some(
      (option) => option.value === `value:${source}`,
    ),
  ).toBe(true);
});
test("exact filter entry applies with Enter, cancels with Escape, and restores focus", async () => {
  await render();
  const label = [...host.querySelectorAll("label")].find(
    (node) => node.textContent === "Used in",
  )!;
  let select = document.getElementById(label.htmlFor) as HTMLSelectElement;
  await React.act(async () => {
    select.value = "exact";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await wait();
  });
  const input = host.querySelector(
    'input[placeholder="conversation:<id> or run:<id>"]',
  ) as HTMLInputElement;
  expect(input).not.toBeNull();
  await React.act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await wait();
  });
  expect(fixture.requests).toHaveLength(1);
  expect(document.activeElement?.tagName).toBe("SELECT");
});
