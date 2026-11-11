import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost:4427/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let mod: typeof import("./ReminderToast");
let root: ReturnType<typeof createRoot>, element: HTMLDivElement;
let last: ReturnType<typeof mod.useReminderToast>;

const reminder = (id: string) => ({ id, kind: "system" as const, proactive: true, stored: true, title: `Reminder ${id}`, text: "Call the accountant", timestamp: 1, tone: "neutral" as const, unread: true });

beforeAll(async () => { React = await import("react"); ({ createRoot } = await import("react-dom/client")); mod = await import("./ReminderToast"); });
beforeEach(() => { dismissed = []; localStorage.clear(); element = document.createElement("div"); document.body.append(element); root = createRoot(element); });
afterEach(async () => { await React.act(async () => root.unmount()); element.remove(); });
afterAll(() => GlobalRegistrator.unregister());

let dismissed: string[] = [];
function Harness({ items }: { items: ReturnType<typeof reminder>[] }) {
  last = mod.useReminderToast(items);
  const shown = last.notice;
  return shown ? <mod.ReminderToast notice={shown} onView={last.hide} onDismiss={() => { dismissed.push(shown.id); last.hide(); }} /> : null;
}
async function mount(items: ReturnType<typeof reminder>[]) {
  const view = () => <Harness items={items} />;
  await React.act(async () => root.render(view()));
  return view;
}

test("an unread reminder is toasted once, not again on the next page load", async () => {
  await mount([reminder("n1")]);
  expect(element.textContent).toContain("Reminder n1");
  await React.act(async () => root.unmount());
  root = createRoot(element);
  await mount([reminder("n1")]);
  expect(element.textContent).not.toContain("Reminder n1");
});

test("a newer reminder is toasted even when an older unread one was already shown", async () => {
  await mount([reminder("n1")]);
  await React.act(async () => root.unmount());
  root = createRoot(element);
  await mount([reminder("n2"), reminder("n1")]);
  expect(element.textContent).toContain("Reminder n2");
});

test("opening the list hides the toast and keeps the reminder unread", async () => {
  const items = [reminder("n1")];
  await mount(items);
  await React.act(async () => element.querySelectorAll("button")[0]!.click());
  expect(element.querySelector("aside")).toBeNull();
  expect(items[0]!.unread).toBe(true);
  expect(dismissed).toEqual([]);
});

test("Dismiss hides the toast and hands that reminder to the caller to mark read", async () => {
  await mount([reminder("n1")]);
  await React.act(async () => element.querySelectorAll("button")[1]!.click());
  expect(element.querySelector("aside")).toBeNull();
  expect(dismissed).toEqual(["n1"]);
});

test("the toast goes away on its own", async () => {
  const realSet = globalThis.setTimeout;
  const timers: Array<[() => void, number]> = [];
  globalThis.setTimeout = ((fn: () => void, ms: number) => { timers.push([fn, ms]); return 1; }) as unknown as typeof setTimeout;
  try {
    await mount([reminder("n1")]);
    const auto = timers.find(([, ms]) => ms === mod.TOAST_MS);
    expect(auto).toBeDefined();
    await React.act(async () => auto![0]());
    expect(element.querySelector("aside")).toBeNull();
  } finally { globalThis.setTimeout = realSet; }
});

test("the phone layout overrides the desktop offset instead of losing to it", () => {
  const css = readFileSync(new URL("./host.css", import.meta.url), "utf8");
  const base = css.match(/^\.brief-root\.brief-host-toast \{[^}]*\}/m)![0];
  const phone = css.match(/@media \(max-width: 640px\) \{([^@]*?brief-host-toast[^@]*?)\}\s*$/m);
  expect(base).toContain("right: 20px");
  expect(base).toContain("min(360px, calc(100vw - 40px))");
  // Same specificity as the base rule, so a later media rule can win.
  expect(css).toMatch(/@media \(max-width: 640px\) \{ \.brief-root\.brief-host-toast \{/);
  expect(phone).not.toBeNull();
});
