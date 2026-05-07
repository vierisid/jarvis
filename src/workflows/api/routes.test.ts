/**
 * Tests for the workflow API route handlers. Invokes handlers directly with
 * synthesized Request objects so we don't need to bring up Bun.serve.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../db/index";
import { queueStats } from "../db/repos/job-queue";
import { createWorkflowRoutes, type WorkflowRouteMap } from "./routes";

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
