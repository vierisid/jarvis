import { expect, test } from "bun:test";
import { WorkflowRunsController } from "./controller";
import { readRunHistory } from "./read";

const scope = { scopeId: "northwind", flowId: "follow-up", versionId: "v3" };
const run = (id: string, extra: Record<string, unknown> = {}) => ({
  id, flowId: "follow-up", flowVersionId: "v3", status: "SUCCEEDED", environment: "PRODUCTION",
  startTime: 10, finishTime: 20, created: 9, updated: 20, stepsCount: 1, triggeredBy: null,
  steps: { send: { output: "PRIVATE_CANARY" } }, failedStep: null, ...extra,
});
const serve = (pages: Record<string, unknown>, urls: string[] = []) => async (url: string) => {
  urls.push(url);
  const offset = new URL(url, "http://test").searchParams.get("offset")!;
  return pages[offset] === undefined ? new Response(null, { status: 404 }) : Response.json(pages[offset]);
};
const signal = () => new AbortController().signal;

test("reads the paged runs shape and follows nextOffset as the cursor", async () => {
  const urls: string[] = [];
  const list = readRunHistory(scope, serve({ 0: { items: [run("run-a")], nextOffset: 50 }, 50: { items: [run("run-b")], nextOffset: null } }, urls));
  const first = await list(null, signal());
  expect(first).toEqual({ status: "ready", data: { items: [expect.objectContaining({ runId: "run-a", status: "succeeded", versionId: "v3" })], total: null, nextCursor: "50" } });
  const second = await list("50", signal());
  expect(second.status === "ready" && second.data.nextCursor).toBeNull();
  expect(urls).toEqual(["/api/workflows/follow-up/runs?limit=50&offset=0", "/api/workflows/follow-up/runs?limit=50&offset=50"]);
});

test("captured step output and error text never reach the summary", async () => {
  const list = readRunHistory(scope, serve({ 0: { items: [run("run-a", { status: "FAILED", failedStep: { name: "send", displayName: "Send", errorMessage: "PRIVATE_CANARY" } })], nextOffset: null } }));
  const page = await list(null, signal());
  expect(JSON.stringify(page)).not.toContain("PRIVATE_CANARY");
  expect(page.status === "ready" && page.data.items[0]!.status).toBe("failed");
});

test("a stop that may have let an in-flight call complete reads as uncertain", async () => {
  const list = readRunHistory(scope, serve({ 0: { items: [
    run("run-a", { status: "STOPPED", cancellation: { acknowledgedAt: 1, inFlightMayHaveCompleted: true } }),
    run("run-b", { status: "STOPPED", cancellation: { acknowledgedAt: 1, inFlightMayHaveCompleted: false } }),
  ], nextOffset: null } }));
  const page = await list(null, signal());
  expect(page.status === "ready" && page.data.items.map(r => r.status)).toEqual(["uncertain", "cancelled"]);
});

test("a bare array, a foreign flow, an unknown status or a backwards offset is unavailable", async () => {
  for (const body of [[run("run-a")], { items: [run("run-a", { flowId: "other" })], nextOffset: null },
    { items: [run("run-a", { status: "MYSTERY" })], nextOffset: null }, { items: [run("run-a")], nextOffset: 0 }])
    expect((await readRunHistory(scope, serve({ 0: body }))(null, signal())).status).toBe("unavailable");
});

test("a 404 for a flow outside the project is unavailable, not an empty history", async () => {
  expect(await readRunHistory(scope, serve({}))(null, signal())).toEqual({ status: "unavailable", reason: "Run history is unavailable." });
  expect(await readRunHistory(scope, serve({ 0: { items: [], nextOffset: null } }))(null, signal())).toEqual({ status: "empty" });
});

test("the controller pages main's runs API through the adapter", async () => {
  const list = readRunHistory(scope, serve({ 0: { items: [run("run-a")], nextOffset: 50 }, 50: { items: [run("run-b")], nextOffset: null } }));
  const controller = new WorkflowRunsController(scope, { list, detail: async () => ({ status: "empty" }) });
  await controller.load();
  await controller.more();
  const history = controller.getSnapshot().history;
  expect(history.status === "ready" && history.data.items.map(r => r.runId)).toEqual(["run-a", "run-b"]);
  expect(history.status === "ready" && history.data.nextCursor).toBeNull();
  controller.retire();
});
