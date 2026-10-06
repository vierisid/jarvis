import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { BriefCapabilities } from "../../../../../src/brief/capabilities";
import { outcomeView, qualifiedTime, progressBand, formatNumber, weekTime, type OutcomeBinding, type OutcomeSummary } from "./model";
import { outcomeFixture, activityFixture, fixtureMeasurement } from "../preview/outcomeFixtures";
import type { BriefRoute } from "../../contracts";

GlobalRegistrator.register({ url: "http://localhost:4389/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let Outcomes: typeof import("./Outcomes").Outcomes;
let RecentActivity: typeof import("../activity/RecentActivity").RecentActivity;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let animations: Array<{ element: HTMLElement; frames: unknown; cancelled: boolean }>;
const originalAnimate = HTMLElement.prototype.animate;
beforeAll(async () => {
  React = await import("react"); ({ createRoot } = await import("react-dom/client"));
  ({ Outcomes } = await import("./Outcomes")); ({ RecentActivity } = await import("../activity/RecentActivity"));
  HTMLElement.prototype.animate = function (frames) {
    const record = { element: this, frames, cancelled: false }; animations.push(record);
    return { cancel() { record.cancelled = true; } } as Animation;
  };
});
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); animations = []; });
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => { HTMLElement.prototype.animate = originalAnimate; GlobalRegistrator.unregister(); });
async function render(binding?: OutcomeBinding, mode: "preview" | "live" = "preview", reducedMotion = false) {
  await React.act(async () => root.render(<div className="brief-root"><Outcomes binding={binding} mode={mode} reducedMotion={reducedMotion} /></div>));
}
function readyData(binding = outcomeFixture()): OutcomeSummary {
  if (binding.state.status !== "ready") throw new Error("Expected ready fixture"); return binding.state.data;
}
// Read text exposed to assistive technology, excluding decorative glyphs.
// This intentionally does not treat aria-label on a generic span as readable text.
function exposedText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof Element && node.matches('[aria-hidden="true"], [hidden]')) return "";
  return [...node.childNodes].map(exposedText).join("");
}
const text = () => exposedText(host);

test("animated numbers expose one complete formatted value through updates", async () => {
  const { OutcomeNumber } = await import("./Values");
  for (const [value, expected] of [[90, "90"], [0, "0"], [1234.5, "1,234.5"], [-2, "-2"], [.001, "0.001"], [10, "10"]] as const) {
    await React.act(async () => root.render(<OutcomeNumber value={value} />));
    const number = host.querySelector(".brief-outcome-number")!;
    expect(exposedText(number)).toBe(expected);
    expect(number.hasAttribute("aria-label")).toBe(false);
    expect([...number.querySelectorAll("[data-value-glyph]")].map(glyph => glyph.textContent).join("")).toBe(expected);
    expect([...number.querySelectorAll("[data-value-glyph]")].every(glyph => glyph.closest('[aria-hidden="true"]'))).toBe(true);
  }
});

test("an unknown weekly change exposes its meaning rather than an unnamed dash", async () => {
  await render(outcomeFixture("unknown-goal"));
  expect(exposedText(host.querySelector(".brief-outcome-unknown")!)).toBe("Weekly change unknown");
});

test("live values require a live owner and both outcome and measurement gates", async () => {
  const provider = { readiness: () => "ready" as const };
  const capabilities = new BriefCapabilities([{ id: "outcomes", provider }, { id: "goalMeasurements", provider }], ["outcomes", "goalMeasurements"]).snapshot();
  for (const input of [undefined, outcomeFixture(), { ...outcomeFixture(), source: "live" as const }, { ...outcomeFixture(), source: "live" as const, capabilities: new BriefCapabilities().snapshot() }]) {
    await render(input, "live"); expect(text()).not.toContain("90"); expect(text()).toContain("not available");
  }
  await render({ ...outcomeFixture(), source: "live", capabilities }, "live"); expect(text()).toContain("saved today");
  expect(outcomeView("preview", { ...outcomeFixture(), source: "live", capabilities }).state.status).toBe("unavailable");
  capabilities.capabilities.goalMeasurements.enabled = false;
  await render({ ...outcomeFixture(), source: "live", capabilities }, "live"); expect(text()).not.toContain("90");
});

test("unknown, missing baseline, wrong units and missing provenance never become time claims", async () => {
  const invalid = [null, { ...fixtureMeasurement(90, "minutes"), baseline: null }, { ...fixtureMeasurement(90, "minutes"), baseline: 5 }, fixtureMeasurement(90, "seconds"), { ...fixtureMeasurement(90, "minutes"), provenance: [] }, fixtureMeasurement(NaN, "minutes"), fixtureMeasurement(-1, "minutes")];
  for (const measurement of invalid) {
    expect(qualifiedTime(measurement)).toBe(false);
    const data = readyData(); data.today = measurement; data.week = measurement;
    await render({ source: "fixture", state: { status: "ready", data } });
    expect(text()).toContain("Not enough evidence yet"); expect(text()).not.toContain("saved today"); expect(text()).not.toContain("5h back");
  }
});

test("a real measured zero is distinct from an unknown value", async () => {
  await render(outcomeFixture("zero")); expect(text()).toContain("0min"); expect(text()).toContain("0 min back this week");
  expect(host.querySelector('.brief-outcome-progress[aria-label="0 of 10 design partners signed"]')).not.toBeNull();
  await render(outcomeFixture("partial")); expect(text()).toContain("Partial coverage"); expect(text()).not.toContain("0min");
  expect(host.querySelector('button[aria-label="Tue: time not available"]')).not.toBeNull();
});

test("loading, empty, stale, unsupported and unavailable keep distinct honest messages", async () => {
  for (const scenario of ["loading", "empty", "stale", "unsupported", "unavailable"]) {
    await render(outcomeFixture(scenario)); expect(host.querySelector("[data-state]")!.getAttribute("data-state")).toBe(scenario);
    if (scenario === "stale") { expect(text()).toContain("Previously reported"); expect(text()).toContain("90min"); }
    else { expect(text()).not.toContain("90min"); expect(text()).not.toContain("0min"); }
  }
});

test("unknown goal measurement does not infer six partners from a goal title", async () => {
  await render(outcomeFixture("unknown-goal")); expect(text()).toContain("Progress not measured yet");
  expect(host.querySelector(".brief-outcome-progress")).toBeNull(); expect(text()).not.toContain("6/10");
});

test("approved bands share exact boundaries and preserve fractional progress", async () => {
  expect([0, 19, 20, 39, 40, 74, 75, 100].map(value => progressBand(value, 100))).toEqual(["near", "near", "early", "early", "middle", "middle", "complete", "complete"]);
  const data = readyData(); data.goal!.progress = fixtureMeasurement(7.5);
  await render({ source: "fixture", state: { status: "ready", data } });
  expect(host.querySelector(".brief-progress--complete")).not.toBeNull();
  const parts = host.querySelectorAll<HTMLElement>(".brief-outcome-segment i");
  expect(parts.length).toBe(10); expect(parts[7]!.style.transform).toBe("scaleX(0.5)"); expect(parts[8]!.style.transform).toBe("scaleX(0)");
});

test("only the changed count glyphs and seventh segment update; labels and time nodes persist", async () => {
  await render(outcomeFixture()); expect(animations.length).toBe(0);
  const time = host.querySelector(".brief-outcome-time-value")!, caption = host.querySelector(".brief-outcome-week-total")!, denominator = host.querySelector(".brief-outcome-denominator")!;
  const segments = [...host.querySelectorAll<HTMLElement>(".brief-outcome-segment i")];
  const before = segments.map(element => element.style.transform);
  await render(outcomeFixture("ready", true));
  expect(animations.map(item => item.element.textContent)).toEqual(["3", "7"]);
  expect(host.querySelector(".brief-outcome-time-value")).toBe(time); expect(host.querySelector(".brief-outcome-week-total")).toBe(caption); expect(host.querySelector(".brief-outcome-denominator")).toBe(denominator);
  expect(segments.map((element, i) => element.style.transform !== before[i])).toEqual([false, false, false, false, false, false, true, false, false, false]);
  animations = []; await render(outcomeFixture("ready", true)); expect(animations.length).toBe(0);
});

test("remount, new window and new goal never replay a count-up or arrival animation", async () => {
  await render(outcomeFixture()); const data = readyData(outcomeFixture("ready", true)); data.window.start += 7 * 86400000;
  await render({ source: "fixture", state: { status: "ready", data } }); expect(animations.length).toBe(0);
  data.goal = { ...data.goal!, goalId: "another-goal", progress: fixtureMeasurement(1) };
  await render({ source: "fixture", state: { status: "ready", data: { ...data } } }); expect(animations.length).toBe(0);
  await React.act(async () => root.render(null)); await render(outcomeFixture("ready", true)); expect(animations.length).toBe(0);
});

test("reaching a two-digit target retains the denominator and its reserved numeric slot", async () => {
  await render(outcomeFixture("near-complete"));
  const fraction = host.querySelector<HTMLElement>(".brief-outcome-fraction")!;
  const denominator = host.querySelector(".brief-outcome-denominator");
  expect(fraction.style.getPropertyValue("--goal-count-width")).toBe("2ch");
  await render(outcomeFixture("near-complete", true));
  expect(host.querySelector(".brief-outcome-denominator")).toBe(denominator);
  expect(fraction.style.getPropertyValue("--goal-count-width")).toBe("2ch");
  expect(exposedText(fraction.querySelector(".brief-outcome-number")!)).toBe("10");
  expect(host.querySelector('.brief-progress--complete[aria-label="10 of 10 design partners signed"]')).not.toBeNull();
});

test("reduced motion updates values immediately and cancels an interrupted glyph animation", async () => {
  await render(outcomeFixture()); await render(outcomeFixture("ready", true)); expect(animations.length).toBe(2);
  await render(outcomeFixture(), "preview", true); expect(animations.length).toBe(2); expect(animations.every(item => item.cancelled)).toBe(true);
  expect(host.querySelector('.brief-outcome-panel[data-reduced="true"]')).not.toBeNull();
  expect(host.querySelector('.brief-outcome-progress[data-reduced="true"]')).not.toBeNull();
});

test("bar values are available on keyboard focus with no numeric fallback", async () => {
  await render(outcomeFixture());
  const bar = host.querySelector<HTMLButtonElement>('button[aria-label^="Today:"]')!;
  await React.act(async () => bar.focus()); expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Today: 90 min saved · estimated");
  await React.act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});

test("values above the chart scale are marked rather than silently misrepresented", async () => {
  const data = readyData(); data.chartMaxMinutes = 60;
  await render({ source: "fixture", state: { status: "ready", data } });
  expect(host.querySelectorAll('[data-overflow="true"]').length).toBe(3);
  expect(host.querySelector('button[aria-label="Today: 90 min saved · estimated · above chart scale"]')).not.toBeNull();
});

test("evidence includes basis, timezone, qualification and source count without the removed heading", async () => {
  await render(outcomeFixture()); expect(text()).not.toContain("Time back"); expect(text()).not.toContain("week · estimated");
  const evidence = host.querySelector("details")!;
  expect(evidence.textContent).toContain("Europe/Berlin"); expect(evidence.textContent).toContain("1 evidence reference"); expect(evidence.textContent).toContain("manual-task baselines");
  expect(formatNumber(.001)).toBe("0.001"); expect(weekTime(305)).toBe("5h 5m");
});

test("activity uses stable source identities, and only a bound destination is interactive", async () => {
  const opened: BriefRoute[] = [];
  const renderRows = async (actionable: boolean, handler = true) => React.act(async () => root.render(<RecentActivity mode="preview" binding={activityFixture("ready", actionable)} onOpen={handler ? route => opened.push(route) : undefined} />));
  await renderRows(false); expect(host.querySelectorAll("button").length).toBe(0);
  const notes = host.querySelector('[data-activity-id="fixture-notes"]');
  await renderRows(true); expect(host.querySelectorAll("button").length).toBe(1); expect(host.querySelector('[data-activity-id="fixture-notes"]')).toBe(notes);
  await React.act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(opened).toEqual([{ room: "workflow-runs", selection: { flowId: "fixture-inbox-flow", runId: "fixture-inbox-run" } }]);
  await renderRows(true, false); expect(host.querySelectorAll("button").length).toBe(0);
});

test("empty and unavailable activity never invent events or expose preview rows in live mode", async () => {
  for (const scenario of ["empty", "loading", "unavailable"]) {
    await React.act(async () => root.render(<RecentActivity mode="preview" binding={activityFixture(scenario)} />));
    expect(host.querySelectorAll("li").length).toBe(0); expect(text()).not.toContain("Inbox brief saved");
  }
  await React.act(async () => root.render(<RecentActivity mode="live" binding={activityFixture()} />)); expect(text()).not.toContain("Inbox brief saved");
});
