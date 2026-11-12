import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../db";
import { createFlow } from "../db/repos/flow";
import { createDraftVersion, getFlowVersion, updateDraftVersion } from "../db/repos/flow-version";
import { createWorkflowRoutes, type WorkflowRouteMap } from "./routes";

let routes: WorkflowRouteMap;
beforeEach(() => {
  initWorkflowDb(":memory:");
  routes = createWorkflowRoutes({ triggerManager: { refresh: async () => {} } as unknown as NonNullable<Parameters<typeof createWorkflowRoutes>[0]>["triggerManager"] });
});
afterEach(() => closeWorkflowDb());

type Req = Request & { params: Record<string, string> };
async function call(path: string, method: "GET" | "POST" | "PATCH", params: Record<string, string>, body?: unknown) {
  const req = new Request("http://localhost/x", { method, headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) as Req;
  req.params = params;
  const response = await (routes[path] as Record<string, (r: Req) => Response | Promise<Response>>)[method]!(req);
  return { status: response.status, body: await response.json() as any };
}
const create = (displayName: string) => call("/api/workflows", "POST", {}, { displayName });

test.each(["a\u0000b", "a\u0007b", "a\u001bb", "a\nb", "a\u007fb", "a\u0085b", "a\u009bb", "a\u2028b", "a\u2029b", "a\ud800b"])(
  "a workflow name with a control character, separator or lone surrogate is a plain 400: %j", async name => {
    const response = await create(name);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("control characters");
  });

test.each(["Weekly digest", "\u05d3\u05d5\u05d7 \u05e9\u05d1\u05d5\u05e2\u05d9", "\u062a\u0642\u0631\u064a\u0631 \u0623\u0633\u0628\u0648\u0639\u064a",
  "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645", "\u9031\u5831\u3092\u9001\u308b", "Family \u{1F468}\u200d\u{1F469}\u200d\u{1F467} report \u2764\ufe0f"])(
  "a name in any script, with ZWNJ, ZWJ and variation selectors, is stored as written: %j", async name => {
    const response = await create(name);
    expect(response.status).toBe(201);
    expect(response.body.version.displayName).toBe(name);
  });

test("the characters that reorder text are dropped from a stored name", async () => {
  const response = await create("cv\u202egpj.exe");
  expect(response.status).toBe(201);
  expect(response.body.version.displayName).toBe("cvgpj.exe");
});

test("a workflow named before the rule can still be saved under its name, and renaming to a new bad name is refused", async () => {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: "Old", trigger: { name: "trigger", type: "EMPTY" } });
  getWorkflowDb().query("UPDATE flow_version SET display_name = ? WHERE id = ?").run("Old\nname", version.id);
  const path = "/api/workflows/:id/versions/:versionId", params = { id: flow.id, versionId: version.id };
  const opened = (await call(path, "GET", params)).body;
  expect(opened.displayName).toBe("Old\nname");
  const saved = await call(path, "PATCH", params, { expectedRevision: opened.editorRevision, displayName: "Old\nname" });
  expect(saved.status).toBe(200);
  // Stored on one line from here on, and the editor takes the saved name back.
  expect(saved.body.displayName).toBe("Old name");
  const again = await call(path, "PATCH", params, { expectedRevision: saved.body.editorRevision, displayName: "New\u0007name" });
  expect(again.status).toBe(400);
  // A new draft from the same flow keeps its old name as well.
  getWorkflowDb().query("UPDATE flow_version SET display_name = ? WHERE id = ?").run("Old\tname", version.id);
  expect((await call("/api/workflows/:id/versions", "POST", { id: flow.id }, { displayName: "Old\tname", trigger: { name: "trigger", type: "EMPTY" } })).status).toBe(201);
  expect((await call("/api/workflows/:id/versions", "POST", { id: flow.id }, { displayName: "Other\tname", trigger: { name: "trigger", type: "EMPTY" } })).status).toBe(400);
});

test("internal writers store a name on one line without throwing", () => {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: "Composed\r\nname\u0000\u202e", trigger: { name: "trigger", type: "EMPTY" } });
  expect(version.displayName).toBe("Composed name ");
  updateDraftVersion(version.id, { displayName: "Renamed\u2028by tool" });
  expect(getFlowVersion(version.id)!.displayName).toBe("Renamed by tool");
});
