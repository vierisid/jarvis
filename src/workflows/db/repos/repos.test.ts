import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { closeWorkflowDb, DEFAULT_IDS, initWorkflowDb } from "../index";
import {
  createFlow,
  deleteFlow,
  getFlow,
  listFlows,
  parseFlowMetadata,
  setPublishedVersion,
  updateFlowMetadata,
  updateFlowStatus,
} from "./flow";
import {
  createDraftVersion,
  getFlowVersion,
  getLatestDraft,
  listVersions,
  lockVersion,
  mergeRunOutputsIntoSampleData,
  setSampleDataEntry,
  SAMPLE_DATA_AUTO_CAPTURE_MAX_BYTES,
  updateDraftVersion,
} from "./flow-version";
import { createFlowRun, getFlowRun, listRuns, updateRun } from "./flow-run";
import {
  deleteConnection,
  getConnection,
  getConnectionByExternalId,
  listConnections,
  upsertConnection,
} from "./app-connection";

beforeEach(() => {
  initWorkflowDb(":memory:");
});

afterEach(() => {
  closeWorkflowDb();
});

describe("flow repo", () => {
  test("createFlow uses the default project and creates a DISABLED flow", () => {
    const flow = createFlow();
    expect(flow.project_id).toBe(DEFAULT_IDS.project);
    expect(flow.status).toBe("DISABLED");
    expect(flow.id.length).toBe(21);
  });

  test("listFlows orders by updated DESC and respects status filter", async () => {
    const a = createFlow();
    await Bun.sleep(2);
    const b = createFlow({ status: "ENABLED" });
    const all = listFlows();
    expect(all[0]?.id).toBe(b.id);
    expect(all[1]?.id).toBe(a.id);
    const enabled = listFlows(DEFAULT_IDS.project, { status: "ENABLED" });
    expect(enabled.map((f) => f.id)).toEqual([b.id]);
  });

  test("updateFlowStatus and setPublishedVersion mutate fields", () => {
    const flow = createFlow();
    updateFlowStatus(flow.id, "ENABLED");
    setPublishedVersion(flow.id, "fv_xyz");
    const got = getFlow(flow.id);
    expect(got?.status).toBe("ENABLED");
    expect(got?.published_version_id).toBe("fv_xyz");
  });

  test("metadata round-trips through JSON column", () => {
    const flow = createFlow({ metadata: { tag: "morning", priority: 3 } });
    expect(parseFlowMetadata(flow)).toEqual({ tag: "morning", priority: 3 });
    updateFlowMetadata(flow.id, { tag: "evening", priority: 1 });
    const got = getFlow(flow.id);
    expect(got && parseFlowMetadata(got)).toEqual({ tag: "evening", priority: 1 });
  });

  test("deleteFlow removes the row", () => {
    const flow = createFlow();
    deleteFlow(flow.id);
    expect(getFlow(flow.id)).toBeNull();
  });

  test("missing-id mutators throw", () => {
    expect(() => updateFlowStatus("nope", "ENABLED")).toThrow(/not found/);
    expect(() => setPublishedVersion("nope", null)).toThrow(/not found/);
    expect(() => updateFlowMetadata("nope", null)).toThrow(/not found/);
  });
});

describe("flow-version repo", () => {
  test("draft -> update -> lock lifecycle", () => {
    const flow = createFlow();
    const draft = createDraftVersion({
      flowId: flow.id,
      displayName: "v1",
      trigger: { name: "trigger", type: "EMPTY" },
    });
    expect(draft.state).toBe("DRAFT");
    expect(draft.valid).toBe(false);
    expect(draft.trigger).toEqual({ name: "trigger", type: "EMPTY" });

    const updated = updateDraftVersion(draft.id, {
      trigger: { name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "schedule" } },
      valid: true,
      connectionIds: ["conn1", "conn2"],
    });
    expect(updated.valid).toBe(true);
    expect(updated.connectionIds).toEqual(["conn1", "conn2"]);
    expect(updated.trigger).toEqual({ name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "schedule" } });

    const locked = lockVersion(draft.id);
    expect(locked.state).toBe("LOCKED");

    expect(() => updateDraftVersion(draft.id, { displayName: "x" })).toThrow(/LOCKED/);
  });

  test("getLatestDraft returns the most recently updated DRAFT only", async () => {
    const flow = createFlow();
    const v1 = createDraftVersion({ flowId: flow.id, displayName: "v1" });
    await Bun.sleep(2);
    const v2 = createDraftVersion({ flowId: flow.id, displayName: "v2" });
    expect(getLatestDraft(flow.id)?.id).toBe(v2.id);

    lockVersion(v2.id);
    expect(getLatestDraft(flow.id)?.id).toBe(v1.id);
  });

  test("listVersions returns all states ordered desc", async () => {
    const flow = createFlow();
    const v1 = createDraftVersion({ flowId: flow.id, displayName: "v1" });
    await Bun.sleep(2);
    const v2 = createDraftVersion({ flowId: flow.id, displayName: "v2" });
    const all = listVersions(flow.id);
    expect(all.map((v) => v.id)).toEqual([v2.id, v1.id]);
  });

  test("getFlowVersion returns null for unknown id", () => {
    expect(getFlowVersion("nope")).toBeNull();
  });
});

describe("flow-run repo", () => {
  test("createFlowRun defaults: PRODUCTION/QUEUED, default project", () => {
    const flow = createFlow();
    const v = createDraftVersion({ flowId: flow.id, displayName: "v1" });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: v.id });
    expect(run.environment).toBe("PRODUCTION");
    expect(run.status).toBe("QUEUED");
    expect(run.projectId).toBe(DEFAULT_IDS.project);
    expect(run.steps).toBeNull();
  });

  test("updateRun applies status, steps, failed_step, finishTime", () => {
    const flow = createFlow();
    const v = createDraftVersion({ flowId: flow.id, displayName: "v1" });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: v.id, status: "RUNNING" });
    const updated = updateRun(run.id, {
      status: "FAILED",
      steps: { step1: { status: "SUCCEEDED" }, step2: { status: "FAILED", error: "boom" } },
      failedStep: { name: "step2", displayName: "Step 2" },
      finishTime: 12345,
      stepsCount: 2,
    });
    expect(updated.status).toBe("FAILED");
    expect(updated.steps).toEqual({
      step1: { status: "SUCCEEDED" },
      step2: { status: "FAILED", error: "boom" },
    });
    expect(updated.failedStep).toEqual({ name: "step2", displayName: "Step 2" });
    expect(updated.finishTime).toBe(12345);
    expect(updated.stepsCount).toBe(2);
  });

  test("listRuns filters by flowId and status", async () => {
    const flow1 = createFlow();
    const flow2 = createFlow();
    const v1 = createDraftVersion({ flowId: flow1.id, displayName: "v1" });
    const v2 = createDraftVersion({ flowId: flow2.id, displayName: "v2" });
    createFlowRun({ flowId: flow1.id, flowVersionId: v1.id, status: "SUCCEEDED" });
    await Bun.sleep(2);
    createFlowRun({ flowId: flow1.id, flowVersionId: v1.id, status: "FAILED" });
    await Bun.sleep(2);
    createFlowRun({ flowId: flow2.id, flowVersionId: v2.id, status: "SUCCEEDED" });

    expect(listRuns().length).toBe(3);
    expect(listRuns({ flowId: flow1.id }).length).toBe(2);
    expect(listRuns({ flowId: flow1.id, status: "FAILED" }).length).toBe(1);
    expect(listRuns({ status: "SUCCEEDED" }).length).toBe(2);
  });

  test("deleting parent flow cascades runs", () => {
    const flow = createFlow();
    const v = createDraftVersion({ flowId: flow.id, displayName: "v1" });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: v.id });
    deleteFlow(flow.id);
    expect(getFlowRun(run.id)).toBeNull();
  });
});

describe("app-connection repo", () => {
  test("upsert creates then updates by (project, piece, external_id)", () => {
    const created = upsertConnection({
      externalId: "user-gmail",
      displayName: "User Gmail",
      type: "OAUTH2",
      pieceName: "gmail",
      pieceVersion: "1.0.0",
      value: { access_token: "abc" },
    });
    expect(created.value).toEqual({ access_token: "abc" });

    const updated = upsertConnection({
      externalId: "user-gmail",
      displayName: "User Gmail (refreshed)",
      type: "OAUTH2",
      pieceName: "gmail",
      pieceVersion: "1.0.0",
      value: { access_token: "xyz" },
    });
    expect(updated.id).toBe(created.id);
    expect(updated.displayName).toBe("User Gmail (refreshed)");
    expect(updated.value).toEqual({ access_token: "xyz" });
  });

  test("getConnectionByExternalId scopes to (project, piece)", () => {
    upsertConnection({
      externalId: "shared-key",
      displayName: "Slack token",
      type: "SECRET_TEXT",
      pieceName: "slack",
      pieceVersion: "1.0.0",
      value: { secret_text: "s1" },
    });
    upsertConnection({
      externalId: "shared-key",
      displayName: "Discord token",
      type: "SECRET_TEXT",
      pieceName: "discord",
      pieceVersion: "1.0.0",
      value: { secret_text: "d1" },
    });
    const slack = getConnectionByExternalId(DEFAULT_IDS.project, "slack", "shared-key");
    const discord = getConnectionByExternalId(DEFAULT_IDS.project, "discord", "shared-key");
    expect(slack?.value).toEqual({ secret_text: "s1" });
    expect(discord?.value).toEqual({ secret_text: "d1" });
  });

  test("listConnections supports optional pieceName filter", () => {
    upsertConnection({
      externalId: "g1",
      displayName: "g1",
      type: "OAUTH2",
      pieceName: "gmail",
      pieceVersion: "1.0.0",
      value: {},
    });
    upsertConnection({
      externalId: "s1",
      displayName: "s1",
      type: "OAUTH2",
      pieceName: "slack",
      pieceVersion: "1.0.0",
      value: {},
    });
    expect(listConnections().length).toBe(2);
    expect(listConnections(DEFAULT_IDS.project, "gmail").length).toBe(1);
    expect(listConnections(DEFAULT_IDS.project, "gmail")[0]?.externalId).toBe("g1");
  });

  test("deleteConnection removes by id", () => {
    const c = upsertConnection({
      externalId: "x",
      displayName: "x",
      type: "NO_AUTH",
      pieceName: "http",
      pieceVersion: "1.0.0",
      value: {},
    });
    deleteConnection(c.id);
    expect(getConnection(c.id)).toBeNull();
  });
});

describe("mergeRunOutputsIntoSampleData (auto-capture)", () => {
  // Helper: create a flow + DRAFT version we can capture outputs into.
  function newDraft(): string {
    const f = createFlow();
    const v = createDraftVersion({
      flowId: f.id,
      displayName: "auto-capture-test",
      trigger: { name: "trigger", type: "EMPTY", displayName: "Manual" },
    });
    return v.id;
  }

  test("writes object outputs into empty cells", () => {
    const versionId = newDraft();
    const { written, skipped } = mergeRunOutputsIntoSampleData(versionId, {
      step_1: { output: { id: 42, name: "alice" } },
      step_2: { output: { ok: true } },
    });
    expect(written.sort()).toEqual(["step_1", "step_2"]);
    expect(skipped).toEqual([]);
    const v = getFlowVersion(versionId)!;
    expect(v.sampleData?.step_1).toEqual({ id: 42, name: "alice" });
    expect(v.sampleData?.step_2).toEqual({ ok: true });
  });

  test("accepts both wrapped {output} envelopes and bare outputs", () => {
    const versionId = newDraft();
    mergeRunOutputsIntoSampleData(versionId, {
      wrapped: { output: { a: 1 } },
      bare: { b: 2 },
    });
    const v = getFlowVersion(versionId)!;
    expect(v.sampleData?.wrapped).toEqual({ a: 1 });
    expect(v.sampleData?.bare).toEqual({ b: 2 });
  });

  test("does not clobber user-pinned cells", () => {
    const versionId = newDraft();
    setSampleDataEntry(versionId, "step_1", { user: "pinned" });
    const { written, skipped } = mergeRunOutputsIntoSampleData(versionId, {
      step_1: { output: { from: "run" } },
      step_2: { output: { fresh: true } },
    });
    expect(written).toEqual(["step_2"]);
    expect(skipped).toEqual([{ stepName: "step_1", reason: "already populated" }]);
    const v = getFlowVersion(versionId)!;
    expect(v.sampleData?.step_1).toEqual({ user: "pinned" });
    expect(v.sampleData?.step_2).toEqual({ fresh: true });
  });

  test("skips primitives, arrays, and undefined outputs", () => {
    const versionId = newDraft();
    const { written, skipped } = mergeRunOutputsIntoSampleData(versionId, {
      string_step: { output: "hello" },
      number_step: { output: 7 },
      array_step: { output: [1, 2, 3] },
      undef_step: { output: undefined },
    });
    expect(written).toEqual([]);
    expect(skipped.map((s) => s.stepName).sort()).toEqual([
      "array_step",
      "number_step",
      "string_step",
      "undef_step",
    ]);
    for (const s of skipped) expect(s.reason).toBe("output not a plain object");
  });

  test("skips outputs larger than the cap", () => {
    const versionId = newDraft();
    // Build an object whose JSON serializes > cap. A 300KB string field
    // overshoots the 256KB cap comfortably.
    const huge = { blob: "x".repeat(SAMPLE_DATA_AUTO_CAPTURE_MAX_BYTES + 50_000) };
    const { written, skipped } = mergeRunOutputsIntoSampleData(versionId, {
      big_step: { output: huge },
      small_step: { output: { ok: true } },
    });
    expect(written).toEqual(["small_step"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.stepName).toBe("big_step");
    expect(skipped[0]!.reason).toMatch(/exceeds .* cap/);
  });

  test("noop on LOCKED versions", () => {
    const versionId = newDraft();
    lockVersion(versionId);
    const { written, skipped } = mergeRunOutputsIntoSampleData(versionId, {
      step_1: { output: { a: 1 } },
    });
    expect(written).toEqual([]);
    expect(skipped).toEqual([]);
    const v = getFlowVersion(versionId)!;
    expect(v.sampleData).toBeNull();
  });

  test("noop on missing versions", () => {
    const { written, skipped } = mergeRunOutputsIntoSampleData("missing-id", {
      step_1: { output: { a: 1 } },
    });
    expect(written).toEqual([]);
    expect(skipped).toEqual([]);
  });
});
