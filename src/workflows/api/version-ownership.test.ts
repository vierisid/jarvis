import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createManageWorkflowTool } from "../../actions/tools/manage-workflow";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../db";
import { createFlow, getFlow, setPublishedVersion } from "../db/repos/flow";
import { createDraftVersion, getFlowVersion, lockVersion, setSampleDataEntry, setSampleInputEntry } from "../db/repos/flow-version";
import { upsertFlowVersionUiMeta } from "../db/repos/flow-version-ui-meta";
import { createWorkflowRoutes, type WorkflowRouteMap } from "./routes";

let routes: WorkflowRouteMap;
let refreshed: string[];
beforeEach(() => {
  initWorkflowDb(":memory:");
  refreshed = [];
  routes = createWorkflowRoutes({ triggerManager: {
    refresh: async (id: string) => { refreshed.push(id); },
  } as NonNullable<Parameters<typeof createWorkflowRoutes>[0]>["triggerManager"] });
});
afterEach(() => closeWorkflowDb());

function fixture(name = "Private workflow B") {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: name,
    trigger: { name: "trigger", type: "EMPTY" } });
  setSampleDataEntry(version.id, "step", { result: "private output" });
  setSampleInputEntry(version.id, "step", { prompt: "private input" });
  upsertFlowVersionUiMeta(version.id, { schema: 1, positions: { step: { x: 1, y: 2 } }, orphans: [] });
  return { flow, version };
}

function snapshot() {
  const db = getWorkflowDb();
  return {
    flows: db.query("SELECT * FROM flow ORDER BY id").all(),
    versions: db.query("SELECT * FROM flow_version ORDER BY id").all(),
    ui: db.query("SELECT * FROM flow_version_ui_meta ORDER BY version_id").all(),
  };
}

async function call(path: string, method: "GET" | "POST" | "PATCH" | "DELETE", id: string, versionId?: string, body?: unknown) {
  const req = new Request("http://localhost" + path, { method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  }) as Request & { params: Record<string, string> };
  req.params = { id, ...(versionId ? { versionId } : {}), stepName: "step" };
  const response = await routes[path]![method]!(req);
  return { status: response.status, body: await response.json() };
}

const VERSION = "/api/workflows/:id/versions/:versionId";
const PUBLISH = "/api/workflows/:id/publish";
const operations = [
  { path: VERSION, method: "GET" },
  { path: VERSION, method: "PATCH", body: { displayName: "Changed", uiMeta: { positions: {}, orphans: [] } } },
  { path: VERSION + "/lock", method: "POST" },
  { path: VERSION + "/sample-data/:stepName", method: "PATCH", body: { output: { changed: true } } },
  { path: VERSION + "/sample-data/:stepName", method: "DELETE" },
  { path: VERSION + "/sample-input/:stepName", method: "PATCH", body: { input: { changed: true } } },
] as const;

describe("nested workflow version ownership", () => {
  for (const op of operations) {
    for (const parent of ["wrong", "missing", "correct"]) {
      test(`${op.method} ${op.path} rejects ${parent === "correct" ? "unknown version" : parent + " parent"} without changes`, async () => {
        const a = fixture("Workflow A");
        const b = fixture();
        const before = snapshot();
        const result = await call(op.path, op.method, parent === "missing" ? "missing" : a.flow.id,
          parent === "correct" ? "missing" : b.version.id, "body" in op ? op.body : undefined);
        expect(result.status).toBe(404);
        expect(JSON.stringify(result.body)).not.toContain(b.version.displayName);
        expect(snapshot()).toEqual(before);
        expect(refreshed).toEqual([]);
      });
    }
  }

  test("rejects foreign malformed versions before parsing their content", async () => {
    const a = fixture("A");
    const b = fixture();
    getWorkflowDb().run("UPDATE flow_version SET trigger = 'invalid-json' WHERE id = ?", [b.version.id]);
    const before = snapshot();
    expect((await call(VERSION, "GET", a.flow.id, b.version.id)).status).toBe(404);
    expect((await call(PUBLISH, "POST", a.flow.id, undefined, { versionId: b.version.id })).status).toBe(404);
    expect(snapshot()).toEqual(before);
  });

  test("valid nested read, edit, samples and lock retain their behavior", async () => {
    const { flow, version } = fixture();
    expect((await call(VERSION, "GET", flow.id, version.id)).body.uiMeta.positions.step).toEqual({ x: 1, y: 2 });
    expect((await call(VERSION, "PATCH", flow.id, version.id, { displayName: "Updated",
      uiMeta: { positions: { step: { x: 3, y: 4 } }, orphans: [] } })).status).toBe(200);
    expect((await call(VERSION + "/sample-data/:stepName", "PATCH", flow.id, version.id, { output: 42 })).status).toBe(200);
    expect((await call(VERSION + "/sample-input/:stepName", "PATCH", flow.id, version.id, { input: { x: 2 } })).status).toBe(200);
    const read = await call(VERSION, "GET", flow.id, version.id);
    expect(read.body).toMatchObject({ displayName: "Updated", sampleData: { step: 42 }, sampleInput: { step: { x: 2 } },
      uiMeta: { positions: { step: { x: 3, y: 4 } } } });
    expect((await call(VERSION + "/sample-data/:stepName", "DELETE", flow.id, version.id)).body.sampleData).toBeNull();
    expect((await call(VERSION + "/lock", "POST", flow.id, version.id)).body.state).toBe("LOCKED");
  });

  test("failed sidecar edit rolls back version content and parent timestamp", async () => {
    const { flow, version } = fixture();
    const before = snapshot();
    getWorkflowDb().exec("CREATE TRIGGER fail_layout BEFORE INSERT ON flow_version_ui_meta BEGIN SELECT RAISE(ABORT, 'synthetic layout failure'); END");
    const result = await call(VERSION, "PATCH", flow.id, version.id, { displayName: "Changed",
      uiMeta: { positions: {}, orphans: [] } });
    expect(result.status).toBe(500);
    expect(snapshot()).toEqual(before);
  });

  test("checks ownership after awaiting the request body", async () => {
    const { flow, version } = fixture();
    const req = new Request("http://localhost", { method: "PATCH" }) as Request & { params: Record<string, string> };
    req.params = { id: flow.id, versionId: version.id };
    req.json = async () => {
      getWorkflowDb().run("DELETE FROM flow_version WHERE id = ?", [version.id]);
      return { displayName: "Too late", uiMeta: { positions: {}, orphans: [] } };
    };
    const result = await routes[VERSION]!.PATCH!(req);
    expect(result.status).toBe(404);
    expect(getFlowVersion(version.id)).toBeNull();
    expect(getWorkflowDb().query("SELECT * FROM flow_version_ui_meta").all()).toEqual([]);
  });

  test("nested version list and creation reject a missing parent", async () => {
    const before = snapshot();
    expect((await call("/api/workflows/:id/versions", "GET", "missing")).status).toBe(404);
    expect((await call("/api/workflows/:id/versions", "POST", "missing", undefined, { displayName: "Orphan" })).status).toBe(404);
    expect(snapshot()).toEqual(before);
  });
});

describe("atomic workflow publication", () => {
  for (const state of ["DRAFT", "LOCKED"]) {
    test(`rejects another flow's ${state} version without mutating either flow`, async () => {
      const a = fixture("A");
      const b = fixture();
      const published = lockVersion(createDraftVersion({ flowId: a.flow.id, displayName: "Previous publication" }).id);
      setPublishedVersion(a.flow.id, published.id);
      if (state === "LOCKED") lockVersion(b.version.id);
      const before = snapshot();
      expect((await call(PUBLISH, "POST", a.flow.id, undefined, { versionId: b.version.id })).status).toBe(404);
      expect(snapshot()).toEqual(before);
      expect(refreshed).toEqual([]);
    });
  }

  test("missing flow cannot lock an existing version", async () => {
    const b = fixture();
    const before = snapshot();
    expect((await call(PUBLISH, "POST", "missing", undefined, { versionId: b.version.id })).status).toBe(404);
    expect(snapshot()).toEqual(before);
    expect(refreshed).toEqual([]);
  });

  test("missing explicit version returns 404; omitted selection with no draft returns 400", async () => {
    const a = fixture("A");
    const empty = createFlow();
    const before = snapshot();
    expect((await call(PUBLISH, "POST", a.flow.id, undefined, { versionId: "missing" })).status).toBe(404);
    expect((await call(PUBLISH, "POST", empty.id)).status).toBe(400);
    expect(snapshot()).toEqual(before);
  });

  for (const body of [null, [], "version", { versionId: null }, { versionId: false }, { versionId: 2 }, { versionId: "" }, { versionId: "   " }]) {
    test(`invalid explicit selection never falls back to a draft: ${JSON.stringify(body)}`, async () => {
      const a = fixture("A");
      const before = snapshot();
      expect((await call(PUBLISH, "POST", a.flow.id, undefined, body)).status).toBe(400);
      expect(snapshot()).toEqual(before);
    });
  }

  test("malformed JSON cannot silently publish the latest draft", async () => {
    const a = fixture("A");
    const before = snapshot();
    const req = new Request("http://localhost", { method: "POST", body: '{"versionId":' }) as Request & { params: Record<string, string> };
    req.params = { id: a.flow.id };
    expect((await routes[PUBLISH]!.POST!(req)).status).toBe(400);
    expect(snapshot()).toEqual(before);
  });

  test("empty object selects the newest owned draft even when another flow was edited later", async () => {
    const a = fixture("A");
    const newer = createDraftVersion({ flowId: a.flow.id, displayName: "Newer A" });
    const b = fixture();
    getWorkflowDb().run("UPDATE flow_version SET updated = 1 WHERE id = ?", [a.version.id]);
    getWorkflowDb().run("UPDATE flow_version SET updated = 2 WHERE id = ?", [newer.id]);
    getWorkflowDb().run("UPDATE flow_version SET updated = 3 WHERE id = ?", [b.version.id]);
    expect((await call(PUBLISH, "POST", a.flow.id, undefined, {})).body.version.id).toBe(newer.id);
    expect(getFlowVersion(a.version.id)?.state).toBe("DRAFT");
    expect(getFlowVersion(b.version.id)?.state).toBe("DRAFT");
  });

  for (const mode of ["explicit draft", "explicit locked", "latest draft"]) {
    test(`${mode} publishes only the owned version`, async () => {
      const a = fixture("A");
      const b = fixture();
      if (mode === "explicit locked") lockVersion(a.version.id);
      const result = await call(PUBLISH, "POST", a.flow.id, undefined,
        mode === "latest draft" ? undefined : { versionId: a.version.id });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ flow: { id: a.flow.id, status: "ENABLED", publishedVersionId: a.version.id },
        version: { id: a.version.id, flowId: a.flow.id, state: "LOCKED" } });
      expect(getFlow(b.flow.id)?.published_version_id).toBeNull();
      expect(getFlowVersion(b.version.id)?.state).toBe("DRAFT");
      expect(refreshed).toEqual([a.flow.id]);
    });
  }

  for (const column of ["published_version_id", "status"]) {
    test(`failure updating ${column} rolls back lock, publication and status`, async () => {
      const a = fixture("A");
      const before = snapshot();
      getWorkflowDb().exec(`CREATE TRIGGER fail_publication BEFORE UPDATE OF ${column} ON flow
        BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END`);
      expect((await call(PUBLISH, "POST", a.flow.id, undefined, { versionId: a.version.id })).status).toBe(500);
      expect(snapshot()).toEqual(before);
      expect(refreshed).toEqual([]);
    });
  }

  test("chat publication uses the same atomic boundary", async () => {
    const a = fixture("A");
    const before = snapshot();
    getWorkflowDb().exec("CREATE TRIGGER fail_publication BEFORE UPDATE OF status ON flow BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END");
    await expect(createManageWorkflowTool().execute({ action: "publish", flow: a.flow.id }))
      .rejects.toThrow("synthetic publication failure");
    expect(snapshot()).toEqual(before);
  });

  test("the repository setter rejects unowned or missing versions and still permits clearing", () => {
    const a = fixture("A");
    const b = fixture();
    const before = snapshot();
    expect(() => setPublishedVersion(a.flow.id, b.version.id)).toThrow(/not found/);
    expect(() => setPublishedVersion(a.flow.id, "missing")).toThrow(/not found/);
    expect(snapshot()).toEqual(before);
    lockVersion(a.version.id);
    setPublishedVersion(a.flow.id, a.version.id);
    setPublishedVersion(a.flow.id, null);
    expect(getFlow(a.flow.id)?.published_version_id).toBeNull();
  });
});
