/**
 * Tests for the workflow API route handlers. Invokes handlers directly with
 * synthesized Request objects so we don't need to bring up Bun.serve.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../db/index";
import { queueStats } from "../db/repos/job-queue";
import { createWorkflowRoutes, type WorkflowRouteMap } from "./routes";
import { sampleCatalog } from "../runtime/test-fixtures";

let routes: WorkflowRouteMap;

beforeEach(() => {
  initWorkflowDb(":memory:");
  routes = createWorkflowRoutes();
});

afterEach(() => {
  closeWorkflowDb();
});

function reqWithParams<P extends Record<string, string>>(
  method: string,
  url: string,
  params: P,
  body?: unknown,
): Request & { params: P } {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const r = new Request(url, init) as Request & { params: P };
  r.params = params;
  return r;
}

function plainReq(method: string, url: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  return new Request(url, init);
}

async function callJson(handler: unknown, req: Request | (Request & { params: Record<string, string> })) {
  const fn = handler as (r: Request) => Promise<Response> | Response;
  const res = await fn(req as Request);
  return { status: res.status, body: await res.json() };
}

describe("workflow API: piece catalog", () => {
  test("returns [] when no registry is wired", async () => {
    const r = createWorkflowRoutes();
    const get = r["/api/workflows/pieces"]?.GET;
    expect(get).toBeDefined();
    const { status, body } = await callJson(get, plainReq("GET", "http://x/api/workflows/pieces"));
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  test("surfaces inputSchema on actions and triggers when declared", async () => {
    const reg = sampleCatalog();
    const r = createWorkflowRoutes({ pieceRegistry: reg });
    const get = r["/api/workflows/pieces"]?.GET;
    const { body } = await callJson(get, plainReq("GET", "http://x/api/workflows/pieces"));

    const ask = (body as Array<{ name: string; actions: Array<{ name: string; inputSchema: { fields: Array<{ name: string; required: boolean }> } | null }> }>)
      .find((p) => p.name === "jarvis-ask");
    const askSchema = ask?.actions[0]?.inputSchema;
    expect(askSchema).not.toBeNull();
    expect(askSchema?.fields.find((f) => f.name === "prompt")?.required).toBe(true);
    expect(askSchema?.fields.find((f) => f.name === "system")?.required).toBe(false);

    const trig = (body as Array<{ name: string; triggers: Array<{ name: string; inputSchema: { fields: Array<{ name: string }> } | null }> }>)
      .find((p) => p.name === "jarvis-trigger");
    expect(trig?.triggers[0]?.inputSchema?.fields.some((f) => f.name === "eventType")).toBe(true);
  });

  test("returns registered pieces with actions and triggers", async () => {
    const reg = sampleCatalog();
    const r = createWorkflowRoutes({ pieceRegistry: reg });
    const get = r["/api/workflows/pieces"]?.GET;
    const { status, body } = await callJson(get, plainReq("GET", "http://x/api/workflows/pieces"));
    expect(status).toBe(200);
    const names = (body as Array<{ name: string }>).map((p) => p.name).sort();
    expect(names).toEqual(["jarvis-ask", "jarvis-notify", "jarvis-trigger"]);
    const trigger = (body as Array<{ name: string; triggers: Array<{ name: string }> }>).find((p) => p.name === "jarvis-trigger");
    expect(trigger?.triggers.map((t) => t.name)).toEqual(["on_event"]);
    const ask = (body as Array<{ name: string; actions: Array<{ name: string }> }>).find((p) => p.name === "jarvis-ask");
    expect(ask?.actions.map((a) => a.name)).toEqual(["ask"]);
  });

  test("forwards trigger dynamicSampleData so the editor's variable picker can resolve per-input-value samples", async () => {
    // Construct a catalog whose on_event trigger has the same shape the
    // projection in metadataToCatalogEntry produces (a per-value sample
    // map sourced from WORKFLOW_EVENT_TYPES). The route must forward the
    // field verbatim; previously it stripped it, so the picker only saw
    // the static `sampleData` and surfaced the wrong fields.
    const reg = new (
      await import("../runtime/piece-catalog")
    ).PieceCatalog([
      {
        name: "@jarvispieces/piece-jarvis-trigger",
        displayName: "Jarvis: Trigger",
        description: "",
        actions: {},
        triggers: {
          on_event: {
            name: "on_event",
            displayName: "On",
            description: "",
            sampleData: { id: "s", eventType: "awareness.context_changed", payload: { app: "x" }, timestamp: 0 },
            dynamicSampleData: {
              propName: "eventType",
              samples: {
                "observer.clipboard_changed": {
                  id: "s",
                  eventType: "observer.clipboard_changed",
                  payload: { content: "https://example.com", length: 19 },
                  timestamp: 0,
                },
              },
            },
          },
        },
      },
    ]);
    const r = createWorkflowRoutes({ pieceRegistry: reg });
    const get = r["/api/workflows/pieces"]?.GET;
    const { status, body } = await callJson(get, plainReq("GET", "http://x/api/workflows/pieces"));
    expect(status).toBe(200);
    const piece = (body as Array<{ name: string; triggers: Array<{ name: string; dynamicSampleData?: { propName: string; samples: Record<string, unknown> } }> }>)[0];
    const dyn = piece?.triggers[0]?.dynamicSampleData;
    expect(dyn?.propName).toBe("eventType");
    const clip = dyn?.samples["observer.clipboard_changed"] as { payload?: { content?: string } } | undefined;
    expect(clip?.payload?.content).toBe("https://example.com");
  });
});

describe("workflow API: flows", () => {
  test("POST /api/workflows creates a flow + initial draft version", async () => {
    const post = routes["/api/workflows"]?.POST;
    expect(post).toBeDefined();
    const { status, body } = await callJson(
      post,
      plainReq("POST", "http://x/api/workflows", { displayName: "Morning briefing" }),
    );
    expect(status).toBe(201);
    expect(body).toMatchObject({
      flow: { status: "DISABLED", externalId: expect.any(String) },
      version: { displayName: "Morning briefing", state: "DRAFT" },
    });
  });

  test("POST /api/workflows requires displayName", async () => {
    const post = routes["/api/workflows"]?.POST;
    const { status, body } = await callJson(
      post,
      plainReq("POST", "http://x/api/workflows", {}),
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/displayName/);
  });

  test("GET /api/workflows lists flows; status filter narrows", async () => {
    const post = routes["/api/workflows"]?.POST;
    await callJson(post, plainReq("POST", "http://x", { displayName: "a" }));
    await callJson(post, plainReq("POST", "http://x", { displayName: "b" }));

    const get = routes["/api/workflows"]?.GET;
    const all = await callJson(get, plainReq("GET", "http://x/api/workflows"));
    expect(all.status).toBe(200);
    expect(Array.isArray(all.body)).toBe(true);
    expect(all.body.length).toBe(2);

    const enabled = await callJson(get, plainReq("GET", "http://x/api/workflows?status=ENABLED"));
    expect(enabled.body).toEqual([]);
  });

  test("GET /api/workflows inlines displayName from each flow's latest version", async () => {
    // The flow_ref picker in the editor depends on this: without
    // displayName in the list response every workflow would render
    // as "(unnamed)" in the dropdown. Test pins the inlining so a
    // future refactor of serializeFlow can't silently drop the field.
    const post = routes["/api/workflows"]?.POST;
    await callJson(post, plainReq("POST", "http://x", { displayName: "Morning briefing" }));
    await callJson(post, plainReq("POST", "http://x", { displayName: "Weekly report" }));
    const get = routes["/api/workflows"]?.GET;
    const { body } = await callJson(get, plainReq("GET", "http://x/api/workflows"));
    const names = (body as Array<{ displayName: string | null }>).map((r) => r.displayName).sort();
    expect(names).toEqual(["Morning briefing", "Weekly report"]);
  });

  test("GET /api/workflows/:id returns flow with latest draft", async () => {
    const post = routes["/api/workflows"]?.POST;
    const created = await callJson(
      post,
      plainReq("POST", "http://x", { displayName: "x" }),
    );
    const flowId = created.body.flow.id;

    const get = routes["/api/workflows/:id"]?.GET;
    const { status, body } = await callJson(
      get,
      reqWithParams("GET", `http://x/api/workflows/${flowId}`, { id: flowId }),
    );
    expect(status).toBe(200);
    expect(body.flow.id).toBe(flowId);
    expect(body.latestDraft.displayName).toBe("x");
    expect(body.published).toBeNull();
  });

  test("GET /api/workflows/:id 404s for unknown id", async () => {
    const get = routes["/api/workflows/:id"]?.GET;
    const { status } = await callJson(
      get,
      reqWithParams("GET", "http://x/api/workflows/nope", { id: "nope" }),
    );
    expect(status).toBe(404);
  });

  test("PATCH /api/workflows/:id toggles status and metadata", async () => {
    const post = routes["/api/workflows"]?.POST;
    const created = await callJson(post, plainReq("POST", "http://x", { displayName: "x" }));
    const flowId = created.body.flow.id;

    const patch = routes["/api/workflows/:id"]?.PATCH;
    const { status, body } = await callJson(
      patch,
      reqWithParams(
        "PATCH",
        `http://x/api/workflows/${flowId}`,
        { id: flowId },
        { status: "ENABLED", metadata: { tag: "morning" } },
      ),
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ENABLED", metadata: { tag: "morning" } });
  });

  test("DELETE /api/workflows/:id removes the flow and cascades versions", async () => {
    const post = routes["/api/workflows"]?.POST;
    const created = await callJson(post, plainReq("POST", "http://x", { displayName: "x" }));
    const flowId = created.body.flow.id;

    const del = routes["/api/workflows/:id"]?.DELETE;
    const { status } = await callJson(
      del,
      reqWithParams("DELETE", `http://x/api/workflows/${flowId}`, { id: flowId }),
    );
    expect(status).toBe(200);

    const get = routes["/api/workflows/:id"]?.GET;
    const after = await callJson(
      get,
      reqWithParams("GET", `http://x/api/workflows/${flowId}`, { id: flowId }),
    );
    expect(after.status).toBe(404);
  });
});

describe("workflow API: versions", () => {
  test("PATCH a draft version updates trigger + valid", async () => {
    const post = routes["/api/workflows"]?.POST;
    const created = await callJson(post, plainReq("POST", "http://x", { displayName: "x" }));
    const { id: flowId } = created.body.flow;
    const versionId = created.body.version.id;

    const patch = routes["/api/workflows/:id/versions/:versionId"]?.PATCH;
    const { status, body } = await callJson(
      patch,
      reqWithParams(
        "PATCH",
        `http://x/api/workflows/${flowId}/versions/${versionId}`,
        { id: flowId, versionId },
        {
          trigger: { type: "PIECE_TRIGGER", pieceName: "schedule" },
          valid: true,
          connectionIds: ["conn-1"],
        },
      ),
    );
    expect(status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.connectionIds).toEqual(["conn-1"]);
    expect(body.trigger).toEqual({ type: "PIECE_TRIGGER", pieceName: "schedule" });
  });

  test("POST .../lock locks a draft", async () => {
    const post = routes["/api/workflows"]?.POST;
    const created = await callJson(post, plainReq("POST", "http://x", { displayName: "x" }));
    const { id: flowId } = created.body.flow;
    const versionId = created.body.version.id;

    const lock = routes["/api/workflows/:id/versions/:versionId/lock"]?.POST;
    const { body } = await callJson(
      lock,
      reqWithParams(
        "POST",
        `http://x/api/workflows/${flowId}/versions/${versionId}/lock`,
        { id: flowId, versionId },
      ),
    );
    expect(body.state).toBe("LOCKED");
  });

  test("POST .../publish locks the draft, ENABLES the flow, sets published_version_id", async () => {
    const post = routes["/api/workflows"]?.POST;
    const created = await callJson(post, plainReq("POST", "http://x", { displayName: "x" }));
    const flowId = created.body.flow.id;
    const versionId = created.body.version.id;

    const publish = routes["/api/workflows/:id/publish"]?.POST;
    const { status, body } = await callJson(
      publish,
      reqWithParams(
        "POST",
        `http://x/api/workflows/${flowId}/publish`,
        { id: flowId },
      ),
    );
    expect(status).toBe(200);
    expect(body.flow.status).toBe("ENABLED");
    expect(body.flow.publishedVersionId).toBe(versionId);
    expect(body.version.state).toBe("LOCKED");
  });
});

describe("workflow API: runs", () => {
  test("POST /:id/run creates a flow_run and enqueues a RUN_FLOW job", async () => {
    const post = routes["/api/workflows"]?.POST;
    const created = await callJson(post, plainReq("POST", "http://x", { displayName: "x" }));
    const flowId = created.body.flow.id;

    const run = routes["/api/workflows/:id/run"]?.POST;
    const { status, body } = await callJson(
      run,
      reqWithParams(
        "POST",
        `http://x/api/workflows/${flowId}/run`,
        { id: flowId },
        { triggeredBy: "test" },
      ),
    );
    expect(status).toBe(202);
    expect(body.flowId).toBe(flowId);
    expect(body.status).toBe("QUEUED");
    expect(body.triggeredBy).toBe("test");
    expect(queueStats().queued).toBe(1);
  });

  test("POST /:id/run with stepNameToTest prefers DRAFT over PUBLISHED", async () => {
    // The test-from-here UX edits sample data + step definitions on a
    // draft. If we ran the published version instead, the test would
    // execute stale state -- this regression covers that selection rule.
    const { createFlow } = await import("../db/repos/flow");
    const { createDraftVersion, lockVersion } = await import("../db/repos/flow-version");
    const { setPublishedVersion } = await import("../db/repos/flow");
    const flow = createFlow();
    // Lock + publish one version, then create a new draft on top.
    const published = createDraftVersion({
      flowId: flow.id,
      displayName: "v1",
      trigger: { name: "trigger", type: "EMPTY" } as unknown as Record<string, unknown>,
    });
    lockVersion(published.id);
    setPublishedVersion(flow.id, published.id);
    const draft = createDraftVersion({
      flowId: flow.id,
      displayName: "v2",
      trigger: { name: "trigger", type: "EMPTY" } as unknown as Record<string, unknown>,
    });

    const run = routes["/api/workflows/:id/run"]?.POST;

    // Production run: prefers PUBLISHED.
    const prod = await callJson(
      run,
      reqWithParams(
        "POST",
        `http://x/api/workflows/${flow.id}/run`,
        { id: flow.id },
        { triggeredBy: "test" },
      ),
    );
    expect(prod.body.flowVersionId).toBe(published.id);

    // Test-from-here: prefers DRAFT.
    const test = await callJson(
      run,
      reqWithParams(
        "POST",
        `http://x/api/workflows/${flow.id}/run`,
        { id: flow.id },
        { triggeredBy: "test", stepNameToTest: "trigger" },
      ),
    );
    expect(test.body.flowVersionId).toBe(draft.id);
  });

  test("POST /:id/run 400s when the flow has no draft or published version", async () => {
    // Build a flow row directly (no draft) to reproduce the edge case.
    const { createFlow } = await import("../db/repos/flow");
    const flow = createFlow();
    const run = routes["/api/workflows/:id/run"]?.POST;
    const { status, body } = await callJson(
      run,
      reqWithParams(
        "POST",
        `http://x/api/workflows/${flow.id}/run`,
        { id: flow.id },
      ),
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/no published or draft/);
  });

  test("GET /:id/runs lists runs for a flow", async () => {
    const post = routes["/api/workflows"]?.POST;
    const created = await callJson(post, plainReq("POST", "http://x", { displayName: "x" }));
    const flowId = created.body.flow.id;
    const runHandler = routes["/api/workflows/:id/run"]?.POST;
    await callJson(
      runHandler,
      reqWithParams("POST", `http://x/api/workflows/${flowId}/run`, { id: flowId }, {}),
    );
    await callJson(
      runHandler,
      reqWithParams("POST", `http://x/api/workflows/${flowId}/run`, { id: flowId }, {}),
    );

    const list = routes["/api/workflows/:id/runs"]?.GET;
    const { status, body } = await callJson(
      list,
      reqWithParams("GET", `http://x/api/workflows/${flowId}/runs`, { id: flowId }),
    );
    expect(status).toBe(200);
    expect(body.length).toBe(2);
  });

  test("POST /api/workflow-runs/:runId/cancel cancels the queued job", async () => {
    const post = routes["/api/workflows"]?.POST;
    const created = await callJson(post, plainReq("POST", "http://x", { displayName: "x" }));
    const flowId = created.body.flow.id;
    const run = await callJson(
      routes["/api/workflows/:id/run"]?.POST,
      reqWithParams("POST", `http://x/api/workflows/${flowId}/run`, { id: flowId }, {}),
    );
    const runId: string = run.body.id;

    const cancel = routes["/api/workflow-runs/:runId/cancel"]?.POST;
    const { status, body } = await callJson(
      cancel,
      reqWithParams("POST", `http://x/api/workflow-runs/${runId}/cancel`, { runId }),
    );
    expect(status).toBe(200);
    expect(body.jobCanceled).toBe(true);
    expect(queueStats().canceled).toBe(1);
  });

  test("GET /api/workflow-runs/:runId returns the run", async () => {
    const post = routes["/api/workflows"]?.POST;
    const created = await callJson(post, plainReq("POST", "http://x", { displayName: "x" }));
    const flowId = created.body.flow.id;
    const run = await callJson(
      routes["/api/workflows/:id/run"]?.POST,
      reqWithParams("POST", `http://x/api/workflows/${flowId}/run`, { id: flowId }, {}),
    );
    const runId: string = run.body.id;

    const get = routes["/api/workflow-runs/:runId"]?.GET;
    const { status, body } = await callJson(
      get,
      reqWithParams("GET", `http://x/api/workflow-runs/${runId}`, { runId }),
    );
    expect(status).toBe(200);
    expect(body.id).toBe(runId);
  });
});

describe("workflow API: waitpoint resume", () => {
  test("POST /api/webhooks/waitpoints/:id enqueues RUN_FLOW(executionType=RESUME) and marks waitpoint resumed", async () => {
    const { createFlow, setPublishedVersion, updateFlowStatus } = await import(
      "../db/repos/flow"
    );
    const { createDraftVersion, lockVersion } = await import(
      "../db/repos/flow-version"
    );
    const { createFlowRun } = await import("../db/repos/flow-run");
    const { createWaitpoint, getWaitpoint } = await import(
      "../db/repos/waitpoint"
    );
    const { claimNextJob, queueStats } = await import("../db/repos/job-queue");
    const { DEFAULT_IDS } = await import("../db/schema");

    const flow = createFlow({ projectId: DEFAULT_IDS.project });
    const v = createDraftVersion({
      flowId: flow.id,
      displayName: "paused flow",
      trigger: { type: "EMPTY", name: "trigger", displayName: "Manual" } as unknown as Record<string, unknown>,
    });
    lockVersion(v.id);
    setPublishedVersion(flow.id, v.id);
    updateFlowStatus(flow.id, "ENABLED");
    const run = createFlowRun({
      flowId: flow.id,
      flowVersionId: v.id,
      environment: "TESTING",
    });
    // The route's status guard requires PAUSED; default createFlowRun
    // status is QUEUED. Flip to PAUSED to simulate a piece having called
    // `context.run.createWaitpoint`.
    const { updateRun } = await import("../db/repos/flow-run");
    updateRun(run.id, { status: "PAUSED" });
    const wp = createWaitpoint({
      flowRunId: run.id,
      projectId: DEFAULT_IDS.project,
      stepName: "step_pause",
      type: "WEBHOOK",
    });

    const r = createWorkflowRoutes();
    const post = r["/api/webhooks/waitpoints/:id"]?.POST;
    const before = queueStats().queued;
    const { status, body } = await callJson(
      post,
      reqWithParams("POST", `http://x/api/webhooks/waitpoints/${wp.id}`, { id: wp.id }, {
        externalSignal: "wake-up",
      }),
    );
    expect(status).toBe(202);
    expect(body.runId).toBe(run.id);
    expect(body.resumed).toBe(true);
    expect(queueStats().queued).toBe(before + 1);

    // Claim the enqueued job and verify the resume payload survived the
    // queue round-trip + the execution type is RESUME.
    const job = claimNextJob<{
      runId: string;
      executionType?: string;
      resumePayload?: Record<string, unknown>;
    }>();
    expect(job?.payload.runId).toBe(run.id);
    expect(job?.payload.executionType).toBe("RESUME");
    expect(job?.payload.resumePayload).toEqual({ externalSignal: "wake-up" });

    // Waitpoint marked resumed -> a second hit returns 410.
    const persisted = getWaitpoint(wp.id);
    expect(persisted?.resumedAt).not.toBeNull();
    const secondHit = await callJson(
      post,
      reqWithParams("POST", `http://x/api/webhooks/waitpoints/${wp.id}`, { id: wp.id }, {}),
    );
    expect(secondHit.status).toBe(410);
  });

  test("POST /api/webhooks/waitpoints/:id 404s on unknown waitpoint", async () => {
    const r = createWorkflowRoutes();
    const post = r["/api/webhooks/waitpoints/:id"]?.POST;
    const { status } = await callJson(
      post,
      reqWithParams("POST", "http://x/api/webhooks/waitpoints/missing", { id: "missing" }, {}),
    );
    expect(status).toBe(404);
  });

  test("POST /api/webhooks/waitpoints/:id 409s when run is no longer PAUSED", async () => {
    const { createFlow } = await import("../db/repos/flow");
    const { createDraftVersion, lockVersion } = await import(
      "../db/repos/flow-version"
    );
    const { createFlowRun, updateRun } = await import("../db/repos/flow-run");
    const { createWaitpoint } = await import("../db/repos/waitpoint");
    const { DEFAULT_IDS } = await import("../db/schema");

    const flow = createFlow({ projectId: DEFAULT_IDS.project });
    const v = createDraftVersion({
      flowId: flow.id,
      displayName: "broken flow",
      trigger: { type: "EMPTY", name: "trigger", displayName: "Manual" } as unknown as Record<string, unknown>,
    });
    lockVersion(v.id);
    const run = createFlowRun({
      flowId: flow.id,
      flowVersionId: v.id,
      environment: "TESTING",
    });
    // Run failed before the waitpoint resolver fired; resume should be rejected.
    updateRun(run.id, { status: "FAILED" });
    const wp = createWaitpoint({
      flowRunId: run.id,
      projectId: DEFAULT_IDS.project,
      stepName: "step_pause",
      type: "WEBHOOK",
    });

    const r = createWorkflowRoutes();
    const post = r["/api/webhooks/waitpoints/:id"]?.POST;
    const { status, body } = await callJson(
      post,
      reqWithParams("POST", `http://x/api/webhooks/waitpoints/${wp.id}`, { id: wp.id }, {}),
    );
    expect(status).toBe(409);
    expect(body.error).toMatch(/FAILED/);
    expect(body.error).toMatch(/PAUSED/);
  });
});

describe("workflow API: connections", () => {
  test("POST rejects OAUTH2 without access_token", async () => {
    const r = createWorkflowRoutes();
    const post = r["/api/workflows/connections"]?.POST;
    const { status, body } = await callJson(
      post,
      plainReq("POST", "http://x/api/workflows/connections", {
        externalId: "x",
        displayName: "X",
        type: "OAUTH2",
        pieceName: "@activepieces/piece-gmail",
        value: { refresh_token: "rt" },
      }),
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/access_token/);
  });

  test("POST rejects BASIC_AUTH without username + password", async () => {
    const r = createWorkflowRoutes();
    const post = r["/api/workflows/connections"]?.POST;
    const { status, body } = await callJson(
      post,
      plainReq("POST", "http://x/api/workflows/connections", {
        externalId: "x",
        displayName: "X",
        type: "BASIC_AUTH",
        pieceName: "@activepieces/piece-foo",
        value: { username: "alice" },
      }),
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/password/);
  });

  test("POST accepts CUSTOM_AUTH with arbitrary value", async () => {
    const r = createWorkflowRoutes();
    const post = r["/api/workflows/connections"]?.POST;
    const { status } = await callJson(
      post,
      plainReq("POST", "http://x/api/workflows/connections", {
        externalId: "custom-1",
        displayName: "Custom",
        type: "CUSTOM_AUTH",
        pieceName: "@activepieces/piece-foo",
        value: { whatever: "fine", nested: { ok: true } },
      }),
    );
    expect(status).toBe(201);
  });

  test("PATCH rotates value without delete-then-recreate", async () => {
    const { upsertConnection, getConnection } = await import(
      "../db/repos/app-connection"
    );
    const conn = upsertConnection({
      externalId: "rotate-me",
      displayName: "Rotating",
      type: "OAUTH2",
      pieceName: "@activepieces/piece-foo",
      pieceVersion: "0.0.1",
      value: { access_token: "old", refresh_token: "old-rt" },
    });
    const r = createWorkflowRoutes();
    const patch = r["/api/workflows/connections/:id"]?.PATCH;
    const { status } = await callJson(
      patch,
      reqWithParams(
        "PATCH",
        `http://x/api/workflows/connections/${conn.id}`,
        { id: conn.id },
        { value: { access_token: "new", refresh_token: "new-rt" } },
      ),
    );
    expect(status).toBe(200);
    const fresh = getConnection(conn.id);
    expect((fresh?.value as Record<string, string> | undefined)?.["access_token"]).toBe("new");
  });

  test("PATCH rejects a value that would fail the per-type schema check (e.g., OAUTH2 without access_token)", async () => {
    // POST has the same check; PATCH must apply it too, otherwise rotation
    // is a back-door for storing values the create path would reject.
    const { upsertConnection, getConnection } = await import(
      "../db/repos/app-connection"
    );
    const conn = upsertConnection({
      externalId: "schema-check",
      displayName: "Schema",
      type: "OAUTH2",
      pieceName: "@activepieces/piece-foo",
      pieceVersion: "0.0.1",
      value: { access_token: "valid" },
    });
    const r = createWorkflowRoutes();
    const patch = r["/api/workflows/connections/:id"]?.PATCH;
    const { status, body } = await callJson(
      patch,
      reqWithParams(
        "PATCH",
        `http://x/api/workflows/connections/${conn.id}`,
        { id: conn.id },
        { value: { refresh_token: "rt-only-no-access-token" } },
      ),
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/access_token/);
    // Existing value untouched.
    const fresh = getConnection(conn.id);
    expect((fresh?.value as Record<string, string> | undefined)?.["access_token"]).toBe("valid");
  });
});

describe("workflow API: waitpoints surface", () => {
  test("GET /api/workflow-runs/:runId/waitpoints lists active waitpoints with resume URLs", async () => {
    const { createFlow } = await import("../db/repos/flow");
    const { createDraftVersion, lockVersion } = await import(
      "../db/repos/flow-version"
    );
    const { createFlowRun, updateRun } = await import("../db/repos/flow-run");
    const { createWaitpoint } = await import("../db/repos/waitpoint");
    const { DEFAULT_IDS } = await import("../db/schema");

    const flow = createFlow({ projectId: DEFAULT_IDS.project });
    const v = createDraftVersion({
      flowId: flow.id,
      displayName: "wp-surface",
      trigger: { type: "EMPTY", name: "trigger", displayName: "Manual" } as unknown as Record<string, unknown>,
    });
    lockVersion(v.id);
    const run = createFlowRun({
      flowId: flow.id,
      flowVersionId: v.id,
      environment: "TESTING",
    });
    updateRun(run.id, { status: "PAUSED" });
    const wp = createWaitpoint({
      flowRunId: run.id,
      projectId: DEFAULT_IDS.project,
      stepName: "step_pause",
      type: "WEBHOOK",
    });

    const r = createWorkflowRoutes();
    const get = r["/api/workflow-runs/:runId/waitpoints"]?.GET;
    const { status, body } = await callJson(
      get,
      reqWithParams(
        "GET",
        `http://x/api/workflow-runs/${run.id}/waitpoints`,
        { runId: run.id },
      ),
    );
    expect(status).toBe(200);
    expect(body.runId).toBe(run.id);
    expect(body.waitpoints).toHaveLength(1);
    expect(body.waitpoints[0].id).toBe(wp.id);
    expect(body.waitpoints[0].stepName).toBe("step_pause");
    expect(body.waitpoints[0].resumeUrl).toBe(`/api/webhooks/waitpoints/${wp.id}`);
  });
});

describe("workflow API: sample data", () => {
  async function setupVersion() {
    const { createFlow } = await import("../db/repos/flow");
    const { createDraftVersion } = await import("../db/repos/flow-version");
    const { DEFAULT_IDS } = await import("../db/schema");
    const flow = createFlow({ projectId: DEFAULT_IDS.project });
    const v = createDraftVersion({
      flowId: flow.id,
      displayName: "sample-data-test",
      trigger: { name: "trigger", type: "EMPTY", displayName: "Manual" } as unknown as Record<
        string,
        unknown
      >,
    });
    return { flow, version: v };
  }

  test("PATCH stores a per-step sample output", async () => {
    const { flow, version } = await setupVersion();
    const r = createWorkflowRoutes();
    const patch = r["/api/workflows/:id/versions/:versionId/sample-data/:stepName"]?.PATCH;
    const { status, body } = await callJson(
      patch,
      reqWithParams(
        "PATCH",
        `http://x/api/workflows/${flow.id}/versions/${version.id}/sample-data/step_a`,
        { id: flow.id, versionId: version.id, stepName: "step_a" },
        { output: { hello: "world", n: 42 } },
      ),
    );
    expect(status).toBe(200);
    expect(body.sampleData?.step_a).toEqual({ hello: "world", n: 42 });
  });

  test("PATCH with null/missing output clears the entry", async () => {
    const { flow, version } = await setupVersion();
    const { setSampleDataEntry } = await import("../db/repos/flow-version");
    setSampleDataEntry(version.id, "step_a", { x: 1 });
    const r = createWorkflowRoutes();
    const patch = r["/api/workflows/:id/versions/:versionId/sample-data/:stepName"]?.PATCH;
    const { status, body } = await callJson(
      patch,
      reqWithParams(
        "PATCH",
        `http://x/api/workflows/${flow.id}/versions/${version.id}/sample-data/step_a`,
        { id: flow.id, versionId: version.id, stepName: "step_a" },
        {},
      ),
    );
    expect(status).toBe(200);
    // Map is empty after the only entry is cleared -> column is null.
    expect(body.sampleData).toBeNull();
  });

  test("DELETE clears the entire sample-data map", async () => {
    const { flow, version } = await setupVersion();
    const { setSampleDataEntry } = await import("../db/repos/flow-version");
    setSampleDataEntry(version.id, "step_a", { x: 1 });
    setSampleDataEntry(version.id, "step_b", { y: 2 });
    const r = createWorkflowRoutes();
    const del = r["/api/workflows/:id/versions/:versionId/sample-data/:stepName"]?.DELETE;
    const { status, body } = await callJson(
      del,
      reqWithParams(
        "DELETE",
        `http://x/api/workflows/${flow.id}/versions/${version.id}/sample-data/_all`,
        { id: flow.id, versionId: version.id, stepName: "_all" },
      ),
    );
    expect(status).toBe(200);
    expect(body.sampleData).toBeNull();
  });

  test("PATCH rejects an output that exceeds the per-entry size cap", async () => {
    const { flow, version } = await setupVersion();
    const r = createWorkflowRoutes();
    const patch = r["/api/workflows/:id/versions/:versionId/sample-data/:stepName"]?.PATCH;
    // 300KB > 256KB cap. A pasted log dump would easily reach this.
    const huge = { blob: "x".repeat(300 * 1024) };
    const { status, body } = await callJson(
      patch,
      reqWithParams(
        "PATCH",
        `http://x/api/workflows/${flow.id}/versions/${version.id}/sample-data/step_a`,
        { id: flow.id, versionId: version.id, stepName: "step_a" },
        { output: huge },
      ),
    );
    expect(status).toBe(413);
    expect(body.error).toMatch(/exceeds .* bytes/);
  });

  test("PATCH on a LOCKED version surfaces an error", async () => {
    const { flow, version } = await setupVersion();
    const { lockVersion } = await import("../db/repos/flow-version");
    lockVersion(version.id);
    const r = createWorkflowRoutes();
    const patch = r["/api/workflows/:id/versions/:versionId/sample-data/:stepName"]?.PATCH;
    const { status, body } = await callJson(
      patch,
      reqWithParams(
        "PATCH",
        `http://x/api/workflows/${flow.id}/versions/${version.id}/sample-data/step_a`,
        { id: flow.id, versionId: version.id, stepName: "step_a" },
        { output: { x: 1 } },
      ),
    );
    // The repo throws on LOCKED; trapErrors should surface a 500-style err.
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.error).toMatch(/LOCKED/);
  });
});

describe("workflow API: pieces library", () => {
  test("GET /api/workflows/pieces/library returns the catalog with per-entry installed status", async () => {
    // Isolate from any pieces installed on the developer's machine.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tempDir = mkdtempSync(join(tmpdir(), "jarvis-lib-api-"));
    const prev = process.env.JARVIS_PIECES_DIR;
    process.env.JARVIS_PIECES_DIR = tempDir;
    try {
      const r = createWorkflowRoutes();
      const get = r["/api/workflows/pieces/library"]?.GET;
      const { status, body } = await callJson(get, plainReq("GET", "http://x/api/workflows/pieces/library"));
      expect(status).toBe(200);
      expect(Array.isArray(body.entries)).toBe(true);
      // Every entry needs the minimum shape the UI binds to.
      for (const entry of body.entries) {
        expect(typeof entry.id).toBe("string");
        expect(typeof entry.npmPackage).toBe("string");
        expect(typeof entry.versionRange).toBe("string");
        expect(typeof entry.displayName).toBe("string");
        // `installed` is null when not installed -- temp dir has no manifest.
        expect(entry.installed).toBeNull();
      }
    } finally {
      if (prev === undefined) delete process.env.JARVIS_PIECES_DIR;
      else process.env.JARVIS_PIECES_DIR = prev;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("POST /api/workflows/pieces/library/:id/install rejects an unknown piece id", async () => {
    const r = createWorkflowRoutes();
    const post = r["/api/workflows/pieces/library/:id/install"]?.POST;
    const { status, body } = await callJson(
      post,
      reqWithParams(
        "POST",
        "http://x/api/workflows/pieces/library/not-real/install",
        { id: "not-real" },
      ),
    );
    expect(status).toBe(404);
    expect(body.error).toMatch(/unknown piece id/);
  });

  test("DELETE on a never-installed piece returns 200 with alreadyAbsent (idempotent uninstall)", async () => {
    const r = createWorkflowRoutes();
    const del = r["/api/workflows/pieces/library/:id"]?.DELETE;
    const { status, body } = await callJson(
      del,
      reqWithParams(
        "DELETE",
        "http://x/api/workflows/pieces/library/gmail",
        { id: "gmail" },
      ),
    );
    expect(status).toBe(200);
    expect(body.alreadyAbsent).toBe(true);
  });

  test("DELETE works for a piece installed but no longer in the catalog (security-yank scenario)", async () => {
    // Set up a manifest with an id that doesn't exist in CATALOG. Simulates
    // the case where we yanked the entry from the catalog (e.g., advisory)
    // but the user already had it installed; they must still be able to
    // uninstall through the UI.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tempDir = mkdtempSync(join(tmpdir(), "jarvis-lib-delete-"));
    const prev = process.env.JARVIS_PIECES_DIR;
    process.env.JARVIS_PIECES_DIR = tempDir;
    try {
      const { writeManifest } = await import("../pieces-library/installer");
      await writeManifest(
        {
          version: 1,
          pieces: [
            {
              id: "yanked-piece",
              npmPackage: "@activepieces/piece-yanked",
              versionRange: "^0.1.0",
              resolvedVersion: "0.1.0",
              installedAt: Date.now(),
            },
          ],
        },
        tempDir,
      );

      const r = createWorkflowRoutes();
      const del = r["/api/workflows/pieces/library/:id"]?.DELETE;
      const { status, body } = await callJson(
        del,
        reqWithParams(
          "DELETE",
          "http://x/api/workflows/pieces/library/yanked-piece",
          { id: "yanked-piece" },
        ),
      );
      // Must NOT return 404 just because the catalog forgot the piece --
      // that would strand the user.
      expect(status).toBe(200);
      expect(body.uninstalled).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.JARVIS_PIECES_DIR;
      else process.env.JARVIS_PIECES_DIR = prev;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("DELETE returns 404 only when neither catalog nor manifest knows the id", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tempDir = mkdtempSync(join(tmpdir(), "jarvis-lib-delete-404-"));
    const prev = process.env.JARVIS_PIECES_DIR;
    process.env.JARVIS_PIECES_DIR = tempDir;
    try {
      const r = createWorkflowRoutes();
      const del = r["/api/workflows/pieces/library/:id"]?.DELETE;
      const { status, body } = await callJson(
        del,
        reqWithParams(
          "DELETE",
          "http://x/api/workflows/pieces/library/totally-fake",
          { id: "totally-fake" },
        ),
      );
      expect(status).toBe(404);
      expect(body.error).toMatch(/unknown piece id/);
    } finally {
      if (prev === undefined) delete process.env.JARVIS_PIECES_DIR;
      else process.env.JARVIS_PIECES_DIR = prev;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
