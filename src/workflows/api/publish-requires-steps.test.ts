import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../db";
import { getFlow } from "../db/repos/flow";
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
  test("publish refuses with a plain 400 that says to add a step, and changes nothing", async () => {
    const { flowId, versionId } = await freshFlow();
    const result = await call("/api/workflows/:id/publish", "POST", { id: flowId }, {});
    expect(result.status).toBe(400);
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
    expect((await call("/api/workflows/:id/publish", "POST", { id: flowId }, { versionId })).status).toBe(400);
    await call("/api/workflows/:id/versions/:versionId", "PATCH", { id: flowId, versionId },
      { trigger: { name: "trigger", type: "EMPTY", nextAction: { ...STEP, settings: { executionType: "NOPE" } } } });
    expect((await call("/api/workflows/:id/publish", "POST", { id: flowId }, {})).status).toBe(422);
  });

  test("turning it on by PATCH status is refused the same way", async () => {
    const { flowId, versionId } = await freshFlow();
    const result = await call("/api/workflows/:id", "PATCH", { id: flowId }, { status: "ENABLED" });
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("Add at least one step");
    expect(getFlow(flowId)!.status).toBe("DISABLED");
    await withStep(flowId, versionId);
    expect((await call("/api/workflows/:id", "PATCH", { id: flowId }, { status: "ENABLED" })).status).toBe(200);
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
