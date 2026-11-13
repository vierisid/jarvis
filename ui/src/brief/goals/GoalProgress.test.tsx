import { beforeAll, beforeEach, afterEach, afterAll, test, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type { BriefShellPort } from "../contracts";
import type { GoalsController } from "./controller";

/** The Goals room against a small stand-in for the goal routes, so a save travels the real host port. */
let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let Room: typeof import("./GoalsRoom").GoalsRoom, Controller: typeof import("./controller").GoalsController;
let host: HTMLDivElement, root: Root, controller: GoalsController, shell: BriefShellPort;
let goals: any[], calls: Array<{ path: string; body: any }>, refused: Response | null, committed: Set<string>, loseReply: boolean;
const wait = () => new Promise((resolve) => setTimeout(resolve, 10));

const goal = (id: string, extra: Record<string, unknown> = {}) => ({
  goalId: id, revision: "1:0", title: id, status: "active", health: "on_track", score: 0, measurement: null, measurementRevision: 0,
  measurementDefinition: null, progress: { value: null, basis: "unknown", rollup: "independent" }, parentId: null, pathTitle: id, ...extra,
});
const reading = (g: any, value: number | null, target: number, unit: string) => ({
  value, target, unit, baseline: 0, qualification: "user_reported", asOf: Date.now(), provenance: [{ kind: "source", id: "x", revision: "1" }],
});
function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const server = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input), body = init?.body ? JSON.parse(String(init.body)) : null;
  if (init?.method !== "POST") {
    const asked = new URL(path, "http://host").searchParams.get("requestId");
    if (asked !== null) return respond({ receipt: committed.has(asked) ? { requestId: asked } : null });
    return respond({ state: "ready", data: structuredClone(goals) });
  }
  calls.push({ path, body });
  if (refused) return refused.clone();
  if (body?.requestId && committed.has(body.requestId)) return respond({ code: "MEASUREMENT_CONFLICT", error: "Request ID already has a different measurement" }, 409);
  const reply = await commit(path, body);
  if (reply.ok && body?.requestId) committed.add(body.requestId);
  // The server commits, then the reply never arrives.
  if (loseReply) { loseReply = false; throw new TypeError("network"); }
  return reply;
}) as typeof fetch;
async function commit(path: string, body: any): Promise<Response> {
  const target = goals.find((g) => path.includes(`/${g.goalId}/`) || path.includes(`/${g.goalId}`));
  if (!target) return respond({ error: "missing" }, 404);
  if (path.endsWith("/status")) { target.status = body.status; return respond(target); }
  if (path.endsWith("/measurement") || path.endsWith("/measurement/counted")) {
    if (body.revision !== target.measurementRevision) return respond({ code: "MEASUREMENT_CONFLICT", error: "Measurement changed; refresh before saving" }, 409);
    const m = body.measurement ?? { ...body.definition, value: null };
    target.measurementRevision += 1;
    target.measurementDefinition = { unit: m.unit, baseline: m.baseline, target: m.target, basis: path.endsWith("counted") ? "observations" : "reported" };
    target.counted = 0;
    if (m.value !== null) {
      target.measurement = reading(target, m.value, m.target, m.unit);
      target.progress = { value: (m.value - m.baseline) / (m.target - m.baseline), basis: "measurement", rollup: "independent" };
    }
    return respond({ ok: true });
  }
  if (path.endsWith("/observations")) {
    target.counted += 1; target.measurementRevision += 1;
    target.measurement = reading(target, target.counted, target.measurementDefinition.target, target.measurementDefinition.unit);
    target.progress = { value: target.counted / target.measurementDefinition.target, basis: "measurement", rollup: "independent" };
    return respond({ ok: true });
  }
  return respond({}, 404);
}

beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ GoalsRoom: Room } = await import("./GoalsRoom"));
  ({ GoalsController: Controller } = await import("./controller"));
});
afterAll(() => GlobalRegistrator.unregister());
beforeEach(async () => {
  calls = []; refused = null; goals = []; committed = new Set(); loseReply = false;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  shell = { mode: "live", theme: "light", sidebar: "expanded", chatOpen: false, setTheme() {}, setSidebar() {}, setChatOpen() {},
    route: { room: "goals", selection: {} }, navigate: (route) => { shell = { ...shell, route }; } } as BriefShellPort;
});
afterEach(async () => { await React.act(async () => root.unmount()); controller.retire(); host.remove(); });

async function open() {
  const { createHostTransport } = await import("../host/http");
  const { createDomainPorts } = await import("../host/domain-ports");
  const { BriefCapabilities } = await import("../../../../src/brief/capabilities");
  const caps = new BriefCapabilities([{ id: "goalMeasurements", provider: { readiness: () => "ready" as const } }], ["goalMeasurements"]).snapshot();
  const ports = createDomainPorts("scope", createHostTransport(server), window.localStorage);
  controller = new Controller(ports.goals);
  await React.act(async () => {
    root.render(<Room shell={shell} binding={{ source: "live", scopeId: "scope", controller, capabilities: caps } as any} />);
    await wait();
  });
  await React.act(async () => { await wait(); });
}
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.replace(/\s+/g, " ").trim().startsWith(name))!;
async function click(name: string) {
  expect(button(name), name).toBeTruthy();
  await React.act(async () => { button(name).click(); await wait(); });
}
async function type(label: string, value: string) {
  const input = [...host.querySelectorAll("input")].find((i) => host.querySelector(`label[for="${i.id}"]`)?.textContent?.startsWith(label))! as HTMLInputElement;
  expect(input, label).toBeTruthy();
  await React.act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); await wait();
  });
}
const submit = async () => { await React.act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await wait(); await wait(); }); };

test("a typed value logged from the Goals room reaches the goal and the room shows it", async () => {
  goals = [goal("sales", { measurementDefinition: { unit: "euros", baseline: 0, target: 1000, basis: "reported" }, measurement: reading(null, 0, 1000, "euros"),
    progress: { value: 0, basis: "measurement", rollup: "independent" } })];
  await open();
  expect(host.textContent).toContain("0 / 1,000 euros");
  await click("Log progress");
  await type("New value", "250");
  await submit();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.path).toBe("/api/brief/goals/sales/measurement");
  expect(calls[0]!.body).toMatchObject({ revision: 0, measurement: { unit: "euros", baseline: 0, target: 1000, value: 250 } });
  expect(calls[0]!.body.measurement.measuredAt).toBeLessThanOrEqual(Date.now());
  expect(calls[0]!.body.measurement.evidence.revision).toBe(calls[0]!.body.requestId);
  expect(host.textContent).toContain("250 / 1,000 euros");
  expect(host.textContent).toContain("Saved 250 euros.");
  expect(host.querySelector("form")).toBeNull();
});

test("a counted goal takes an entry with a short note and an optional link", async () => {
  goals = [goal("pilots", { counted: 0, measurementRevision: 1, measurementDefinition: { unit: "pilots", baseline: 0, target: 4, basis: "observations" } })];
  await open();
  await click("Log progress");
  await type("What did you add", "Acme signed");
  await type("Link", "https://example.com/contract");
  await submit();
  expect(calls[0]!.path).toBe("/api/brief/goals/pilots/observations");
  expect(calls[0]!.body.entry).toMatchObject({ kind: "counted", subject: "Acme signed", corrects: null, source: { id: "https://example.com/contract" } });
  expect(host.textContent).toContain("1 / 4 pilots");
});

test("a goal changed elsewhere says so in plain words and keeps the form", async () => {
  goals = [goal("sales", { measurementRevision: 1, measurementDefinition: { unit: "euros", baseline: 0, target: 1000, basis: "reported" } })];
  await open();
  await click("Log progress");
  goals[0].measurementRevision = 2;
  await type("New value", "10");
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("This goal changed since you opened it. Refresh and try again.");
  expect(host.querySelector("form")).not.toBeNull();
  // The room read the goal again, so a retry carries the current revision.
  await submit();
  expect(calls.at(-1)!.body.revision).toBe(2);
  expect(host.querySelector("form")).toBeNull();
});

test("a goal with no measure offers to set one, then logs against it", async () => {
  goals = [goal("brand")];
  await open();
  expect(button("Log progress")).toBeUndefined();
  await click("Set how to measure this");
  await type("What you measure", "followers");
  await type("Target", "500");
  await submit();
  expect(calls[0]!.path).toBe("/api/brief/goals/brand/measurement");
  expect(calls[0]!.body).toMatchObject({ revision: 0, measurement: { unit: "followers", baseline: 0, target: 500, value: null, measuredAt: null, evidence: null } });
  expect(button("Log progress")).toBeTruthy();
});

test("a draft goal says it is a draft where the founder looks, and can be activated", async () => {
  goals = [goal("draft-goal", { status: "draft", title: "Plan the launch" })];
  await open();
  expect(host.textContent).toContain("1 draft goal is not shown here.");
  expect(host.textContent).toContain("Draft: review and activate");
  await click("Review drafts");
  expect(host.textContent).toContain("Draft: review and activate");
  await click("Activate goal");
  expect(calls[0]).toMatchObject({ path: "/api/goals/draft-goal/status", body: { status: "active" } });
  expect(host.textContent).not.toContain("Draft: review and activate");
});

test("a refused save shows plain words, never the server's text", async () => {
  goals = [goal("sales", { measurementRevision: 1, measurementDefinition: { unit: "euros", baseline: 0, target: 1000, basis: "reported" } })];
  await open();
  await click("Log progress");
  refused = respond({ code: "INVALID_GOAL_MEASUREMENT", error: "measurement.value: is outside the permitted numeric range" }, 400);
  await type("New value", "5");
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("That did not save. Check what you entered and try again.");
  await type("New value", "abc");
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Enter the new value as a number.");
});

test("a save whose reply was lost is recovered from its receipt, and a retry does not count twice", async () => {
  goals = [goal("sales", { measurementRevision: 1, measurementDefinition: { unit: "euros", baseline: 0, target: 1000, basis: "reported" } })];
  await open();
  await click("Log progress");
  await type("New value", "250");
  loseReply = true;
  await submit();
  expect(calls).toHaveLength(1);
  expect(host.textContent).toContain("Saved 250 euros.");
  expect(host.textContent).toContain("250 / 1,000 euros");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("a measure is only offered for change where the server can keep its history", async () => {
  goals = [
    goal("sales", { measurementRevision: 2, measurementDefinition: { unit: "euros", baseline: 0, target: 1000, basis: "reported" },
      measurement: reading(null, 300, 1000, "euros"), progress: { value: 0.3, basis: "measurement", rollup: "independent" } }),
  ];
  await open();
  expect(button("Log progress")).toBeTruthy();
  // A typed measure with logged values cannot be redefined without a new value.
  expect(button("Change how it is measured") === undefined).toBe(true);
});

test("a counted goal stays counted, keeps what it counts once it has entries, and keeps its starting count", async () => {
  goals = [goal("pilots", { counted: 1, measurementRevision: 3, measurementDefinition: { unit: "pilots", baseline: 2, target: 6, basis: "observations" },
    measurement: reading(null, 3, 6, "pilots"), progress: { value: 0.25, basis: "measurement", rollup: "independent" } })];
  await open();
  await click("Change how it is measured");
  expect(host.querySelector("form")!.querySelector("select") === null).toBe(true);
  const unit = [...host.querySelectorAll("input")].find((i) => host.querySelector(`label[for="${i.id}"]`)?.textContent === "What you measure")!;
  expect(unit?.disabled).toBe(true);
  await type("Target", "8");
  await submit();
  expect(calls[0]!.path).toBe("/api/brief/goals/pilots/measurement/counted");
  expect(calls[0]!.body).toMatchObject({ revision: 3, definition: { unit: "pilots", baseline: 2, target: 8 } });
});
