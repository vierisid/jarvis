import { describe, expect, test } from "bun:test";
import { SUMMARY_MAX_CHARS, humanizePieceName, summarizeWorkflow } from "./workflow-summary";
import type { FlowStepNode, PieceCatalogEntry } from "./useWorkflowEditor";

const piece = (name: string, displayName: string, actions: Array<[string, string]> = [], triggers: Array<[string, string]> = []): PieceCatalogEntry => ({
  name, displayName, description: "",
  actions: actions.map(([n, d]) => ({ name: n, displayName: d, description: "", inputSchema: null })),
  triggers: triggers.map(([n, d]) => ({ name: n, displayName: d, description: "", inputSchema: null })),
});
const catalog = [
  piece("@jarvispieces/piece-jarvis-notify", "Jarvis Notify", [["notify", "Send a Jarvis notification"]]),
  piece("@jarvispieces/piece-text", "Text", [["slugify", "Slugify a note"]]),
  piece("@activepieces/piece-gmail", "Gmail", [["send_email", "Send Email"]], [["new_email", "New Email"]]),
];
const step = (name: string, settings: FlowStepNode["settings"], extra: Partial<FlowStepNode> = {}): FlowStepNode =>
  ({ name, type: "PIECE", settings, ...extra });
const schedule = (cron: string, zone?: string, next?: FlowStepNode): FlowStepNode => ({
  name: "trigger", type: "PIECE_TRIGGER",
  settings: { pieceName: "schedule", input: { cron_expression: cron, ...(zone ? { timezone: zone } : {}) }, ...(zone ? { chosenTimezone: zone } : {}) },
  ...(next ? { nextAction: next } : {}),
});
const notify = (channels: string[] = ["dashboard"]) => step("notify", { pieceName: "@jarvispieces/piece-jarvis-notify", actionName: "notify", input: { message: "x", channels } });
const slugify = (next?: FlowStepNode) => step("step_1", { pieceName: "@jarvispieces/piece-text", actionName: "slugify" }, next ? { nextAction: next } : {});

describe("trigger in words", () => {
  test("schedule, webhook, manual and event", () => {
    expect(summarizeWorkflow(schedule("0 9 * * 1-5", "Europe/Rome"), catalog).trigger).toBe("Every weekday at 9:00 (Europe/Rome)");
    expect(summarizeWorkflow({ name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "webhook", input: {} } }).trigger).toBe("When a webhook receives data");
    expect(summarizeWorkflow({ name: "trigger", type: "EMPTY" }).trigger).toBe("When you run it");
    expect(summarizeWorkflow({ name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "@jarvispieces/piece-jarvis-trigger", triggerName: "on_event", input: { eventType: "clipboard.changed" } } }).trigger)
      .toBe("When a clipboard changed event happens");
  });
  test("another piece's trigger uses its names, and an unknown piece still reads", () => {
    const trigger = (pieceName: string): FlowStepNode => ({ name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName, triggerName: "new_email", input: {} } });
    expect(summarizeWorkflow(trigger("@activepieces/piece-gmail"), catalog).trigger).toBe("When new email in Gmail");
    expect(summarizeWorkflow(trigger("@activepieces/piece-not-installed"), catalog).trigger).toBe("When something happens in not installed");
  });
});

describe("steps in order", () => {
  test("a chain reads as a sentence, with known pieces in plain words", () => {
    const s = summarizeWorkflow(schedule("0 9 * * 1-5", "Europe/Rome", slugify(notify())), catalog);
    expect(s.text).toBe("Every weekday at 9:00 (Europe/Rome), then slugify a note, then notify you on the dashboard.");
    expect(s.steps).toEqual(["slugify a note", "notify you on the dashboard"]);
  });
  test("a step the person named uses their name; a code step and an unknown piece fall back", () => {
    const code: FlowStepNode = { name: "step_2", type: "CODE" };
    const named = step("step_1", { pieceName: "@activepieces/piece-gmail", actionName: "send_email" }, { displayName: "Email the team", nextAction: code });
    code.nextAction = step("step_3", { pieceName: "@activepieces/piece-zzz", actionName: "do" });
    expect(summarizeWorkflow(schedule("0 9 * * *", undefined, named), catalog).text)
      .toBe("Every day at 9:00, then email the team, then run custom code, then use zzz.");
  });
  test("a long display name or the engine's default name is not read out", () => {
    const long = step("step_1", { pieceName: "@activepieces/piece-gmail", actionName: "send_email" }, { displayName: "Notify once per scheduled date; review unconfirmed delivery" });
    expect(summarizeWorkflow(schedule("0 9 * * *", undefined, long), catalog).steps).toEqual(["send email"]);
  });
  test("an empty workflow still says something", () => {
    expect(summarizeWorkflow({ name: "trigger", type: "EMPTY" }).text).toBe("When you run it, then nothing else yet.");
  });
});

describe("routers and loops", () => {
  const router = (next?: FlowStepNode): FlowStepNode => ({
    name: "router", type: "ROUTER",
    settings: { branches: [
      { branchType: "CONDITION", branchName: "High score", conditions: [[{ firstValue: "{{trigger.score}}", operator: "NUMBER_IS_GREATER_THAN", secondValue: "80" }]] },
      { branchType: "FALLBACK", branchName: "Otherwise" },
    ] },
    children: [notify(), null],
    ...(next ? { nextAction: next } : {}),
  });
  test("a router reads as if ... otherwise ...", () => {
    const text = summarizeWorkflow(schedule("0 9 * * *", undefined, router(slugify())), catalog).text;
    expect(text).toBe("Every day at 9:00, then if score is greater than 80, notify you on the dashboard; otherwise do nothing, then slugify a note.");
  });
  test("a loop reads as for each ... and names where the items come from", () => {
    const inner = step("inner", { pieceName: "@activepieces/piece-gmail", actionName: "send_email" }, { nextAction: notify() });
    const fetch = slugify({ name: "loop", type: "LOOP_ON_ITEMS", settings: { items: "{{step_1.rows}}" }, firstLoopAction: inner });
    expect(summarizeWorkflow(schedule("0 9 * * *", undefined, fetch), catalog).text)
      .toBe("Every day at 9:00, then slugify a note, then for each item from the result of slugify a note, send email and then notify you on the dashboard.");
  });
});

describe("length", () => {
  test("many steps are capped and the rest is counted", () => {
    let head: FlowStepNode | undefined;
    for (let i = 30; i >= 1; i--) head = step(`s${i}`, { pieceName: "@activepieces/piece-gmail", actionName: "send_email" }, head ? { nextAction: head } : {});
    const s = summarizeWorkflow(schedule("0 9 * * *", undefined, head), catalog);
    expect(s.text.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS + 40);
    expect(s.hiddenSteps).toBe(30 - s.steps.length);
    expect(s.hiddenSteps).toBeGreaterThan(0);
    expect(s.text).toContain(`and ${s.hiddenSteps} more steps.`);
  });
  test("piece names lose their scope and Piece prefix", () => {
    expect(humanizePieceName("@jarvispieces/piece-jarvis-notify")).toBe("jarvis notify");
  });
});
