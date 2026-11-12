import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, DEFAULT_IDS, getWorkflowDb, initWorkflowDb } from "../db";
import { setEncryptionKey } from "../db/encryption";
import { upsertConnection } from "../db/repos/app-connection";
import { pinFlowBindings, recordRunCredentialOutcome, enforceRunConnectionBinding } from "../db/repos/binding-pins";
import { createFlow, updateFlowStatus } from "../db/repos/flow";
import { createDraftVersion } from "../db/repos/flow-version";
import { publishFlowVersion } from "../db/repos/flow-publication";
import { createFlowRun, getFlowRun, updateRun } from "../db/repos/flow-run";
import { configureWorkflowReadiness } from "../db/repos/flow-readiness";
import { PieceCatalog } from "../runtime/piece-catalog";
import { CredentialResolver } from "../credentials/adapter";
import { runFailure } from "../runtime/run-failure";
import { createWorkflowRoutes, type WorkflowRouteMap } from "./routes";

const PIECE = "private-piece";
let routes: WorkflowRouteMap;
let told: Array<{ connectionId: string; message: string; workflows: Array<{ id: string; name: string }> }>;

beforeEach(() => {
  initWorkflowDb(":memory:");
  setEncryptionKey(Buffer.alloc(32, 0x44));
  configureWorkflowReadiness({
    pieces: new PieceCatalog([{ name: PIECE, displayName: "", description: "", auth: { type: "SECRET_TEXT" },
      actions: { send: { name: "send", displayName: "", description: "" } } }] as never),
    credentials: new CredentialResolver(),
    tool: () => null,
    machines: () => [],
    localTools: () => true,
  });
  told = [];
  routes = createWorkflowRoutes({ onConnectionReplaced: (change) => told.push(change) });
});
afterEach(() => {
  setEncryptionKey(null);
  closeWorkflowDb();
});

const connect = (secret: string) => upsertConnection({ externalId: "account", pieceName: PIECE, displayName: "Account", pieceVersion: "1",
  type: "SECRET_TEXT", value: { secret_text: secret } });
const step = { name: "trigger", type: "EMPTY", nextAction: { name: "send_it", displayName: "Send it", type: "PIECE",
  settings: { pieceName: PIECE, actionName: "send", input: { auth: "{{connections['account']}}" } } } } as never;

function enabledFlow(name: string, projectId?: string) {
  const flow = createFlow(projectId ? { projectId } : {});
  const version = createDraftVersion({ flowId: flow.id, displayName: name, trigger: step });
  publishFlowVersion(flow.id);
  updateFlowStatus(flow.id, "ENABLED");
  pinFlowBindings(flow.id);
  return { flowId: flow.id, versionId: version.id };
}

const call = async (route: keyof WorkflowRouteMap, method: "GET" | "PATCH", params: Record<string, string>, body?: unknown) => {
  const req = Object.assign(new Request("http://x/", { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) }), { params });
  const res = await (routes[route] as Record<string, (r: Request) => Promise<Response>>)[method]!(req);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("rotating a key says what it stops", () => {
  test("the Rotate form can list the enabled workflows that run on the connection", async () => {
    const conn = connect("one");
    enabledFlow("Weekly digest");
    enabledFlow("Invoices");
    const impact = await call("/api/workflows/connections/:id/rotation-impact", "GET", { id: conn.id });
    expect(impact.status).toBe(200);
    expect(impact.body.workflows.map((w: { name: string }) => w.name)).toEqual(["Weekly digest", "Invoices"]);
    expect(impact.body.message).toContain("stop running until you publish each one again");
  });

  test("a new key answers with the paused workflows, tells the owner once, and flags each workflow right away", async () => {
    const conn = connect("one");
    const { flowId } = enabledFlow("Weekly digest");
    const listBefore = await call("/api/workflows", "GET", {});
    expect((listBefore.body as unknown as Array<{ blocked: unknown }>)[0]!.blocked).toBeNull();

    const patched = await call("/api/workflows/connections/:id", "PATCH", { id: conn.id }, { value: { secret_text: "two" } });
    expect(patched.status).toBe(200);
    expect(patched.body.pausedWorkflows).toEqual([{ id: flowId, name: "Weekly digest" }]);
    expect(patched.body.notice).toBe('"Weekly digest" uses this connection and is paused until you publish it again to accept the new key.');
    expect(told).toHaveLength(1);
    expect(told[0]!.message).toBe(patched.body.notice);

    const list = (await call("/api/workflows", "GET", {})).body as unknown as Array<{ id: string; blocked: Record<string, unknown> | null }>;
    expect(list[0]!.blocked).toMatchObject({ code: "BINDING_STALE", kind: "readiness", runId: null,
      message: expect.stringContaining("Publish it again to accept the change") });

    // Publishing again is the person accepting the new key.
    pinFlowBindings(flowId);
    const after = (await call("/api/workflows", "GET", {})).body as unknown as Array<{ blocked: unknown }>;
    expect(after[0]!.blocked).toBeNull();
  });

  test("a rename, or the same key again, stops nothing and tells nobody", async () => {
    const conn = connect("one");
    enabledFlow("Weekly digest");
    for (const body of [{ displayName: "Renamed" }, { value: { secret_text: "one" } }]) {
      const patched = await call("/api/workflows/connections/:id", "PATCH", { id: conn.id }, body);
      expect(patched.status).toBe(200);
      expect(patched.body.notice).toBeUndefined();
    }
    expect(told).toHaveLength(0);
  });

  test("a workflow that is turned off is not named", async () => {
    const conn = connect("one");
    const { flowId } = enabledFlow("Weekly digest");
    updateFlowStatus(flowId, "DISABLED");
    const patched = await call("/api/workflows/connections/:id", "PATCH", { id: conn.id }, { value: { secret_text: "two" } });
    expect(patched.body.pausedWorkflows).toBeUndefined();
    expect(told).toHaveLength(0);
  });
});

describe("the rotation list is held to the caller's project and shows names as card text", () => {
  const OTHER = "proj_other_1406";

  test("another project's workflow on the same external id is not named, and its connection is a 404", async () => {
    const conn = connect("one");
    const theirs = upsertConnection({ projectId: OTHER, externalId: "account", pieceName: PIECE, displayName: "Theirs", pieceVersion: "1",
      type: "SECRET_TEXT", value: { secret_text: "x" } });
    enabledFlow("Ours");
    enabledFlow("Theirs", OTHER);
    const impact = await call("/api/workflows/connections/:id/rotation-impact", "GET", { id: conn.id });
    expect(impact.body.workflows.map((w: { name: string }) => w.name)).toEqual(["Ours"]);
    const patched = await call("/api/workflows/connections/:id", "PATCH", { id: conn.id }, { value: { secret_text: "two" } });
    expect(patched.body.pausedWorkflows.map((w: { name: string }) => w.name)).toEqual(["Ours"]);

    expect((await call("/api/workflows/connections/:id/rotation-impact", "GET", { id: theirs.id })).status).toBe(404);
  });

  test("a workflow name cannot add a line, reorder the sentence or close its quotes", async () => {
    const conn = connect("one");
    enabledFlow("Pay\u202Egpj.exe\nrun \"now\"\u0007");
    const impact = await call("/api/workflows/connections/:id/rotation-impact", "GET", { id: conn.id });
    expect(impact.body.message).toStartWith(`"Paygpj.exe run 'now'" uses this connection.`);
  });
});

describe("a run cut off by its connection says why", () => {
  function failedRun(afterBind: (runId: string) => void) {
    connect("canary-old-key");
    const { flowId, versionId } = enabledFlow("Weekly digest");
    const run = createFlowRun({ flowId, flowVersionId: versionId, status: "RUNNING" });
    expect(enforceRunConnectionBinding(run.id, DEFAULT_IDS.project, "account")).toBeNull();
    afterBind(run.id);
    updateRun(run.id, { status: "FAILED", failedStep: { name: "send_it", displayName: "Send it", errorMessage: "Failed to load connection (account)" } });
    return { flowId, runId: run.id };
  }

  test("a key replaced during the run is the failure, not 'this step did nothing'", () => {
    const { runId } = failedRun((id) => {
      connect("canary-new-key");
      // The engine's next fetch is refused and records why.
      expect(enforceRunConnectionBinding(id, DEFAULT_IDS.project, "account")).toContain("was replaced during this run");
    });
    const failure = runFailure(getFlowRun(runId)!)!;
    expect(failure.headline).toContain("The credential stored in connection account was replaced during this run");
    expect(failure.code).toBe("CONNECTION_BINDING_REFUSED");
    expect(failure.next.map((n) => n.step)).toContain("accept_binding_change");
    // The reason names the connection, never the key it held or the new one.
    for (const text of [failure.headline, failure.outcome, JSON.stringify(failure.next)]) {
      expect(text).not.toContain("canary");
    }
  });

  test("a connection removed during the run asks for it to be set up again, not for a publish", () => {
    const { runId } = failedRun((id) => {
      getWorkflowDb().run("DELETE FROM app_connection WHERE external_id = 'account'");
      expect(enforceRunConnectionBinding(id, DEFAULT_IDS.project, "account")).toContain("was removed while this run asked for it");
    });
    const failure = runFailure(getFlowRun(runId)!)!;
    expect(failure.code).toBe("CONNECTION_BINDING_REFUSED");
    expect(failure.next.map((n) => n.step)).toEqual(["connect", "open_details"]);
  });

  test("the run list gives the same advice as the run page for an expired token", async () => {
    const { flowId, runId } = failedRun((id) => {
      recordRunCredentialOutcome(id, "account", { code: "CONNECTION_EXPIRED", message: "The access token expired" });
    });
    const detail = await call("/api/workflow-runs/:runId", "GET", { runId });
    const list = await call("/api/workflows/:id/runs", "GET", { id: flowId });
    const listed = (list.body.items as Array<{ id: string; failure: { code: string; headline: string; next: Array<{ step: string }> } }>).find((r) => r.id === runId)!;
    expect(detail.body.failure.code).toBe("CONNECTION_EXPIRED");
    expect(listed.failure.code).toBe("CONNECTION_EXPIRED");
    expect(listed.failure.headline).toBe(detail.body.failure.headline);
    expect(listed.failure.next.map((n) => n.step)).toEqual(detail.body.failure.next.map((n: { step: string }) => n.step));
    expect(listed.failure.next.map((n) => n.step)).toContain("connect");
    expect(listed.failure.next.map((n) => n.step)).not.toContain("run_again");
  });
});
