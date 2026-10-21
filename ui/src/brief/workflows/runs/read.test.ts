import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeWorkflowDb, DEFAULT_IDS, initWorkflowDb } from "../../../../../src/workflows/db";
import { createFlow } from "../../../../../src/workflows/db/repos/flow";
import { createDraftVersion, lockVersion } from "../../../../../src/workflows/db/repos/flow-version";
import { createFlowRun, updateRun } from "../../../../../src/workflows/db/repos/flow-run";
import { BriefCapabilities } from "../../../../../src/brief/capabilities";
import { WorkflowContext } from "../../../../../src/brief/workflow-context";
import { createWorkflowContextRoutes } from "../../../../../src/brief/workflow-context-routes";
import { configureWorkflowReadiness } from "../../../../../src/workflows/db/repos/flow-readiness";
import { WorkflowRunsController } from "./controller";
import { briefRunsPort } from "./read";

// The port runs against F-21's real routes over an isolated fixture database.
let directory: string, flowId: string, versionId: string, urls: string[], context: WorkflowContext, enabled: boolean;
let routes: ReturnType<typeof createWorkflowContextRoutes>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "jarvis-d19-port-"));
  const db = initWorkflowDb(join(directory, "fixture.db"));
  configureWorkflowReadiness({ tool: () => null });
  enabled = true;
  context = new WorkflowContext(db, DEFAULT_IDS.project, () => enabled);
  const caps = new BriefCapabilities([{ id: "workflowContext", provider: context }], ["workflowContext"]);
  routes = createWorkflowContextRoutes(caps, (body, status = 200) => Response.json(body, { status }), context);
  flowId = createFlow().id;
  versionId = lockVersion(createDraftVersion({ flowId, displayName: "Fixture", trigger: { name: "trigger", type: "EMPTY", settings: {} } }).id).id;
  urls = [];
});
afterEach(() => {
  closeWorkflowDb();
  rmSync(directory, { recursive: true, force: true });
});
const scope = () => ({ scopeId: DEFAULT_IDS.project, flowId, versionId });
const signal = () => new AbortController().signal;
/** Read-only allowlist: F-21's run reads, and nothing else. */
async function serve(url: string, init?: RequestInit) {
  urls.push(url);
  init?.signal?.throwIfAborted();
  const parsed = new URL(url, "http://fixture"), parts = parsed.pathname.split("/").map(decodeURIComponent);
  const req = Object.assign(new Request(parsed), { params: { flowId: parts[4], runId: parts[6], requestId: parts[6] } });
  if (parts.length === 6 && parts[5] === "runs") return routes["/api/brief/workflows/:flowId/runs"].GET(req);
  if (parts.length === 7 && parts[5] === "runs") return routes["/api/brief/workflows/:flowId/runs/:runId"].GET(req);
  if (parts.length === 7 && parts[5] === "run-requests") return routes["/api/brief/workflows/:flowId/run-requests/:requestId"].GET(req);
  throw Error(`Not a run read: ${url}`);
}
function runs(count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const run = createFlowRun({ flowId, flowVersionId: versionId });
    updateRun(run.id, { status: "SUCCEEDED" });
    ids.push(run.id);
  }
  return ids;
}

test("history pages through F-21's keyset reader, never the offset runs API (#1100)", async () => {
  runs(60);
  const port = briefRunsPort(scope(), serve);
  const first = await port.list(null, signal());
  if (first.status !== "ready") throw Error("history not ready");
  expect(first.data.items).toHaveLength(50);
  expect(first.data.total).toBeNull();
  const second = await port.list(first.data.nextCursor, signal());
  if (second.status !== "ready") throw Error("second page not ready");
  expect(second.data.items).toHaveLength(10);
  expect(second.data.nextCursor).toBeNull();
  expect(new Set([...first.data.items, ...second.data.items].map(r => r.runId)).size).toBe(60);
  const base = `/api/brief/workflows/${encodeURIComponent(flowId)}/runs`;
  expect(urls).toEqual([base, `${base}?cursor=${encodeURIComponent(first.data.nextCursor!)}`]);
});

test("each run reads as Run plus its last six characters, with the full ID kept as runId (#1100)", async () => {
  const [id] = runs(1);
  const page = await briefRunsPort(scope(), serve).list(null, signal());
  expect(page).toEqual({ status: "ready", data: { items: [{ scopeId: DEFAULT_IDS.project, flowId, runId: id!, versionId,
    label: `Run ${id!.slice(-6)}`, status: "succeeded", startedAt: null, createdAt: expect.any(Number) }], nextCursor: null, total: null } });
});

test("detail is F-21's redacted inspection of exactly the requested run", async () => {
  const [id] = runs(1);
  updateRun(id!, { steps: { trigger: { type: "EMPTY", status: "SUCCEEDED", input: {}, output: { message: "PRIVATE_CANARY" } } } });
  const detail = await briefRunsPort(scope(), serve).detail(id!, signal());
  if (detail.status !== "ready") throw Error("detail not ready");
  expect(detail.data).toMatchObject({ runId: id, label: `Run ${id!.slice(-6)}`, versionId, status: "succeeded" });
  expect(JSON.stringify(detail)).not.toContain("PRIVATE_CANARY");
  expect(await briefRunsPort(scope(), serve).detail("absent-run", signal())).toEqual({ status: "unavailable", reason: "The selected run could not be loaded." });
});

test("a flow outside the project is unavailable, not an empty history; a flow with no runs is empty", async () => {
  expect(await briefRunsPort({ ...scope(), flowId: "foreign-flow" }, serve).list(null, signal()))
    .toEqual({ status: "unavailable", reason: "Run history is unavailable." });
  expect(await briefRunsPort(scope(), serve).list(null, signal())).toEqual({ status: "empty" });
});

test("a summary for another scope, flow or a malformed page is unavailable", async () => {
  runs(1);
  const port = briefRunsPort({ ...scope(), scopeId: "another-project" }, serve);
  expect((await port.list(null, signal())).status).toBe("unavailable");
  const odd = briefRunsPort(scope(), async () => Response.json({ status: "ready", data: { items: "not-a-list", nextCursor: null, total: null } }));
  expect((await odd.list(null, signal())).status).toBe("unavailable");
});

test("an aborted read rejects rather than reporting unavailable", async () => {
  runs(1);
  const abort = new AbortController();
  abort.abort();
  await expect(briefRunsPort(scope(), serve).list(null, abort.signal)).rejects.toThrow();
});

test("the controller pages and inspects F-21 history through the port", async () => {
  const ids = runs(51);
  const controller = new WorkflowRunsController(scope(), briefRunsPort(scope(), serve));
  await controller.load();
  await controller.more();
  const { history, selectedId } = controller.getSnapshot();
  expect(history.status === "ready" && history.data.items.map(r => r.runId).sort()).toEqual([...ids].sort());
  expect(history.status === "ready" && history.data.nextCursor).toBeNull();
  expect(selectedId).not.toBeNull();
  controller.retire();
});

test("a request's outcome is read back from F-21's receipt, never re-sent (#1093)", async () => {
  const accepted = context.start(flowId, { brief: { scopeId: DEFAULT_IDS.project, versionId, requestId: "lost-reply" }, payload: {} });
  const port = briefRunsPort(scope(), serve);
  const request = { ...scope(), requestId: "lost-reply" };
  expect(await port.reconcile(request, signal())).toEqual({ status: "accepted", requestId: "lost-reply", run: accepted.run });
  expect(await port.reconcile({ ...request, requestId: "never-sent" }, signal())).toEqual({ status: "not_recorded", requestId: "never-sent" });
  expect(urls).toEqual([`/api/brief/workflows/${encodeURIComponent(flowId)}/run-requests/lost-reply`,
    `/api/brief/workflows/${encodeURIComponent(flowId)}/run-requests/never-sent`]);
  // Reading back twice started nothing.
  const page = await port.list(null, signal());
  expect(page.status === "ready" && page.data.items.map(r => r.runId)).toEqual([accepted.run.runId]);
});

test("only F-21's own not_found answer reads as not recorded; anything else rejects (#1093)", async () => {
  const request = { ...scope(), requestId: "unknown" };
  enabled = false;
  await expect(briefRunsPort(scope(), serve).reconcile(request, signal())).rejects.toThrow();
  for (const answer of [new Response(null, { status: 404 }), Response.json({ code: "unavailable" }, { status: 404 }),
    Response.json({ code: "not_found" }, { status: 503 }), Response.json({ status: "accepted", requestId: "other", run: {} }),
    Response.json({ status: "pending", requestId: "unknown" })])
    await expect(briefRunsPort(scope(), async () => answer).reconcile(request, signal())).rejects.toThrow();
});

test("the controller unlocks an unconfirmed Run from the real receipt and selects its run (#1093)", async () => {
  let accepted: ReturnType<WorkflowContext["start"]> | undefined;
  const port = { ...briefRunsPort(scope(), serve), start: async (r: { requestId: string; scopeId: string; versionId: string }) => {
    // The server accepts the run, but its reply is lost on the way back.
    accepted = context.start(flowId, { brief: { scopeId: r.scopeId, versionId: r.versionId, requestId: r.requestId }, payload: {} });
    throw Error("connection reset");
  } };
  const controller = new WorkflowRunsController(scope(), port);
  await controller.load();
  await controller.start();
  expect(controller.canRun).toBe(false);
  await controller.check();
  expect(controller.getSnapshot()).toMatchObject({ submission: "accepted", selectedId: accepted!.run.runId });
  expect(controller.canRun).toBe(true);
  controller.retire();
});

test("a request that lands after a not-recorded check still shows in history and is never re-sent (#1093)", async () => {
  let held: { requestId: string; scopeId: string; versionId: string } | undefined;
  let sent = 0;
  const port = { ...briefRunsPort(scope(), serve), start: async (r: { requestId: string; scopeId: string; versionId: string }) => {
    sent++;
    held = r; // still in transit when the reply is lost
    throw Error("timed out");
  } };
  const controller = new WorkflowRunsController(scope(), port);
  await controller.load();
  await controller.start();
  await controller.check();
  expect(controller.getSnapshot()).toMatchObject({ submission: "idle", request: null });
  expect(controller.getSnapshot().message).toContain("could still start");
  // The original request commits after the check answered not_found.
  const late = context.start(flowId, { brief: { scopeId: held!.scopeId, versionId: held!.versionId, requestId: held!.requestId }, payload: {} });
  await controller.refresh();
  const history = controller.getSnapshot().history;
  expect(history.status === "ready" && history.data.items.map(r => r.runId)).toEqual([late.run.runId]);
  expect(sent).toBe(1);
  controller.retire();
});

test("a not-recorded check re-reads history at once, so a run that did land is on screen (#1093)", async () => {
  let held: { requestId: string; scopeId: string; versionId: string } | undefined;
  const port = { ...briefRunsPort(scope(), serve), start: async (r: { requestId: string; scopeId: string; versionId: string }) => {
    held = r;
    throw Error("timed out");
  }, reconcile: async (r: { requestId: string }) => {
    // The receipt read misses, then the original request lands before history is re-read.
    const answer = { status: "not_recorded" as const, requestId: r.requestId };
    context.start(flowId, { brief: { scopeId: held!.scopeId, versionId: held!.versionId, requestId: held!.requestId }, payload: {} });
    return answer;
  } };
  const controller = new WorkflowRunsController(scope(), port);
  await controller.load();
  await controller.start();
  await controller.check();
  for (let i = 0; i < 400 && controller.getSnapshot().history.status !== "ready"; i++) await new Promise(r => setTimeout(r, 5));
  const history = controller.getSnapshot().history;
  expect(history.status === "ready" && history.data.items).toHaveLength(1);
  controller.retire();
});
