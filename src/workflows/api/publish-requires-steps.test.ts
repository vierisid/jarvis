import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../db";
import { getFlow, updateFlowStatus } from "../db/repos/flow";
import { graphHasSteps, NO_STEPS_MESSAGE, WorkflowReadinessError } from "../db/repos/flow-readiness";
import { getFlowVersion, getLatestDraft, listVersions } from "../db/repos/flow-version";
import { createWorkflowRoutes, type WorkflowRouteMap } from "./routes";

let routes: WorkflowRouteMap;
beforeEach(() => {
  initWorkflowDb(":memory:");
  routes = createWorkflowRoutes();
});
afterEach(() => closeWorkflowDb());

// The smallest step that needs no piece catalog.
const STEP = { name: "step_1", type: "ROUTER", settings: { executionType: "EXECUTE_FIRST_MATCH", branches: [{ branchType: "FALLBACK", branchName: "Otherwise" }] }, children: [null] };

async function call(path: string, method: "POST" | "PATCH", params: Record<string, string>, body?: unknown) {
  const req = new Request("http://localhost" + path, { method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  }) as Request & { params: Record<string, string> };
  req.params = params;
  const response = await routes[path]![method]!(req);
  return { status: response.status, body: await response.json() as any };
}

async function freshFlow() {
  const created = await call("/api/workflows", "POST", {}, { displayName: "Empty" });
  return { flowId: created.body.flow.id as string, versionId: created.body.version.id as string };
}
const withStep = (flowId: string, versionId: string) =>
  call("/api/workflows/:id/versions/:versionId", "PATCH", { id: flowId, versionId }, { trigger: { name: "trigger", type: "EMPTY", nextAction: STEP } });

describe("a workflow with only a trigger cannot be turned on", () => {
  test("publish refuses with a readiness 422 that says to add a step, and changes nothing", async () => {
    const { flowId, versionId } = await freshFlow();
    const result = await call("/api/workflows/:id/publish", "POST", { id: flowId }, {});
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ code: "WORKFLOW_NOT_READY", ready: false, issues: [{ node: "trigger", path: "graph", code: "NO_STEPS", message: NO_STEPS_MESSAGE }] });
    expect(result.body.error).toContain("no steps");
    expect(result.body.error).toContain("Add at least one step");
    expect(getFlow(flowId)).toMatchObject({ status: "DISABLED", published_version_id: null });
    expect(getFlowVersion(versionId)!.state).toBe("DRAFT");
  });

  test("publish works once a step follows the trigger", async () => {
    const { flowId, versionId } = await freshFlow();
    expect((await withStep(flowId, versionId)).status).toBe(200);
    const result = await call("/api/workflows/:id/publish", "POST", { id: flowId }, {});
    expect(result.status).toBe(200);
    expect(getFlow(flowId)).toMatchObject({ status: "ENABLED", published_version_id: versionId });
  });

  test("an explicit trigger-only version is refused too, and an invalid graph still gets its own refusal", async () => {
    const { flowId, versionId } = await freshFlow();
    const empty = await call("/api/workflows/:id/publish", "POST", { id: flowId }, { versionId });
    expect(empty.status).toBe(422);
    expect(empty.body.issues.map((i: { code: string }) => i.code)).toEqual(["NO_STEPS"]);
    await call("/api/workflows/:id/versions/:versionId", "PATCH", { id: flowId, versionId },
      { trigger: { name: "trigger", type: "EMPTY", nextAction: { ...STEP, settings: { executionType: "NOPE" } } } });
    const broken = await call("/api/workflows/:id/publish", "POST", { id: flowId }, {});
    expect(broken.status).toBe(422);
    expect(broken.body.issues.map((i: { code: string }) => i.code)).not.toContain("NO_STEPS");
  });

  test("turning it on by PATCH status is refused the same way", async () => {
    const { flowId, versionId } = await freshFlow();
    const result = await call("/api/workflows/:id", "PATCH", { id: flowId }, { status: "ENABLED" });
    expect(result.status).toBe(422);
    expect(result.body.issues[0]).toMatchObject({ code: "NO_STEPS" });
    expect(result.body.error).toContain("Add at least one step");
    expect(getFlow(flowId)!.status).toBe("DISABLED");
    await withStep(flowId, versionId);
    expect((await call("/api/workflows/:id", "PATCH", { id: flowId }, { status: "ENABLED" })).status).toBe(200);
  });

  test("the status write with requireSteps refuses, rolls back and leaves the flow off", async () => {
    const { flowId, versionId } = await freshFlow();
    expect(() => updateFlowStatus(flowId, "ENABLED", { requireSteps: true })).toThrow(WorkflowReadinessError);
    expect(getFlow(flowId)!.status).toBe("DISABLED");
    await withStep(flowId, versionId);
    updateFlowStatus(flowId, "ENABLED", { requireSteps: true });
    expect(getFlow(flowId)!.status).toBe("ENABLED");
  });

  test("an already enabled trigger-only workflow can still be turned off", async () => {
    const { flowId } = await freshFlow();
    getWorkflowDb().run("UPDATE flow SET status = 'ENABLED' WHERE id = ?", [flowId]);
    const result = await call("/api/workflows/:id", "PATCH", { id: flowId }, { status: "DISABLED" });
    expect(result.status).toBe(200);
    expect(getFlow(flowId)!.status).toBe("DISABLED");
  });

  test("graphHasSteps reads only an object nextAction as a step", () => {
    expect(graphHasSteps({ type: "EMPTY", nextAction: STEP })).toBe(true);
    for (const g of [null, undefined, "x", [], { type: "EMPTY" }, { nextAction: null }, { nextAction: [] }, { nextAction: "step" }]) {
      expect(graphHasSteps(g)).toBe(false);
    }
  });
});

describe("a version write needs a trigger that is an object", () => {
  const bad: unknown[] = ["str", 5, -9999999999, true, [], ["x"], null];

  for (const trigger of bad) {
    test(`POST version refuses ${JSON.stringify(trigger)} and adds no version`, async () => {
      const { flowId } = await freshFlow();
      const before = listVersions(flowId).length;
      const result = await call("/api/workflows/:id/versions", "POST", { id: flowId }, { displayName: "v2", trigger });
      expect(result.status).toBe(400);
      expect(result.body.error).toContain("trigger must be an object");
      expect(listVersions(flowId).length).toBe(before);
    });

    test(`PATCH version refuses ${JSON.stringify(trigger)} and keeps the stored trigger`, async () => {
      const { flowId, versionId } = await freshFlow();
      const before = getWorkflowDb().query("SELECT trigger, updated FROM flow_version WHERE id = ?").get(versionId);
      const result = await call("/api/workflows/:id/versions/:versionId", "PATCH", { id: flowId, versionId }, { trigger });
      expect(result.status).toBe(400);
      expect(getWorkflowDb().query("SELECT trigger, updated FROM flow_version WHERE id = ?").get(versionId)).toEqual(before as any);
      expect(getLatestDraft(flowId)!.trigger).toMatchObject({ type: "EMPTY" });
    });
  }

  test("a version with no trigger still gets the empty default", async () => {
    const { flowId } = await freshFlow();
    expect((await call("/api/workflows/:id/versions", "POST", { id: flowId }, { displayName: "v2" })).status).toBe(201);
  });
});
