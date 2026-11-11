import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../db";
import { createFlow, updateFlowStatus } from "../db/repos/flow";
import { createDraftVersion, getFlowVersion } from "../db/repos/flow-version";
import { upsertFlowVersionUiMeta } from "../db/repos/flow-version-ui-meta";
import { publishFlowVersion } from "../db/repos/flow-publication";
import { createFlowRun } from "../db/repos/flow-run";
import { configureWorkflowReadiness } from "../db/repos/flow-readiness";
import { PieceCatalog } from "../runtime/piece-catalog";
import { CredentialResolver } from "../credentials/adapter";
import { createWorkflowRoutes, type WorkflowRouteMap } from "./routes";

let routes: WorkflowRouteMap;
beforeEach(() => {
  initWorkflowDb(":memory:");
  configureWorkflowReadiness({
    pieces: new PieceCatalog([{ name: "@activepieces/piece-delay", displayName: "Delay", description: "",
      actions: { delayFor: { name: "delayFor", displayName: "Delay for", description: "" } } }] as never),
    credentials: new CredentialResolver(), tool: () => null, machines: () => [], localTools: () => true,
  });
  routes = createWorkflowRoutes({ triggerManager: { refresh: async () => {} } as never });
});
afterEach(() => closeWorkflowDb());

const graph = (extra: Record<string, unknown> = {}) => ({ name: "trigger", type: "EMPTY", ...extra });
const withStep = () => graph({ nextAction: { name: "wait", displayName: "Wait", type: "PIECE", settings: { pieceName: "@activepieces/piece-delay", actionName: "delayFor", input: {} } } });

async function call(route: string, method: string, params: Record<string, string>, body?: unknown) {
  const req = Object.assign(new Request("http://x/", { method, ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) }), { params });
  const res = await (routes[route] as Record<string, (r: Request) => Promise<Response>>)[method]!(req);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const post = (id: string, body: unknown) => call("/api/workflows/:id/versions", "POST", { id }, body);
const patch = (id: string, versionId: string, body: unknown) => call("/api/workflows/:id/versions/:versionId", "PATCH", { id, versionId }, body);

describe("a new draft starts as a copy of the latest version", () => {
  test("a name alone gives the same steps and layout, and no name keeps the workflow's name", async () => {
    const flow = createFlow({});
    const v1 = createDraftVersion({ flowId: flow.id, displayName: "Weekly digest", trigger: withStep() as never });
    upsertFlowVersionUiMeta(v1.id, { schema: 1, positions: { wait: { x: 10, y: 20 } }, orphans: [] });
    publishFlowVersion(flow.id);
    const named = await post(flow.id, { displayName: "Weekly digest v2" });
    expect(named.status).toBe(201);
    expect(named.body.trigger).toEqual(withStep());
    expect(named.body.uiMeta.positions).toEqual({ wait: { x: 10, y: 20 } });
    const unnamed = await post(flow.id, {});
    expect(unnamed.status).toBe(201);
    expect(unnamed.body.displayName).toBe("Weekly digest v2");
    expect(unnamed.body.trigger).toEqual(withStep());
  });

  test("a trigger the caller sends is used as sent, and a flow with no version still needs a name", async () => {
    const flow = createFlow({});
    expect((await post(flow.id, {})).status).toBe(400);
    createDraftVersion({ flowId: flow.id, displayName: "A", trigger: withStep() as never });
    const own = await post(flow.id, { displayName: "B", trigger: graph() });
    expect(own.body.trigger).toEqual(graph());
  });
});

describe("a draft's graph is checked when it is saved", () => {
  test.each([
    ["a string", "just a string", "not a Jarvis workflow"],
    ["a list", [1, 2], "not a Jarvis workflow"],
    ["a number", 7, "not a Jarvis workflow"],
    ["an object with no step type", { hello: "world" }, "not a Jarvis workflow"],
    ["an n8n export", { name: "My n8n", nodes: [{ id: "1", type: "n8n-nodes-base.start" }], connections: {} }, "workflow file from n8n"],
  ])("%s is refused in plain words", async (_label, trigger, words) => {
    const flow = createFlow({});
    const draft = createDraftVersion({ flowId: flow.id, displayName: "Draft", trigger: graph() as never });
    const saved = await patch(flow.id, draft.id, { trigger });
    expect(saved.status).toBe(400);
    expect(saved.body.error).toContain(words);
    expect(getFlowVersion(draft.id)!.trigger).toEqual(graph());
    expect((await post(flow.id, { displayName: "Another", trigger })).status).toBe(400);
  });

  test("more than 100 steps is refused with the limit; exactly 100 is saved", async () => {
    const flow = createFlow({});
    const draft = createDraftVersion({ flowId: flow.id, displayName: "Draft", trigger: graph() as never });
    const chain = (count: number) => { let node: any = undefined; for (let i = count; i >= 1; i--) node = { name: `s${i}`, type: "PIECE", settings: { pieceName: "@activepieces/piece-delay", actionName: "delayFor", input: {} }, ...(node ? { nextAction: node } : {}) }; return graph({ nextAction: node }); };
    const tooBig = await patch(flow.id, draft.id, { trigger: chain(3000) });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error).toContain("more than 100 steps");
    expect((await patch(flow.id, draft.id, { trigger: chain(99) })).status).toBe(200);
  });

  test("an empty draft, a normal graph and a rename still save, and an already saved odd draft still loads", async () => {
    const flow = createFlow({});
    const draft = createDraftVersion({ flowId: flow.id, displayName: "Draft", trigger: graph() as never });
    expect((await patch(flow.id, draft.id, { trigger: {} })).status).toBe(200);
    expect((await patch(flow.id, draft.id, { trigger: withStep(), displayName: "Renamed" })).status).toBe(200);
    getWorkflowDb().run("UPDATE flow_version SET trigger = ? WHERE id = ?", [JSON.stringify("old garbage"), draft.id]);
    const loaded = await call("/api/workflows/:id/versions/:versionId", "GET", { id: flow.id, versionId: draft.id });
    expect(loaded.status).toBe(200);
    expect(loaded.body.trigger).toBe("old garbage");
  });
});

describe("the workflow keeps its name across versions", () => {
  test("publishing an older version brings back its steps but not its old name", async () => {
    const flow = createFlow({});
    const v1 = createDraftVersion({ flowId: flow.id, displayName: "First name", trigger: withStep() as never });
    publishFlowVersion(flow.id);
    const v2 = (await patch(flow.id, (await post(flow.id, { displayName: "Renamed once" })).body.id, { displayName: "Renamed once" })).body;
    publishFlowVersion(flow.id, v2.id);
    expect(((await call("/api/workflows", "GET", {})).body as unknown as Array<{ displayName: string }>)[0]!.displayName).toBe("Renamed once");
    publishFlowVersion(flow.id, v1.id);
    expect(((await call("/api/workflows", "GET", {})).body as unknown as Array<{ displayName: string }>)[0]!.displayName).toBe("Renamed once");
    expect(getFlowVersion(v1.id)!.state).toBe("LOCKED");
  });
});

describe("a draft that cannot be opened can be discarded", () => {
  const discard = (id: string, versionId: string) => call("/api/workflows/:id/versions/:versionId/discard", "POST", { id, versionId });

  test("a draft is thrown away and the published version stays", async () => {
    const flow = createFlow({});
    const v1 = createDraftVersion({ flowId: flow.id, displayName: "Live", trigger: withStep() as never });
    publishFlowVersion(flow.id);
    const draft = (await post(flow.id, { displayName: "Broken" })).body;
    const done = await discard(flow.id, draft.id);
    expect(done.status).toBe(200);
    expect(getFlowVersion(draft.id)).toBeNull();
    expect(getFlowVersion(v1.id)).not.toBeNull();
  });

  test("a published or locked version, a draft with runs, and the draft a turned-on flow runs are kept", async () => {
    const flow = createFlow({});
    const v1 = createDraftVersion({ flowId: flow.id, displayName: "Live", trigger: withStep() as never });
    publishFlowVersion(flow.id);
    expect((await discard(flow.id, v1.id)).status).toBe(409);
    const withRuns = (await post(flow.id, { displayName: "Has runs" })).body;
    createFlowRun({ flowId: flow.id, flowVersionId: withRuns.id, status: "SUCCEEDED" });
    const kept = await discard(flow.id, withRuns.id);
    expect(kept.status).toBe(409);
    expect(kept.body.error).toContain("runs");
    expect(getFlowVersion(withRuns.id)).not.toBeNull();

    const live = createFlow({});
    const draft = createDraftVersion({ flowId: live.id, displayName: "Only draft", trigger: withStep() as never });
    updateFlowStatus(live.id, "ENABLED");
    const refused = await discard(live.id, draft.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Turn the workflow off first");
  });

  test("another workflow's version is not found", async () => {
    const a = createFlow({}), b = createFlow({});
    const draft = createDraftVersion({ flowId: a.id, displayName: "A", trigger: graph() as never });
    expect((await discard(b.id, draft.id)).status).toBeGreaterThanOrEqual(400);
    expect(getFlowVersion(draft.id)).not.toBeNull();
  });
});
