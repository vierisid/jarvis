/**
 * #1153: the per-flow read list. A person grants it through its own route;
 * no generic flow write and no `manage_workflow` action can, and the upgrade
 * seeds only the hosts a flow's GET steps name literally.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManageWorkflowTool } from "../../../actions/tools/manage-workflow";
import { createWorkflowRoutes, type WorkflowRouteMap } from "../../api/routes";
import { closeWorkflowDb, getWorkflowDb, initWorkflowDb } from "../index";
import { createSchema } from "../schema";
import { literalReadHosts, MAX_READ_HOSTS, normalizeReadHosts, parseReadHosts } from "../read-hosts";
import { createFlow, getFlow } from "./flow";
import { createDraftVersion, type FlowTriggerNode } from "./flow-version";
import { getFlowReadHosts, setFlowReadHosts } from "./flow-read-hosts";

const HTTP = "@activepieces/piece-http";
const step = (name: string, input: Record<string, unknown>, next?: FlowTriggerNode): FlowTriggerNode => ({
  name, type: "PIECE", settings: { pieceName: HTTP, actionName: "send_request", input }, ...(next ? { nextAction: next } : {}),
});

let routes: WorkflowRouteMap;
beforeEach(() => {
  initWorkflowDb(":memory:");
  routes = createWorkflowRoutes({ triggerManager: { refresh: async () => {} } as unknown as NonNullable<Parameters<typeof createWorkflowRoutes>[0]>["triggerManager"] });
});
afterEach(() => closeWorkflowDb());

async function call(path: string, method: "POST" | "PATCH", id: string, body?: unknown) {
  const req = new Request("http://localhost" + path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  }) as Request & { params: Record<string, string> };
  req.params = { id };
  const response = await routes[path]![method]!(req);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("the list itself", () => {
  test("hosts are normalized, deduplicated and sorted; a non-host entry is refused by name; the size is capped", () => {
    expect(normalizeReadHosts(["B.example.com", "a.example.com", "b.example.com."])).toEqual(["a.example.com", "b.example.com"]);
    expect(() => normalizeReadHosts(["a.example.com", "https://b.example.com"])).toThrow(/"https:\/\/b\.example\.com" is not a host name/);
    expect(() => normalizeReadHosts(["*.example.com"])).toThrow(/not a host name/);
    expect(() => normalizeReadHosts(Array.from({ length: MAX_READ_HOSTS + 1 }, (_, i) => `h${i}.example.com`))).toThrow(/at most 64/);
    expect(parseReadHosts(null)).toEqual([]);
    expect(parseReadHosts("not json")).toEqual([]);
    expect(parseReadHosts(JSON.stringify(["A.com", "bad host", 3]))).toEqual(["a.com"]);
  });

  test("the upgrade seeds only literal hosts of GET and HEAD steps, never a host filled in at run time", () => {
    const steps: Array<[string, Record<string, unknown>]> = [
      ["get", { method: "GET", url: "https://API.Example.com/v1/items?q={{trigger.q}}" }],
      ["head", { method: "head", url: "http://status.example.com:8080/" }],
      ["nomethod", { url: "https://default.example.com" }],
      ["post", { method: "POST", url: "https://post.example.com/" }],
      ["templated-host", { method: "GET", url: "https://{{trigger.host}}/x" }],
      ["templated-part", { method: "GET", url: "https://evil{{trigger.x}}.example.com/" }],
      ["userinfo", { method: "GET", url: "https://a.example.com@b.example.com/" }],
      ["templated-method", { method: "{{trigger.m}}", url: "https://m.example.com/" }],
      ["whole", { method: "GET", url: "{{trigger.url}}" }],
    ];
    const chain = steps.reduceRight<FlowTriggerNode | undefined>((next, [name, input]) => step(name, input, next), undefined);
    const trigger: FlowTriggerNode = { name: "trigger", type: "EMPTY", nextAction: chain };
    expect(literalReadHosts(trigger)).toEqual(["api.example.com", "default.example.com", "status.example.com"]);
  });
});

describe("POST /api/workflows/:id/read-hosts", () => {
  test("sets, reports and clears the list as the person's", async () => {
    const flow = createFlow();
    const set = await call("/api/workflows/:id/read-hosts", "POST", flow.id, { hosts: ["API.example.com", "status.example.com"] });
    expect(set.status).toBe(200);
    expect(set.body.readHosts).toMatchObject({ hosts: ["api.example.com", "status.example.com"], grantedBy: "user" });
    expect(getFlowReadHosts(flow.id)!.hosts).toEqual(["api.example.com", "status.example.com"]);
    const cleared = await call("/api/workflows/:id/read-hosts", "POST", flow.id, { hosts: [] });
    expect(cleared.body.readHosts).toEqual({ hosts: [], grantedBy: null, grantedAt: null });
  });

  test("refuses a missing list, a non-host entry and an unknown flow, and changes nothing", async () => {
    const flow = createFlow();
    setFlowReadHosts(flow.id, ["keep.example.com"]);
    expect((await call("/api/workflows/:id/read-hosts", "POST", flow.id, {})).status).toBe(400);
    expect((await call("/api/workflows/:id/read-hosts", "POST", flow.id, { hosts: "a.example.com" })).status).toBe(400);
    const bad = await call("/api/workflows/:id/read-hosts", "POST", flow.id, { hosts: ["a.example.com", "b.example.com/path"] });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toContain("b.example.com/path");
    expect((await call("/api/workflows/:id/read-hosts", "POST", "nope", { hosts: [] })).status).toBe(404);
    expect(getFlowReadHosts(flow.id)!.hosts).toEqual(["keep.example.com"]);
  });

  test("an edit that names the list it started from is refused when the list changed since", async () => {
    const flow = createFlow();
    setFlowReadHosts(flow.id, ["a.example.com", "b.example.com"]);
    // Another tab removed b meanwhile; this one, still showing both, adds c.
    setFlowReadHosts(flow.id, ["a.example.com"]);
    const stale = await call("/api/workflows/:id/read-hosts", "POST", flow.id, { hosts: ["a.example.com", "b.example.com", "c.example.com"], expected: ["b.example.com", "a.example.com"] });
    expect(stale.status).toBe(409);
    expect(getFlowReadHosts(flow.id)!.hosts).toEqual(["a.example.com"]);
    // Matching (in any order or case), it applies; without `expected` it always applies.
    expect((await call("/api/workflows/:id/read-hosts", "POST", flow.id, { hosts: ["a.example.com", "c.example.com"], expected: ["A.example.com"] })).status).toBe(200);
    expect(getFlowReadHosts(flow.id)!.hosts).toEqual(["a.example.com", "c.example.com"]);
    expect((await call("/api/workflows/:id/read-hosts", "POST", flow.id, { hosts: [] })).status).toBe(200);
    expect((await call("/api/workflows/:id/read-hosts", "POST", flow.id, { hosts: [], expected: "x" })).status).toBe(400);
  });

  test("the generic flow PATCH cannot set it through metadata", async () => {
    const flow = createFlow();
    const patched = await call("/api/workflows/:id", "PATCH", flow.id, { metadata: { read_hosts: ["evil.example.com"], readHosts: { hosts: ["evil.example.com"] } } });
    expect(patched.status).toBe(200);
    expect(patched.body.readHosts).toEqual({ hosts: [], grantedBy: null, grantedAt: null });
    expect(getFlowReadHosts(flow.id)!.hosts).toEqual([]);
  });

  test("manage_workflow has no action or parameter that sets it", () => {
    const tool = createManageWorkflowTool();
    expect(tool.description).not.toMatch(/read-hosts|read_hosts|readHosts|read list/i);
    expect(JSON.stringify(tool.parameters)).not.toMatch(/read-hosts|read_hosts|readHosts/i);
  });
});

describe("existing flows are grandfathered on upgrade", () => {
  test("a published flow gets its literal GET hosts, stamped upgrade, without touching updated; others get nothing", () => {
    closeWorkflowDb();
    const directory = mkdtempSync(join(tmpdir(), "jarvis-read-hosts-"));
    const path = join(directory, "legacy.db");
    try {
      initWorkflowDb(path);
      const trigger: FlowTriggerNode = { name: "trigger", type: "EMPTY", nextAction: step("get", { method: "GET", url: "https://api.example.com/x" }) };
      const live = createFlow();
      const liveVersion = createDraftVersion({ flowId: live.id, displayName: "Live", trigger });
      getWorkflowDb().run(`UPDATE flow_version SET state = 'LOCKED' WHERE id = ?`, [liveVersion.id]);
      getWorkflowDb().run(`UPDATE flow SET published_version_id = ?, status = 'ENABLED' WHERE id = ?`, [liveVersion.id, live.id]);
      const draft = createFlow();
      createDraftVersion({ flowId: draft.id, displayName: "Never enabled", trigger });
      // An ENABLED flow running an unpublished draft: the draft may be the
      // model's and never reviewed, so its hosts are not seeded.
      const liveDraft = createFlow();
      createDraftVersion({ flowId: liveDraft.id, displayName: "Draft cron", trigger });
      getWorkflowDb().run(`UPDATE flow SET status = 'ENABLED' WHERE id = ?`, [liveDraft.id]);
      const updated = getFlow(live.id)!.updated;
      // Rewind to the shape before the list, then upgrade on a fresh connection.
      const db = getWorkflowDb();
      db.exec("ALTER TABLE flow DROP COLUMN read_hosts_granted_at");
      db.exec("ALTER TABLE flow DROP COLUMN read_hosts_grant");
      db.exec("ALTER TABLE flow DROP COLUMN read_hosts");
      closeWorkflowDb();
      initWorkflowDb(path);
      createSchema(getWorkflowDb());
      expect(getFlowReadHosts(live.id)).toMatchObject({ hosts: ["api.example.com"], grantedBy: "upgrade" });
      expect(getFlowReadHosts(live.id)!.grantedAt).toBeGreaterThan(0);
      expect(getFlow(live.id)!.updated).toBe(updated);
      expect(getFlowReadHosts(draft.id)).toEqual({ hosts: [], grantedBy: null, grantedAt: null });
      expect(getFlowReadHosts(liveDraft.id)).toEqual({ hosts: [], grantedBy: null, grantedAt: null });
      // Once: a person's later change survives the next boot.
      setFlowReadHosts(live.id, []);
      createSchema(getWorkflowDb());
      expect(getFlowReadHosts(live.id)!.hosts).toEqual([]);
    } finally {
      closeWorkflowDb();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a fresh database grandfathers nothing", () => {
    const flow = createFlow();
    createDraftVersion({ flowId: flow.id, displayName: "F", trigger: { name: "trigger", type: "EMPTY", nextAction: step("get", { method: "GET", url: "https://api.example.com/" }) } });
    createSchema(getWorkflowDb());
    expect(getFlowReadHosts(flow.id)!.hosts).toEqual([]);
  });
});
