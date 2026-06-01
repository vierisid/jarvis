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
import { createFlowRun } from "../db/repos/flow-run";

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

  test("throws MISSING_REF when neither flowId nor flowName is given", async () => {
    let caught: unknown;
    try {
      await adapter.start({});
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
});
