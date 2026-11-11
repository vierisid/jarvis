import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../db";
import { createWorkflowRoutes, type WorkflowRouteMap } from "./routes";

let routes: WorkflowRouteMap;
beforeEach(() => {
  initWorkflowDb(":memory:");
  routes = createWorkflowRoutes({ triggerManager: { refresh: async () => {} } as unknown as NonNullable<Parameters<typeof createWorkflowRoutes>[0]>["triggerManager"] });
});
afterEach(() => closeWorkflowDb());

async function create(displayName: string) {
  const req = new Request("http://localhost/api/workflows", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName }) }) as Request & { params: Record<string, string> };
  req.params = {};
  return routes["/api/workflows"]!.POST!(req);
}

test.each(["a\u0000b", "a\u0007b", "a\u001bb", "a\nb", "a\u007fb"])("a workflow name with a control character is a plain 400: %j", async name => {
  const response = await create(name);
  expect(response.status).toBe(400);
  expect(JSON.stringify(await response.json())).toContain("control characters");
});

test("a normal workflow name is still accepted", async () => {
  expect((await create("Weekly digest")).status).toBeLessThan(300);
});
