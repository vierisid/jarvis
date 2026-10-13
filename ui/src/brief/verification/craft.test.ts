import { expect, test } from "bun:test";
import { BRIEF_ROOM_IDS } from "../contracts";
import { requiredCases, fixtureBlock, newReport, ROOMS } from "../../../../scripts/brief-craft/matrix.mjs";
import { assessReport, completeReport } from "../../../../scripts/brief-craft/report.mjs";
import { layoutProblems } from "../../../../scripts/brief-craft/browser.mjs";
import { runCases } from "../../../../scripts/brief-craft/browser.mjs";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const head = "a".repeat(40);
const required = requiredCases();
function allPassed() {
  return { ...newReport(head), source: "live", cases: required.map(test => ({ id: test.id, status: "passed", evidence: ["observation.json"] })), capabilities: ROOMS.map(room => ({ room: room.id, head, enabled: true, evidence: "capabilities.json" })) };
}

test("every registered room has all 32 content/layout cases and all viewport/interaction requirements", () => {
  expect(ROOMS.map(room => room.id)).toEqual([...BRIEF_ROOM_IDS]);
  expect(new Set(required.map(test => test.id)).size).toBe(required.length);
  expect(required.filter(test => test.kind === "layout")).toHaveLength(19 * 8 * 4);
  for (const room of BRIEF_ROOM_IDS) {
    for (const state of ["ready", "long"]) expect(required.filter(test => test.room === room && test.kind === "viewport" && test.state === state).map(test => test.width)).toEqual([1024, 1280, 1440, 1920, 800, 390]);
    for (const kind of ["repeat-20", "journey", "keyboard", "screen-reader", "reduced-motion", "zoom-200", "webview", "visual-reference"]) expect(required.some(test => test.room === room && test.kind === kind)).toBe(true);
  }
});

test("unimplemented rooms, missing data states and manual checks cannot disappear or pass", () => {
  for (const room of ["workflow-preview", "workflow-draft"]) {
    const cases = required.filter(test => test.room === room);
    expect(cases.length).toBeGreaterThan(32);
    expect(cases.every(test => !!fixtureBlock(test))).toBe(true);
  }
  expect(fixtureBlock(required.find(test => test.room === "authority" && test.state === "long"))).toContain("No long fixture");
  expect(fixtureBlock(required.find(test => test.kind === "webview"))).toContain("explicit");
});

test("an empty report and a fully successful fixture report both block release", () => {
  const empty = assessReport(newReport(head), head);
  expect(empty.missing).toHaveLength(required.length);
  const fixture = { ...allPassed(), source: "fixture" };
  expect(assessReport(fixture, head).releaseReady).toBe(false);
  expect(assessReport(fixture, head).releaseBlocks).toContain("Fixture evidence does not establish enabled runtime behavior.");
});

test("only complete current runtime evidence with enabled capabilities can pass", () => {
  expect(assessReport(allPassed(), head).releaseReady).toBe(true);
  for (const field of ["enabled", "head", "evidence"] as const) {
    const report = allPassed();
    Object.assign(report.capabilities[0]!, { [field]: field === "enabled" ? false : "" });
    expect(assessReport(report, head).releaseReady).toBe(false);
  }
  const duplicate = allPassed();
  duplicate.capabilities.push(duplicate.capabilities[0]!);
  expect(assessReport(duplicate, head).releaseReady).toBe(false);
});

test("missing, failed, blocked, skipped, duplicate and unknown cases cannot pass", () => {
  for (const status of ["failed", "blocked", "skipped"]) {
    const report = allPassed();
    Object.assign(report.cases[0]!, { status, reason: "Required capability unavailable" });
    expect(assessReport(report, head).releaseReady).toBe(false);
  }
  const missing = allPassed(); missing.cases.pop();
  expect(assessReport(missing, head).missing).toHaveLength(1);
  const duplicate = allPassed(); duplicate.cases.push(duplicate.cases[0]!);
  expect(assessReport(duplicate, head).errors.some(error => error.includes("Duplicate"))).toBe(true);
  const unknown = allPassed(); unknown.cases.push({ id: "invented", status: "passed", evidence: ["file.json"] });
  expect(assessReport(unknown, head).releaseReady).toBe(false);
});

test("evidence needs a known schema, exact revision, capture time and artifact paths", () => {
  for (const invalid of [{ schema: "unknown" }, { head: "b".repeat(40) }, { capturedAt: "invalid" }]) expect(assessReport({ ...allPassed(), ...invalid }, head).releaseReady).toBe(false);
  for (const evidence of [[], [""], ["   "]]) {
    const report = allPassed(); report.cases[0]!.evidence = evidence;
    expect(assessReport(report, head).releaseReady).toBe(false);
  }
  expect(assessReport(allPassed(), "short-sha").releaseReady).toBe(false);
});

test("completion retains failures and explicitly blocks every unexecuted case", () => {
  const partial = newReport(head);
  partial.cases.push({ id: required[0]!.id, status: "failed", reason: "Clipped action", evidence: [] });
  const report = completeReport(partial);
  expect(report.cases).toHaveLength(required.length);
  expect(report.cases[0]!.status).toBe("failed");
  expect(assessReport(report, head).blocked).toHaveLength(required.length - 1);
  expect(assessReport(report, head).missing).toEqual([]);
});

const layout = { room: "memory", theme: "light", sidebar: "expanded", chat: false, width: 1440 };
const metrics = { room: "memory", bodyPresent: true, theme: "light", sidebar: "expanded", rail: "false", chat: "false", viewport: { width: 1440 }, busy: false, activeAnimations: 0, pageOverflow: 0, mainOverflow: 0, unnamed: [], roomVisible: true, pebbleLayout: "split" };
test("layout assertions reject placeholders, lost state, loading, overflow, unnamed controls and hidden actions", () => {
  expect(layoutProblems(layout, metrics)).toEqual([]);
  for (const invalid of [{ bodyPresent: false }, { room: "today" }, { theme: "dark" }, { sidebar: "rail" }, { chat: "true" }, { rail: "true" }, { viewport: { width: 1280 } }, { busy: true }, { activeAnimations: -1 }, { activeAnimations: 1 }, { pageOverflow: 10 }, { mainOverflow: 10 }, { unnamed: [{}] }, { roomVisible: false }]) expect(layoutProblems(layout, { ...metrics, ...invalid }).length).toBeGreaterThan(0);
});

test("compact adaptation requires a real single-panel conversation and restores the work on close", () => {
  const compact = { ...layout, width: 390, chat: true };
  const single = { ...metrics, viewport: { width: 390 }, rail: "true", chat: "true", roomVisible: false, pebbleLayout: "single" };
  expect(layoutProblems(compact, single)).toEqual([]);
  expect(layoutProblems({ ...compact, chat: false }, { ...single, chat: "false" })).toContain("Room unexpectedly hidden.");
});

test("an infrastructure failure stops the batch and preserves its failing case", async () => {
  const artifacts: string[] = [], checkpoints: unknown[] = [];
  const rows = await runCases({ tab: {}, viewport: { set() { throw Error("Preview disconnected"); } }, baseUrl: "http://127.0.0.1:4422", cases: required.slice(0, 8), save: async (path: string) => { artifacts.push(path); }, onResult: async (row: unknown) => { checkpoints.push(row); } });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("failed");
  expect(rows[0]!.reason).toContain("Preview disconnected");
  expect(artifacts).toHaveLength(2);
  expect(checkpoints).toEqual(rows);
});

test("the fixture runner refuses an external host before opening any URL", async () => {
  const rows = await runCases({ tab: {}, viewport: { set() {} }, baseUrl: "https://example.com", cases: required.slice(0, 1), save: async () => {} });
  expect(rows[0]!.status).toBe("failed");
  expect(rows[0]!.reason).toContain("loopback");
});

test("CLI verifies real artifacts and rejects missing files, symlinks outside the report, and malformed input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brief-craft-"));
  const path = join(directory, "report.json");
  const verifier = resolve(import.meta.dir, "../../../../scripts/brief-craft/verify.mjs");
  const run = async () => {
    const process = Bun.spawn([Bun.which("bun")!, verifier, path, head], { stdout: "ignore", stderr: "ignore" });
    return process.exited;
  };
  try {
    await writeFile(path, JSON.stringify(allPassed()));
    expect(await run()).toBe(1);
    await writeFile(join(directory, "observation.json"), "{\"observed\":true}");
    await writeFile(join(directory, "capabilities.json"), "{\"enabled\":true}");
    expect(await run()).toBe(0);
    await rm(join(directory, "observation.json"));
    await symlink(verifier, join(directory, "observation.json"));
    expect(await run()).toBe(1);
    await writeFile(path, "invalid json");
    expect(await run()).toBe(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
