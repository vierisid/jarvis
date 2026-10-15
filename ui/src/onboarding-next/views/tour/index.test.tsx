import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { TourIntent, TourModel, TourRoomRequest, TourViewProps } from "./index";
import { TOUR_STEPS } from "./descriptors";

let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let TourView: typeof import("./index").TourView;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement;
let props: TourViewProps;
let intents: TourIntent[];
let requests: TourRoomRequest[];
const realFetch = globalThis.fetch;
const realSocket = globalThis.WebSocket;
const realAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
let effects = 0;
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react")); ({ createRoot } = await import("react-dom/client"));
  ({ TourView } = await import("./index"));
  globalThis.fetch = Object.assign(async () => { effects++; throw new Error("Unexpected network"); }, { preconnect: realFetch.preconnect });
  globalThis.WebSocket = class { constructor() { effects++; throw new Error("Unexpected socket"); } } as never;
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined; });
afterAll(() => { globalThis.fetch = realFetch; globalThis.WebSocket = realSocket; (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = realAct; GlobalRegistrator.unregister(); });

const model = (): TourModel => ({ sessionId: "tour-1", stepId: "today", revision: 0, phase: "ready", theme: "light", sidebar: "expanded" });
async function mount(patch: Partial<TourModel> = {}, overrides: Partial<TourViewProps> = {}) {
  intents = []; requests = []; effects = 0;
  props = { model: { ...model(), ...patch }, renderer: { isolation: "fixture-only", renderRoom: request => {
    requests.push(request); return { status: "ready", content: <div><h1>{request.step.room} room fixture</h1><button onClick={() => effects++}>Send email</button><form onSubmit={() => effects++}><button>Delete</button></form></div> };
  } }, onNavigate: intent => { intents.push(intent); }, ...overrides };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); await render();
}
async function render(patch: Partial<TourModel> = {}) { props.model = { ...props.model, ...patch }; await act(async () => root!.render(<TourView {...props} />)); }
function button(text: string) { return Array.from(host.querySelectorAll<HTMLButtonElement>(".on-tour__card button")).find(el => el.textContent === text)!; }
async function click(text: string) { await act(async () => button(text).click()); }

test.each([...TOUR_STEPS])("approved descriptor renders in order: %j", async step => {
  await mount({ stepId: step.id });
  expect(host.querySelector("h2")?.textContent).toBe(step.title);
  expect(host.querySelector(".on-tour__body")?.textContent).toBe(step.body);
  expect(host.querySelector(".on-tour__count")?.textContent).toBe(`${String(TOUR_STEPS.indexOf(step) + 1).padStart(2, "0")} / 12`);
  expect(requests.at(-1)?.step.id).toBe(step.id);
  expect(requests.at(-1)?.effects).toBe("disabled");
  expect(requests.at(-1)?.mode).toBe("tutorial");
  expect(effects).toBe(0);
});
test("room copy promises only actions the product has", () => {
  const copy = TOUR_STEPS.map(step => step.body).join(" ").toLowerCase();
  // Facts can be corrected but not deleted, approvals are approve/deny, and Awareness asks before drafting.
  for (const claim of ["forget", "keep it as a draft", "edit it", "prepares the workflow"]) expect(copy).not.toContain(claim);
  expect(TOUR_STEPS.find(step => step.id === "opportunities")?.body).toContain("asks before drafting");
});
test("next does not advance without authoritative acknowledgement and double clicks emit once", async () => {
  await mount(); const next = button("Next");
  await act(async () => { next.click(); next.click(); next.click(); });
  expect(intents).toEqual([{ sessionId: "tour-1", revision: 0, from: "today", to: "workflows", action: "next" }]);
  expect(host.querySelector(".on-tour__count")?.textContent).toBe("01 / 12");
  expect(next.getAttribute("aria-disabled")).toBe("true");
  await click("Skip tour"); expect(intents.length).toBe(1);
  await render({ stepId: "workflows", revision: 1 });
  expect(button("Next")).toBe(next); expect(document.activeElement).toBe(next);
  await click("Next"); expect(intents[1]?.to).toBe("opportunities");
});
test("back is bounded and restores Next focus without remounting action row", async () => {
  await mount(); await click("Back"); expect(intents.length).toBe(0);
  await render({ stepId: "workflows", revision: 1 }); const next = button("Next");
  button("Back").focus(); await click("Back"); expect(intents[0]?.to).toBe("today");
  await render({ stepId: "today", revision: 2 }); expect(document.activeElement).toBe(next);
});
test.each(["workflows", "pebble"] as const)("delayed %s room restores its primary focus after loading", async stepId => {
  await mount(); const next = button("Next"); const readyRenderer = props.renderer;
  await click("Next");
  props.renderer = { isolation: "fixture-only", renderRoom: () => ({ status: "loading" }) };
  await render({ stepId, revision: 1 });
  const title = host.querySelector("h2")!;
  expect(document.activeElement === title).toBe(true);
  expect(next.getAttribute("aria-disabled")).toBe("true");
  props.renderer = readyRenderer; await render();
  expect(document.activeElement === next).toBe(true);
  expect(next.getAttribute("aria-disabled")).toBe("false");
  await act(async () => next.click());
  expect(intents.at(-1)?.action).toBe(stepId === "pebble" ? "open-pebble" : "next");
  expect(intents.at(-1)?.from).toBe(stepId);
});
test("delayed focus recovery waits for host navigation to be ready too", async () => {
  await mount(); const next = button("Next");
  await render({ stepId: "workflows", revision: 1, phase: "moving" });
  expect(document.activeElement === host.querySelector("h2")).toBe(true);
  await render({ phase: "ready" });
  expect(document.activeElement === next).toBe(true);
});
test.each(["Back", "Skip tour", "returned title"])("room readiness respects the user's focus choice: %s", async target => {
  await mount(); const readyRenderer = props.renderer;
  props.renderer = { isolation: "fixture-only", renderRoom: () => ({ status: "loading" }) };
  await render({ stepId: "workflows", revision: 1 });
  const title = host.querySelector<HTMLElement>("h2")!;
  button(target === "returned title" ? "Back" : target).focus();
  if (target === "returned title") title.focus();
  const chosen = document.activeElement;
  props.renderer = readyRenderer; await render();
  expect(document.activeElement === chosen).toBe(true);
  await render({ theme: "dark", sidebar: "rail" });
  expect(document.activeElement === chosen).toBe(true);
});
test("skip is distinct from completion and never marks onboarding done", async () => {
  await mount({ stepId: "goals" }); await click("Skip tour");
  expect(intents).toEqual([{ sessionId: "tour-1", revision: 0, from: "goals", action: "skip" }]); expect(effects).toBe(0);
});
test("last step emits a Pebble handoff, not completion or a chat mutation", async () => {
  await mount({ stepId: "pebble" }); await click("Open Pebble");
  expect(intents).toEqual([{ sessionId: "tour-1", revision: 0, from: "pebble", action: "open-pebble" }]); expect(effects).toBe(0);
});
test.each(["light", "dark"] as const)("theme %s and both sidebar states retain step and focus", async theme => {
  await mount({ theme, stepId: "settings" }); const next = button("Next"); next.focus();
  await render({ sidebar: "rail" }); expect(document.activeElement).toBe(next);
  expect(host.querySelector(".on-tour")?.getAttribute("data-theme")).toBe(theme);
  expect(requests.at(-1)?.sidebar).toBe("rail");
  await render({ theme: theme === "light" ? "dark" : "light", sidebar: "expanded" });
  expect(document.activeElement).toBe(next); expect(host.querySelector(".on-tour__count")?.textContent).toBe("10 / 12");
});
test("inert room is hidden from focus and capture blocks synthetic send/submit effects", async () => {
  await mount(); const room = host.querySelector<HTMLElement>(".on-tour__room")!;
  expect(room.hasAttribute("inert")).toBe(true); expect(room.getAttribute("aria-hidden")).toBe("true");
  await act(async () => { room.querySelector("button")!.click(); room.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(effects).toBe(0); expect(intents.length).toBe(0);
});
test.each(["unsupported", "loading", "error"] as const)("unavailable %s renderer cannot advance but can return or skip", async status => {
  await mount({ stepId: "memory" }, { renderer: { isolation: "fixture-only", renderRoom: () => ({ status }) } });
  await click("Next"); expect(intents.length).toBe(0); await click("Back"); expect(intents[0]?.action).toBe("back");
});
test("absent or incorrectly declared renderer is never invoked or considered ready", async () => {
  await mount({}, { renderer: undefined }); await click("Next"); expect(intents.length).toBe(0);
  props.renderer = { isolation: "live" as never, renderRoom: () => { effects++; return { status: "ready", content: <p>Live</p> }; } };
  await render({ revision: 1 }); await click("Next"); expect(effects).toBe(0); expect(intents.length).toBe(0);
  await click("Skip tour"); expect(intents[0]?.action).toBe("skip");
});
test("throwing or null room content fails closed", async () => {
  await mount({}, { renderer: { isolation: "fixture-only", renderRoom: () => { throw new Error("Unavailable"); } } });
  await click("Next"); expect(intents.length).toBe(0);
  props.renderer = { isolation: "fixture-only", renderRoom: () => ({ status: "ready", content: null }) };
  await render({ revision: 1 }); await click("Next"); expect(intents.length).toBe(0);
});
test("nested renderer exception is contained and disables advancement", async () => {
  const oldError = console.error; console.error = () => {};
  try {
    function Broken(): never { throw new Error("Fixture failure"); }
    await mount({}, { renderer: { isolation: "fixture-only", renderRoom: () => ({ status: "ready", content: <Broken /> }) } });
    await click("Next"); expect(intents.length).toBe(0); expect(host.textContent).toContain("room preview is unavailable");
  } finally { console.error = oldError; }
});
test.each([{ sessionId: null }, { sessionId: " " }, { revision: -1 }, { revision: NaN }, { revision: 1.5 }, { stepId: "retired-room" }, { phase: "future-state" as never }])("invalid model fails closed: %j", async patch => {
  await mount(patch); await click("Next"); await click("Skip tour"); expect(intents.length).toBe(0);
  expect(host.textContent).toContain("Tour progress is unavailable");
});
test("unknown step never invokes a fallback room", async () => {
  await mount({ stepId: "unknown" }); expect(requests.length).toBe(0); expect(host.querySelector(".on-tour__count")?.textContent).toBe("-- / 12");
});
test("missing navigation owner and moving state never emit intents", async () => {
  await mount({}, { onNavigate: undefined }); await click("Next"); expect(intents.length).toBe(0);
  props.onNavigate = intent => { intents.push(intent); }; await render({ phase: "moving" }); await click("Skip tour"); expect(intents.length).toBe(0);
});
test("provider errors require new revision; failed navigation can retry without changing position", async () => {
  await mount(); await click("Next"); await render({ phase: "error", revision: 1, error: "Progress was not saved." });
  expect(host.textContent).toContain("Progress was not saved."); await click("Next"); expect(intents.length).toBe(2);
  props.onNavigate = () => Promise.reject(new Error("Offline")); await render({ phase: "ready", revision: 2 }); await click("Next");
  expect(host.textContent).toContain("The tour could not move."); expect(button("Next").getAttribute("aria-disabled")).toBe("false");
  expect(host.querySelector(".on-tour__count")?.textContent).toBe("01 / 12");
});
test("late rejection cannot clear the current step's pending request", async () => {
  let reject!: (error: Error) => void;
  await mount({}, { onNavigate: () => new Promise<void>((_, r) => { reject = r; }) }); await click("Next");
  props.onNavigate = intent => { intents.push(intent); }; await render({ stepId: "workflows", revision: 1 }); await click("Next");
  await act(async () => reject(new Error("Stale")));
  expect(button("Next").getAttribute("aria-disabled")).toBe("true"); expect(host.textContent).not.toContain("could not move");
});
test("ten forward/back cycles retain the same primary and correct position", async () => {
  await mount(); const next = button("Next");
  for (let i = 0; i < 10; i++) {
    await click("Next"); await render({ stepId: "workflows", revision: i * 2 + 1 });
    await click("Back"); await render({ stepId: "today", revision: i * 2 + 2 });
    expect(button("Next")).toBe(next); expect(document.activeElement).toBe(next);
  }
  expect(intents.length).toBe(20); expect(effects).toBe(0);
});
