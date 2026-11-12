/**
 * Deleting a workflow or a connection that published workflows use says which
 * workflows, and those workflows then show what is missing. Nothing is blocked.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../db/index";
import { setEncryptionKey } from "../db/encryption";
import { createFlow } from "../db/repos/flow";
import { createDraftVersion, lockVersion } from "../db/repos/flow-version";
import { upsertConnection } from "../db/repos/app-connection";
import { createWorkflowRoutes, type WorkflowRouteMap } from "./routes";

let routes: WorkflowRouteMap;
beforeEach(() => {
  initWorkflowDb(":memory:");
  setEncryptionKey(Buffer.alloc(32, 0x12));
  routes = createWorkflowRoutes();
});
afterEach(() => { closeWorkflowDb(); setEncryptionKey(null); });

const call = async (handler: unknown, method: string, id?: string) => {
  const req = new Request("http://x/", { method }) as Request & { params: { id: string } };
  req.params = { id: id ?? "" };
  const res = await (handler as (r: Request) => Promise<Response> | Response)(req);
  return { status: res.status, body: await res.json() as Record<string, any> };
};

/** A published, enabled workflow whose only step is `step`. */
function published(name: string, step?: Record<string, unknown>, projectId?: string) {
  const flow = createFlow(projectId ? { projectId } : {});
  const version = createDraftVersion({ flowId: flow.id, displayName: name, trigger: { name: "trigger", type: "EMPTY", settings: {},
    ...(step ? { nextAction: { ...step, name: "step_1", displayName: "Do the thing", valid: true } } : {}) } as never });
  lockVersion(version.id);
  // Written directly: publishing checks the connection and the piece catalog, which these graphs do not set up.
  getWorkflowDb().run("UPDATE flow SET published_version_id = ?, status = 'ENABLED' WHERE id = ?", [version.id, flow.id]);
  return flow;
}
const callsChild = (childId: string) => ({ type: "PIECE", settings: { pieceName: "@jarvispieces/piece-jarvis-subflow", actionName: "call", input: { flow: childId } } });
const usesConnection = (externalId: string) => ({ type: "PIECE", settings: { pieceName: "@activepieces/piece-foo", actionName: "send", input: { auth: `{{connections['${externalId}']}}` } } });
const listed = async (id: string) => ((await call(routes["/api/workflows"]?.GET, "GET")).body as unknown as Array<{ id: string; blocked: any }>).find(f => f.id === id)!;

test("deleting a child workflow names the workflows that call it, and they then say what is missing", async () => {
  const child = published("Child");
  const parent = published("Parent flow", callsChild(child.id));
  const bystander = published("Bystander");
  expect((await listed(parent.id)).blocked).toBeNull();

  const preview = await call(routes["/api/workflows/:id/dependents"]?.GET, "GET", child.id);
  expect(preview.body.usedBy).toEqual([{ id: parent.id, name: "Parent flow" }]);

  const del = await call(routes["/api/workflows/:id"]?.DELETE, "DELETE", child.id);
  expect(del.status).toBe(200);
  expect(del.body.usedBy).toEqual([{ id: parent.id, name: "Parent flow" }]);
  expect(del.body.warning).toBe('"Parent flow" calls this workflow and will need setup.');

  expect((await listed(parent.id)).blocked).toMatchObject({ code: "DEPENDENCY_MISSING", runId: null,
    message: 'The step "Do the thing" calls a workflow that was deleted. Choose another workflow for it.' });
  expect((await listed(bystander.id)).blocked).toBeNull();
});

test("deleting a workflow nobody calls has no warning", async () => {
  const lone = published("Lone");
  const del = await call(routes["/api/workflows/:id"]?.DELETE, "DELETE", lone.id);
  expect(del.body).toEqual({ ok: true, usedBy: [] });
});

test("deleting a connection names the published workflows bound to it, and they then say it is gone", async () => {
  const conn = upsertConnection({ externalId: "qa-fake-clickup", displayName: "Click", type: "SECRET_TEXT", pieceName: "@activepieces/piece-foo", pieceVersion: "0.0.1", value: { secret_text: "s" } });
  const other = upsertConnection({ externalId: "unrelated", displayName: "Other", type: "SECRET_TEXT", pieceName: "@activepieces/piece-foo", pieceVersion: "0.0.1", value: { secret_text: "s" } });
  const user = published("Uses it", usesConnection("qa-fake-clickup"));
  expect((await listed(user.id)).blocked).toBeNull();

  const preview = await call(routes["/api/workflows/connections/:id/dependents"]?.GET, "GET", conn.id);
  expect(preview.body.usedBy).toEqual([{ id: user.id, name: "Uses it" }]);

  const unrelated = await call(routes["/api/workflows/connections/:id"]?.DELETE, "DELETE", other.id);
  expect(unrelated.body).toEqual({ id: other.id, deleted: true, usedBy: [] });
  expect((await listed(user.id)).blocked).toBeNull();

  const del = await call(routes["/api/workflows/connections/:id"]?.DELETE, "DELETE", conn.id);
  expect(del.status).toBe(200);
  expect(del.body.warning).toBe('"Uses it" uses this connection and will need setup.');
  expect((await listed(user.id)).blocked).toMatchObject({ code: "DEPENDENCY_MISSING",
    message: 'The step "Do the thing" uses the connection "qa-fake-clickup", which was deleted. Connect it again.' });
});

test("a draft that is not published is not named as a dependent", async () => {
  const child = published("Child");
  const draft = createFlow();
  createDraftVersion({ flowId: draft.id, displayName: "Draft caller", trigger: { name: "trigger", type: "EMPTY", settings: {}, nextAction: { ...callsChild(child.id), name: "step_1" } } as never });
  expect((await call(routes["/api/workflows/:id/dependents"]?.GET, "GET", child.id)).body.usedBy).toEqual([]);
});

test("a connection whose secret cannot be decrypted any more still previews and deletes", async () => {
  const conn = upsertConnection({ externalId: "stale-key", displayName: "Stale", type: "SECRET_TEXT", pieceName: "@activepieces/piece-foo", pieceVersion: "0.0.1", value: { secret_text: "s" } });
  const user = published("Uses stale", usesConnection("stale-key"));
  // The key it was sealed with is gone (a restored backup, a reset key file).
  setEncryptionKey(Buffer.alloc(32, 0x34));
  const preview = await call(routes["/api/workflows/connections/:id/dependents"]?.GET, "GET", conn.id);
  expect(preview.status).toBe(200);
  expect(preview.body.usedBy).toEqual([{ id: user.id, name: "Uses stale" }]);
  const del = await call(routes["/api/workflows/connections/:id"]?.DELETE, "DELETE", conn.id);
  expect(del.status).toBe(200);
  expect(del.body.usedBy).toEqual([{ id: user.id, name: "Uses stale" }]);
});

test("a Jarvis step's account field counts as binding the connection, as the run's connection scope reads it", async () => {
  const stripe = upsertConnection({ externalId: "acct-stripe", displayName: "Stripe", type: "SECRET_TEXT", pieceName: "@activepieces/piece-stripe", pieceVersion: "0.0.1", value: { secret_text: "s" } });
  const refunds = published("Refunds", { type: "PIECE", settings: { pieceName: "@jarvispieces/piece-jarvis-refund", actionName: "approval_refund", input: { stripeConnection: "acct-stripe" } } });
  const preview = await call(routes["/api/workflows/connections/:id/dependents"]?.GET, "GET", stripe.id);
  expect(preview.body.usedBy).toEqual([{ id: refunds.id, name: "Refunds" }]);
  await call(routes["/api/workflows/connections/:id"]?.DELETE, "DELETE", stripe.id);
  expect((await listed(refunds.id)).blocked).toMatchObject({ code: "DEPENDENCY_MISSING",
    message: 'The step "Do the thing" uses the connection "acct-stripe", which was deleted. Connect it again.' });
});

test("deleting one of two connections that share an external id names nobody, since the other still resolves it", async () => {
  const first = upsertConnection({ externalId: "shared-id", displayName: "A", type: "SECRET_TEXT", pieceName: "@activepieces/piece-foo", pieceVersion: "0.0.1", value: { secret_text: "s" } });
  upsertConnection({ externalId: "shared-id", displayName: "B", type: "SECRET_TEXT", pieceName: "@activepieces/piece-bar", pieceVersion: "0.0.1", value: { secret_text: "s" } });
  const user = published("Uses shared", usesConnection("shared-id"));
  const del = await call(routes["/api/workflows/connections/:id"]?.DELETE, "DELETE", first.id);
  expect(del.body).toEqual({ id: first.id, deleted: true, usedBy: [] });
  expect((await listed(user.id)).blocked).toBeNull();
});

test("another project's workflows that name the same id are never named", async () => {
  const child = published("Child");
  published("Elsewhere", callsChild(child.id), "other-project");
  expect((await call(routes["/api/workflows/:id/dependents"]?.GET, "GET", child.id)).body.usedBy).toEqual([]);
  const del = await call(routes["/api/workflows/:id"]?.DELETE, "DELETE", child.id);
  expect(del.body).toEqual({ ok: true, usedBy: [] });
});

test("a workflow name cannot add lines to the confirmation or reorder it", async () => {
  const child = published("Child");
  published("Weekly\n\nNothing else uses this.\u202e", callsChild(child.id));
  const preview = await call(routes["/api/workflows/:id/dependents"]?.GET, "GET", child.id);
  expect(preview.body.warning).toBe('"Weekly Nothing else uses this." calls this workflow and will need setup.');
});

test("a step whose workflow is computed when it runs is not reported as calling a deleted workflow", async () => {
  const caller = published("Computed", { type: "PIECE", settings: { pieceName: "@jarvispieces/piece-jarvis-trigger", actionName: "run_workflow", input: { flow: "{{trigger.body.flow}}" } } });
  expect((await listed(caller.id)).blocked).toBeNull();
});
