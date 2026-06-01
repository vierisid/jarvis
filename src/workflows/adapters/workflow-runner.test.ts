/**
 * Tests for `JarvisWorkflowRunnerAdapter`.
 *
 * Focus is on the new typed-error surface (FLOW_NOT_FOUND,
 * SELF_RECURSION, VERSION_MISSING, MISSING_REF) and the
 * caller-runId-driven self-recursion guard. The happy path is
 * exercised end-to-end by the sandbox-api tests + the engine tests;
 * here we cover the error matrix directly so the route's status
 * mapping has something to map against.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JarvisWorkflowRunnerAdapter, WorkflowRunnerError } from "./workflow-runner";
import { closeWorkflowDb, initWorkflowDb } from "../db";
import { createFlow } from "../db/repos/flow";
import { createDraftVersion } from "../db/repos/flow-version";
import { createFlowRun, getFlowRun } from "../db/repos/flow-run";

const PROJECT_ID = "proj_x";

describe("JarvisWorkflowRunnerAdapter", () => {
  let adapter: JarvisWorkflowRunnerAdapter;

  beforeEach(() => {
    initWorkflowDb(":memory:");
    adapter = new JarvisWorkflowRunnerAdapter();
  });

  afterEach(() => {
    closeWorkflowDb();
  });

  test("throws MISSING_REF when flowId is empty", async () => {
    let caught: unknown;
    try {
      await adapter.start({ flowId: "" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkflowRunnerError);
    expect((caught as WorkflowRunnerError).code).toBe("MISSING_REF");
  });

  test("throws FLOW_NOT_FOUND for an unknown flowId", async () => {
    let caught: unknown;
    try {
      await adapter.start({ flowId: "flow_nonexistent" });
    } catch (e) {
      caught = e;
    }
    expect((caught as WorkflowRunnerError).code).toBe("FLOW_NOT_FOUND");
  });

  test("throws VERSION_MISSING when the flow exists but has no version", async () => {
    const flow = createFlow({ projectId: PROJECT_ID });
    let caught: unknown;
    try {
      await adapter.start({ flowId: flow.id });
    } catch (e) {
      caught = e;
    }
    expect((caught as WorkflowRunnerError).code).toBe("VERSION_MISSING");
  });

  test("refuses self-recursion when callerRunId points at the same flow", async () => {
    // Same-flow caller: a run_workflow step inside flow A targets flow A.
    const flow = createFlow({ projectId: PROJECT_ID });
    const version = createDraftVersion({
      flowId: flow.id,
      displayName: "A",
      trigger: { name: "trigger", type: "EMPTY", settings: {} },
    });
    const callerRun = createFlowRun({
      flowId: flow.id,
      flowVersionId: version.id,
      triggeredBy: "test",
      startTime: Date.now(),
    });
    let caught: unknown;
    try {
      await adapter.start({ flowId: flow.id }, callerRun.id);
    } catch (e) {
      caught = e;
    }
    expect((caught as WorkflowRunnerError).code).toBe("SELF_RECURSION");
  });

  test("allows starting a DIFFERENT flow even when callerRunId is set", async () => {
    // Cross-flow caller: run_workflow inside flow A starts flow B.
    const flowA = createFlow({ projectId: PROJECT_ID });
    const flowB = createFlow({ projectId: PROJECT_ID });
    const versionA = createDraftVersion({
      flowId: flowA.id,
      displayName: "A",
      trigger: { name: "trigger", type: "EMPTY", settings: {} },
    });
    createDraftVersion({
      flowId: flowB.id,
      displayName: "B",
      trigger: { name: "trigger", type: "EMPTY", settings: {} },
    });
    const callerRun = createFlowRun({
      flowId: flowA.id,
      flowVersionId: versionA.id,
      triggeredBy: "test",
      startTime: Date.now(),
    });
    // Should NOT throw; should return a new run id.
    const out = await adapter.start({ flowId: flowB.id }, callerRun.id);
    expect(typeof out.runId).toBe("string");
    expect(out.runId.length).toBeGreaterThan(0);
  });

  test("refuses indirect cycles by walking the parent-run chain (A -> B -> A)", async () => {
    // Build the chain: a top-level run of flow A, then a child run of
    // flow B whose parent is A. Asking the adapter to start flow A
    // again from B's run should detect A in B's ancestry and refuse.
    const flowA = createFlow({ projectId: PROJECT_ID });
    const flowB = createFlow({ projectId: PROJECT_ID });
    const versionA = createDraftVersion({
      flowId: flowA.id,
      displayName: "A",
      trigger: { name: "trigger", type: "EMPTY", settings: {} },
    });
    const versionB = createDraftVersion({
      flowId: flowB.id,
      displayName: "B",
      trigger: { name: "trigger", type: "EMPTY", settings: {} },
    });
    const aRun = createFlowRun({
      flowId: flowA.id,
      flowVersionId: versionA.id,
      triggeredBy: "test",
      startTime: Date.now(),
    });
    const bRun = createFlowRun({
      flowId: flowB.id,
      flowVersionId: versionB.id,
      triggeredBy: "workflow:run_workflow",
      startTime: Date.now(),
      parentRunId: aRun.id,
    });
    let caught: unknown;
    try {
      await adapter.start({ flowId: flowA.id }, bRun.id);
    } catch (e) {
      caught = e;
    }
    expect((caught as WorkflowRunnerError).code).toBe("SELF_RECURSION");
    // The message should call out the depth so a reader knows it
    // was the indirect path that caught (not the trivial direct case).
    expect((caught as Error).message).toMatch(/level/);
  });

  test("persists parentRunId on the new run so the chain stays connected for future firings", async () => {
    // Cross-flow caller (A -> B). After the adapter starts B's run,
    // reading the new run back from the repo must show parentRunId
    // pointing at A's run. Without this the cycle walk above would
    // see every nested run as a fresh top-level run.
    const flowA = createFlow({ projectId: PROJECT_ID });
    const flowB = createFlow({ projectId: PROJECT_ID });
    const versionA = createDraftVersion({
      flowId: flowA.id,
      displayName: "A",
      trigger: { name: "trigger", type: "EMPTY", settings: {} },
    });
    createDraftVersion({
      flowId: flowB.id,
      displayName: "B",
      trigger: { name: "trigger", type: "EMPTY", settings: {} },
    });
    const aRun = createFlowRun({
      flowId: flowA.id,
      flowVersionId: versionA.id,
      triggeredBy: "test",
      startTime: Date.now(),
    });
    const out = await adapter.start({ flowId: flowB.id }, aRun.id);
    const child = getFlowRun(out.runId);
    expect(child?.parentRunId).toBe(aRun.id);
  });

  test("malformed back-edge in the chain (X -> Y -> X with no shared flow) terminates without false-positive", async () => {
    // Two runs whose parent pointers form a loop, neither matching
    // the target flow. The visited-set break must terminate the
    // walk; the absolute depth cap would also terminate but would
    // waste 64 lookups on every call. Either way: no false-positive
    // SELF_RECURSION, no hang.
    const loopFlow = createFlow({ projectId: PROJECT_ID });
    const targetFlow = createFlow({ projectId: PROJECT_ID });
    const loopVersion = createDraftVersion({
      flowId: loopFlow.id,
      displayName: "loop",
      trigger: { name: "trigger", type: "EMPTY", settings: {} },
    });
    createDraftVersion({
      flowId: targetFlow.id,
      displayName: "target",
      trigger: { name: "trigger", type: "EMPTY", settings: {} },
    });
    // Y first (no parent yet), then X with parent=Y, then patch Y's
    // parent to X via a raw SQL update -- the repos don't expose a
    // setter for this, and the only realistic shape we're defending
    // against is a corrupted row anyway.
    const yRun = createFlowRun({
      flowId: loopFlow.id,
      flowVersionId: loopVersion.id,
      triggeredBy: "test",
      startTime: Date.now(),
    });
    const xRun = createFlowRun({
      flowId: loopFlow.id,
      flowVersionId: loopVersion.id,
      triggeredBy: "test",
      startTime: Date.now(),
      parentRunId: yRun.id,
    });
    const { getWorkflowDb } = await import("../db");
    getWorkflowDb()
      .query("UPDATE flow_run SET parent_run_id = ? WHERE id = ?")
      .run(xRun.id, yRun.id);
    const out = await adapter.start({ flowId: targetFlow.id }, xRun.id);
    expect(typeof out.runId).toBe("string");
    expect(out.runId.length).toBeGreaterThan(0);
  });

  test("malformed chain (parent points at a deleted run) breaks the walk without throwing", async () => {
    // Worst-case shape: caller's parentRunId references a run that no
    // longer exists in the DB. `getFlowRun(...)` returns null; the
    // walk's `if (!ancestor) break` exits cleanly, and the target
    // flow starts normally because no ancestor matched.
    const flowA = createFlow({ projectId: PROJECT_ID });
    const flowB = createFlow({ projectId: PROJECT_ID });
    const versionA = createDraftVersion({
      flowId: flowA.id,
      displayName: "A",
      trigger: { name: "trigger", type: "EMPTY", settings: {} },
    });
    createDraftVersion({
      flowId: flowB.id,
      displayName: "B",
      trigger: { name: "trigger", type: "EMPTY", settings: {} },
    });
    // Caller's parentRunId references a run id that was never
    // created (or was deleted between firing the trigger and now).
    const orphanCaller = createFlowRun({
      flowId: flowA.id,
      flowVersionId: versionA.id,
      triggeredBy: "test",
      startTime: Date.now(),
      parentRunId: "run_deleted_long_ago",
    });
    // Should NOT throw; should return a new run id.
    const out = await adapter.start({ flowId: flowB.id }, orphanCaller.id);
    expect(typeof out.runId).toBe("string");
    expect(out.runId.length).toBeGreaterThan(0);
  });
});
