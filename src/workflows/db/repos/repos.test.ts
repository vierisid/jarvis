import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { closeWorkflowDb, DEFAULT_IDS, getWorkflowDb, initWorkflowDb } from "../index";
import { setEncryptionKey } from "../encryption";
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
  replaceSampleData,
  setSampleDataEntry,
  setSampleInputEntry,
  SAMPLE_DATA_AUTO_CAPTURE_MAX_BYTES,
  updateDraftVersion,
} from "./flow-version";
import { FlowVersionRequestError } from "./flow-version-ownership";
import { createFlowRun, getFlowRun, listRuns, updateRun } from "./flow-run";
import {
  deleteConnection,
  deleteConnectionInProject,
  getConnection,
  getConnectionByExternalId,
  getConnectionInProject,
  listConnections,
  updateConnectionById,
  upsertConnection,
} from "./app-connection";

// Pin the connection-encryption key: without it the module resolves the
// developer's real key file (and generates one into their live data dir).
beforeEach(() => {
  initWorkflowDb(":memory:");
  setEncryptionKey(Buffer.alloc(32, 0x11));
});

afterEach(() => {
  closeWorkflowDb();
  setEncryptionKey(null);
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
    const version = lockVersion(createDraftVersion({ flowId: flow.id, displayName: "Published", trigger: { name: "trigger", type: "EMPTY" } }).id);
    setPublishedVersion(flow.id, version.id);
    updateFlowStatus(flow.id, "ENABLED");
    const got = getFlow(flow.id);
    expect(got?.status).toBe("ENABLED");
    expect(got?.published_version_id).toBe(version.id);
  });

  test("metadata round-trips through JSON column", () => {
    const flow = createFlow({ metadata: { tag: "morning", priority: 3 } });
    expect(parseFlowMetadata(flow)).toEqual({ tag: "morning", priority: 3 });
    updateFlowMetadata(flow.id, { tag: "evening", priority: 1 });
    const got = getFlow(flow.id);
    expect(got && parseFlowMetadata(got)).toEqual({ tag: "evening", priority: 1 });
  });

  /**
   * #598. The column reaches a chat prompt through `manage_workflow`'s
   * `summarizeFlow`, the dashboard through the API's `serializeFlow`, and the
   * vendored engine through the sandbox API -- and all three treat it as an
   * object. The HTTP routes refuse a non-object, which is where a caller gets a
   * useful 400; these are the sink-level backstop and the defensive read, so a
   * future writer cannot reintroduce the problem one layer below the validation.
   */
  test("both write sinks refuse a metadata that is not an object", () => {
    // `createFlow` is a sink too, not just `updateFlowMetadata`: a restore path
    // or an eval harness reaches for it directly.
    expect(() => createFlow({ metadata: "just text" as never })).toThrow(/must be a JSON object or null/);
    expect(() => createFlow({ metadata: [1, 2] as never })).toThrow(/must be a JSON object or null/);
    const flow = createFlow();
    expect(() => updateFlowMetadata(flow.id, "just text" as never)).toThrow(/must be a JSON object or null/);
    expect(() => updateFlowMetadata(flow.id, 7 as never)).toThrow(/must be a JSON object or null/);
    // null still clears, and an object still writes.
    updateFlowMetadata(flow.id, null);
    expect(parseFlowMetadata(getFlow(flow.id)!)).toBeNull();
  });

  /**
   * The rows the defensive read exists for. Because the sinks now refuse a
   * non-object, raw SQL is the only honest way to build the fixture -- which is
   * exactly how a pre-#598 row got there.
   */
  test("a legacy row that is not a JSON object reads back as null, not as a lie", () => {
    const flow = createFlow();
    for (const stored of ['"just text"', "7", "true", "[1,2]", "not json at all", ""]) {
      getWorkflowDb().run(`UPDATE flow SET metadata = ? WHERE id = ?`, [stored, flow.id]);
      // The bare `JSON.parse(...) as Record<string, unknown>` this replaced
      // either threw (unparseable) or handed every reader a non-object in a
      // field they all treat as one.
      expect(parseFlowMetadata(getFlow(flow.id)!)).toBeNull();
    }
    // Still not vacuous: a real object round-trips.
    getWorkflowDb().run(`UPDATE flow SET metadata = ? WHERE id = ?`, ['{"ok":1}', flow.id]);
    expect(parseFlowMetadata(getFlow(flow.id)!)).toEqual({ ok: 1 });
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
      trigger: { name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "schedule", input: { cron_expression: "0 9 * * *" } } },
      valid: true,
      connectionIds: ["conn1", "conn2"],
    });
    expect(updated.valid).toBe(true);
    expect(updated.connectionIds).toEqual(["conn1", "conn2"]);
    expect(updated.trigger).toEqual({ name: "trigger", type: "PIECE_TRIGGER", settings: { pieceName: "schedule", input: { cron_expression: "0 9 * * *" } } });

    const locked = lockVersion(draft.id);
    expect(locked.state).toBe("LOCKED");

    expect(() => updateDraftVersion(draft.id, { displayName: "x" })).toThrow(/LOCKED/);
  });

  // #693: the four DRAFT-only writers refuse a LOCKED version as a 409
  // `FlowVersionRequestError`, which `trapErrors` answers verbatim. A plain
  // Error there read as a 500.
  test("every DRAFT-only writer refuses a LOCKED version with a 409 request error", () => {
    const flow = createFlow();
    const v = createDraftVersion({ flowId: flow.id, displayName: "v" });
    lockVersion(v.id);
    const writers: Array<[string, () => unknown]> = [
      ["updateDraftVersion", () => updateDraftVersion(v.id, { displayName: "x" })],
      ["setSampleDataEntry", () => setSampleDataEntry(v.id, "s", { x: 1 })],
      ["setSampleInputEntry", () => setSampleInputEntry(v.id, "s", { x: 1 })],
      ["replaceSampleData", () => replaceSampleData(v.id, null)],
    ];
    for (const [name, write] of writers) {
      let caught: unknown;
      try {
        write();
      } catch (e) {
        caught = e;
      }
      expect({ name, isRequestError: caught instanceof FlowVersionRequestError }).toEqual({ name, isRequestError: true });
      expect((caught as FlowVersionRequestError).status).toBe(409);
    }
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

  /**
   * #692, at the repo. The route tests stop a foreign id at the route's first
   * read, so they would not notice the scope dropped from either of these.
   */
  describe("the by-id writers are scoped to a project (#692)", () => {
    const A = "proj_a_692";
    const B = "proj_b_692";
    function seedInB() {
      return upsertConnection({
        projectId: B,
        externalId: "scoped",
        displayName: "In B",
        type: "SECRET_TEXT",
        pieceName: "http",
        pieceVersion: "1.0.0",
        value: { secret: "b" },
      });
    }
    const stored = (id: string) =>
      getWorkflowDb().query<Record<string, unknown>, [string]>("SELECT * FROM app_connection WHERE id = ?").get(id);

    test("another project sees nothing, and changes nothing", () => {
      const c = seedInB();
      const before = stored(c.id);
      expect(getConnectionInProject(A, c.id)).toBeNull();
      expect(updateConnectionById(A, c.id, { displayName: "x", value: { secret: "a" }, status: "ERROR" })).toBeNull();
      expect(deleteConnectionInProject(A, c.id)).toBe(false);
      expect(stored(c.id)).toEqual(before);
    });

    test("its own project reads, updates and deletes it", () => {
      const c = seedInB();
      expect(getConnectionInProject(B, c.id)?.value).toEqual({ secret: "b" });
      expect(updateConnectionById(B, c.id, { value: { secret: "b2" } })?.value).toEqual({ secret: "b2" });
      expect(deleteConnectionInProject(B, c.id)).toBe(true);
      expect(stored(c.id)).toBeNull();
    });
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
