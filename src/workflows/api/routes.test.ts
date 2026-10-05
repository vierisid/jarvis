import { configureWorkflowReadiness } from '../db/repos/flow-readiness';
import { PieceCatalog } from '../runtime/piece-catalog';
/**
 * Tests for the workflow API route handlers. Invokes handlers directly with
 * synthesized Request objects so we don't need to bring up Bun.serve.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../db/index";
import { setEncryptionKey } from "../db/encryption";
import { queueStats } from "../db/repos/job-queue";
import { updateFlowMetadata } from "../db/repos/flow";
import {
  createWorkflowRoutes,
  FLOW_VERSION_REF_ID_MAX_CHARS,
  FLOW_VERSION_REF_IDS_MAX_ENTRIES,
  RUN_TRIGGERED_BY_MAX_CHARS,
  WAITPOINT_RESUME_MAX_BODY_BYTES,
  WAITPOINT_RESUME_PER_ID_PER_MINUTE,
  WAITPOINT_RESUME_UNKNOWN_ID_PER_MINUTE,
  VERSION_WRITE_MAX_BODY_BYTES,
  type WorkflowRouteMap,
} from "./routes";
import { sampleCatalog } from "../runtime/test-fixtures";

let routes: WorkflowRouteMap;

// Pin the connection-encryption key: without it the module resolves the
// developer's real key file (and generates one into their live data dir).
beforeEach(() => {
  initWorkflowDb(":memory:");
  configureWorkflowReadiness({ tool: name => name === "run_command" ? { params: [{ name: "command", type: "string", required: true }] } : null, pieces: new PieceCatalog([...sampleCatalog().list(),
    { name: 'jarvis-tool', displayName: '', description: '', actions: { invoke: { name: 'invoke', displayName: '', description: '' } } },
  ]) });
  setEncryptionKey(Buffer.alloc(32, 0x12));
  routes = createWorkflowRoutes();
});

afterEach(() => {
  closeWorkflowDb();
  setEncryptionKey(null);
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

/** `GET /api/workflows/:id/runs`'s body since #652. */
type RunsPage<T = unknown> = { items: T[]; nextOffset: number | null };

async function callJson(handler: unknown, req: Request | (Request & { params: Record<string, string> })) {
  const fn = handler as (r: Request) => Promise<Response> | Response;
  const res = await fn(req as Request);
  return { status: res.status, body: await res.json() };
}

/**
 * #598. `flow.metadata` was a verbatim caller-controlled JSON document of
 * unbounded size: both writers cast the request body and passed
 * `body.metadata` straight to `JSON.stringify`, with no type check and no size
 * limit, and `manage_workflow`'s `summarizeFlow` then read it back with a raw
 * `JSON.parse` and put it in chat tool output.
 *
 * This is the write half. The read half -- a much tighter per-flow cap, which is
 * what covers rows written before this existed -- is in
 * `actions/tools/manage-workflow.test.ts`. Both halves are needed: a write cap
 * does nothing for a row already over it.
 */
describe("#598: flow metadata is validated and bounded on the way in", () => {
  const create = (body: unknown) =>
    callJson(routes["/api/workflows"]?.POST, plainReq("POST", "http://x/api/workflows", body));
  const patch = (id: string, body: unknown) =>
    callJson(
      routes["/api/workflows/:id"]?.PATCH,
      reqWithParams("PATCH", `http://x/api/workflows/${id}`, { id }, body),
    );

  async function makeFlow(): Promise<string> {
    const { body } = await create({ displayName: "host" });
    return (body as { flow: { id: string } }).flow.id;
  }

  test("a small object is accepted on both writers, and round-trips", async () => {
    const metadata = { opportunityId: "opp_1", compositionId: "cmp_1", feedbackId: "fbk_1" };
    const created = await create({ displayName: "with metadata", metadata });
    expect(created.status).toBe(201);
    expect((created.body as { flow: { metadata: unknown } }).flow.metadata).toEqual(metadata);

    const patched = await patch((created.body as { flow: { id: string } }).flow.id, { metadata: { tag: "x" } });
    expect(patched.status).toBe(200);
    expect((patched.body as { metadata: unknown }).metadata).toEqual({ tag: "x" });
  });

  test("null is accepted and clears the column", async () => {
    const { body } = await create({ displayName: "clearable", metadata: { tag: "x" } });
    const id = (body as { flow: { id: string } }).flow.id;
    const cleared = await patch(id, { metadata: null });
    expect(cleared.status).toBe(200);
    expect((cleared.body as { metadata: unknown }).metadata).toBeNull();
  });

  /**
   * The type check is not cosmetic. `body.metadata` was only ever CAST to
   * `Record<string, unknown> | null`, so each of these reached the column and
   * came back out of `parseFlowMetadata` as something that is not an object, in
   * a field every reader treats as one.
   */
  test.each([
    ["a string", "just text"],
    ["a number", 7],
    ["an array", [{ tag: "x" }]],
    ["a boolean", true],
  ])("%s is refused with 400 rather than stored", async (_label, metadata) => {
    const created = await create({ displayName: "bad type", metadata });
    expect(created.status).toBe(400);
    expect((created.body as { error: string }).error).toMatch(/metadata must be a JSON object or null/);

    const id = await makeFlow();
    const patched = await patch(id, { metadata });
    expect(patched.status).toBe(400);
    expect((patched.body as { error: string }).error).toMatch(/metadata must be a JSON object or null/);
  });

  /**
   * Prototype keys are DEFENCE IN DEPTH, not a claim. `JSON.parse` defines
   * `__proto__` as an ordinary own property rather than invoking the setter, and
   * all three readers nest the value and re-serialize it rather than merging it,
   * so such a key is inert in this repo today. It stops being inert if a
   * consumer ever `Object.assign`s it -- and one consumer is the vendored
   * activepieces engine, via the sandbox API. Only TOP-LEVEL keys are refused.
   */
  test.each(["__proto__", "constructor", "prototype"])(
    "a top-level %s key is refused",
    async (key) => {
      const { status, body } = await create({
        displayName: "polluter",
        metadata: JSON.parse(`{"${key}": {"polluted": true}}`),
      });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(new RegExp(`must not carry a ${key === "__proto__" ? "__proto__" : key} key`));
    },
  );

  test("an oversized document is refused with 413, naming both sizes", async () => {
    const metadata = { pad: "z".repeat(20_000) };
    const created = await create({ displayName: "too big", metadata });
    // 413, not 400: every other size refusal in this file is a 413, and a
    // client should be able to tell "wrong shape" from "too big" by status.
    expect(created.status).toBe(413);
    expect((created.body as { error: string }).error).toMatch(/metadata is \d+ characters; the limit is 16384/);

    const id = await makeFlow();
    const patched = await patch(id, { metadata });
    expect(patched.status).toBe(413);
    expect((patched.body as { error: string }).error).toMatch(/metadata is \d+ characters; the limit is 16384/);
  });

  /**
   * The boundary, pinned in both directions. Without this an off-by-one between
   * `>` and `>=` is invisible, and nothing stops a future change tightening the
   * constant -- the accept case is what makes 16 KB a real commitment rather
   * than an upper bound nobody tests.
   */
  test("exactly at the limit is accepted; one character over is refused", async () => {
    // `{"pad":""}` is 10 characters of envelope around the value.
    const atLimit = { pad: "z".repeat(16_384 - 10) };
    const accepted = await create({ displayName: "exact", metadata: atLimit });
    expect(accepted.status).toBe(201);
    expect(JSON.stringify((accepted.body as { flow: { metadata: unknown } }).flow.metadata).length).toBe(16_384);

    const over = { pad: "z".repeat(16_384 - 9) };
    const refused = await create({ displayName: "one over", metadata: over });
    expect(refused.status).toBe(413);
  });

  test("an empty object is accepted and stored as an empty object", async () => {
    const { status, body } = await create({ displayName: "empty meta", metadata: {} });
    expect(status).toBe(201);
    // `createFlow`'s truthiness check treats `{}` as a value, so it is stored
    // as `{}` rather than collapsing to null.
    expect((body as { flow: { metadata: unknown } }).flow.metadata).toEqual({});
  });

  /**
   * Depth rather than size, which is the shape that gets past a byte check and
   * then blows up somewhere else. `JSON.parse` survives far deeper nesting than
   * `JSON.stringify`, which raises a RangeError.
   *
   * The body is built as RAW TEXT, because `JSON.stringify` cannot serialize it
   * -- which is the point, and is also why the test helper cannot be used.
   *
   * The assertion is "refused, and never a 500", not a specific status: at ~5
   * characters per level any document deep enough to overflow `JSON.stringify`
   * is also past the 256 KB body cap, so in practice the body cap catches it
   * first and the serializability branch in `metadataRejection` is defence in
   * depth behind it. Pinning 413 here would be pinning which guard happens to
   * fire.
   */
  test("a deeply nested body is refused, and never becomes a 500", async () => {
    const depth = 100_000;
    const raw = `{"displayName":"deep","metadata":${'{"n":'.repeat(depth)}1${"}".repeat(depth)}}`;
    const res = await (routes["/api/workflows"]?.POST as (r: Request) => Promise<Response>)(
      new Request("http://x/api/workflows", {
        method: "POST",
        body: raw,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("a body larger than the route cap is refused before it is parsed", async () => {
    const huge = { displayName: "big body", metadata: { pad: "z".repeat(300_000) } };
    const { status, body } = await create(huge);
    expect(status).toBe(413);
    expect((body as { error: string }).error).toMatch(/request body too large/);
  });

  /**
   * The deliberate no-migration decision, pinned so a later "fix" to
   * `serializeFlow` cannot quietly change it. A row written before the cap
   * existed keeps being served IN FULL here; what keeps it out of the chat
   * prompt is the much tighter per-flow cap in `summarizeFlow`, which is
   * asserted in `actions/tools/manage-workflow.test.ts`.
   */
  test("a legacy oversized row is left alone and still served in full", async () => {
    const id = await makeFlow();
    const legacy = { pad: "L".repeat(40_000) };
    // Straight past the route, the way a pre-#598 write landed.
    updateFlowMetadata(id, legacy);
    const { status, body } = await callJson(
      routes["/api/workflows/:id"]?.GET,
      reqWithParams("GET", `http://x/api/workflows/${id}`, { id }),
    );
    expect(status).toBe(200);
    expect((body as { flow: { metadata: unknown } }).flow.metadata).toEqual(legacy);
  });

  /**
   * `displayName` is the other caller-written field that reaches the model as a
   * flow's `name`, and it was the looser of the two: this route checked only
   * that it was a non-empty string, `POST .../versions` checked only
   * truthiness, and `PATCH .../versions/:versionId` checked nothing at all.
   */
  test("displayName is type-checked and bounded on the flow create route", async () => {
    expect((await create({ displayName: 42 })).status).toBe(400);
    expect((await create({ displayName: "" })).status).toBe(400);
    const long = await create({ displayName: "N".repeat(1000) });
    expect(long.status).toBe(413);
    expect((long.body as { error: string }).error).toMatch(/displayName is 1000 characters; the limit is 512/);
    expect((await create({ displayName: "N".repeat(512) })).status).toBe(201);
  });

  test("displayName is bounded on both version write routes too", async () => {
    const id = await makeFlow();
    const postVersion = (b: unknown) =>
      callJson(
        routes["/api/workflows/:id/versions"]?.POST,
        reqWithParams("POST", `http://x/api/workflows/${id}/versions`, { id }, b),
      );
    expect((await postVersion({ displayName: 42 })).status).toBe(400);
    expect((await postVersion({ displayName: "N".repeat(1000) })).status).toBe(413);

    const created = await postVersion({ displayName: "fine" });
    const versionId = (created.body as { id: string }).id;
    const patchVersion = (b: unknown) =>
      callJson(
        routes["/api/workflows/:id/versions/:versionId"]?.PATCH,
        reqWithParams(
          "PATCH",
          `http://x/api/workflows/${id}/versions/${versionId}`,
          { id, versionId },
          b,
        ),
      );
    expect((await patchVersion({ displayName: 42 })).status).toBe(400);
    expect((await patchVersion({ displayName: "N".repeat(1000) })).status).toBe(413);
    // Omitted is still a no-op, since displayName is optional on a patch.
    expect((await patchVersion({ valid: true })).status).toBe(200);
  });

  test("the flow listing clamps limit, so one request cannot pull every row", async () => {
    const { status, body } = await callJson(
      routes["/api/workflows"]?.GET,
      plainReq("GET", "http://x/api/workflows?limit=100000"),
    );
    expect(status).toBe(200);
    expect((body as unknown[]).length).toBeLessThanOrEqual(100);
  });

  /**
   * The atomicity half. `status` and `metadata` used to be checked one at a
   * time AS they were applied, so a request carrying a good status and a bad
   * metadata changed the status and then failed -- a partial write the caller
   * was never told about.
   */
  test("a rejected metadata leaves a valid status in the same PATCH unapplied", async () => {
    const id = await makeFlow();
    const { status, body } = await patch(id, { status: "ENABLED", metadata: "not an object" });
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/metadata must be a JSON object/);

    const after = await callJson(
      routes["/api/workflows/:id"]?.GET,
      reqWithParams("GET", `http://x/api/workflows/${id}`, { id }),
    );
    expect((after.body as { flow: { status: string } }).flow.status).toBe("DISABLED");
  });

  test("an omitted metadata still leaves the column alone", async () => {
    const { body } = await create({ displayName: "keeps", metadata: { keep: "me" } });
    const id = (body as { flow: { id: string } }).flow.id;
    const patched = await patch(id, { status: "ENABLED" });
    expect(patched.status).toBe(200);
    expect((patched.body as { metadata: unknown }).metadata).toEqual({ keep: "me" });
  });
});

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
  test("PATCH saves an invalid draft but derives valid instead of trusting the client", async () => {
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
    expect(body.valid).toBe(false);
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
    // No inventory injected -> no verdict to give.
    expect(body.osWarnings).toBeUndefined();
  });

  test("POST .../lock reports a step that cannot run on any machine it could land on", async () => {
    // The editor's only OS check: a hand-drawn flow never meets the composer,
    // where the same rules run for a composed one.
    const withTargets = createWorkflowRoutes({
      executionTargets: () => [
        { id: "sc-mac", name: "Lapo's MacBook", os: "darwin", arch: "arm64", connected: true },
      ],
    });
    const post = withTargets["/api/workflows"]?.POST;
    const created = await callJson(post, plainReq("POST", "http://x", { displayName: "x" }));
    const { id: flowId } = created.body.flow;
    const versionId = created.body.version.id;

    const patch = withTargets["/api/workflows/:id/versions/:versionId"]?.PATCH;
    await callJson(
      patch,
      reqWithParams("PATCH", `http://x/api/workflows/${flowId}/versions/${versionId}`, { id: flowId, versionId }, {
        trigger: {
          name: "trigger",
          type: "EMPTY",
          nextAction: {
            name: "step_1",
            type: "PIECE",
            settings: {
              pieceName: "jarvis-tool",
              actionName: "invoke",
              input: { toolName: "run_command", params: { command: "notepad.exe" } },
            },
          },
        },
      }),
    );

    const lock = withTargets["/api/workflows/:id/versions/:versionId/lock"]?.POST;
    const { status, body } = await callJson(
      lock,
      reqWithParams("POST", `http://x/api/workflows/${flowId}/versions/${versionId}/lock`, { id: flowId, versionId }),
    );
    // Advisory: the lock still succeeds. A draft may legitimately target a
    // machine that is not enrolled yet.
    expect(status).toBe(200);
    expect(body.state).toBe("LOCKED");
    expect(body.osWarnings[0]).toContain("notepad.exe");
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
    expect((body as RunsPage).items.length).toBe(2);
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

/**
 * Ingress guards on the one public route in this file. Every budget test
 * drives a fake clock through `waitpointResumeLimits.now` -- the windows are
 * sliding and clock-driven, so nothing here sleeps or depends on wall time.
 */
describe("workflow API: waitpoint resume ingress guards", () => {
  /** A run parked at PAUSED with a live waitpoint on it, as the route expects. */
  async function pausedWaitpoint(): Promise<{ runId: string; waitpointId: string }> {
    const { createFlow, setPublishedVersion, updateFlowStatus } = await import("../db/repos/flow");
    const { createDraftVersion, lockVersion } = await import("../db/repos/flow-version");
    const { createFlowRun, updateRun } = await import("../db/repos/flow-run");
    const { createWaitpoint } = await import("../db/repos/waitpoint");
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
    const run = createFlowRun({ flowId: flow.id, flowVersionId: v.id, environment: "TESTING" });
    updateRun(run.id, { status: "PAUSED" });
    const wp = createWaitpoint({
      flowRunId: run.id,
      projectId: DEFAULT_IDS.project,
      stepName: "step_pause",
      type: "WEBHOOK",
    });
    return { runId: run.id, waitpointId: wp.id };
  }

  /** A fake clock the rate-limit windows read; tests move it by hand. */
  function fakeClock(start = 1_700_000_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  }

  const hit = (
    post: unknown,
    id: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => {
    const init: RequestInit = { method: "POST" };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
      init.headers = { "Content-Type": "application/json", ...(headers ?? {}) };
    } else if (headers) {
      init.headers = headers;
    }
    const req = new Request(`http://x/api/webhooks/waitpoints/${id}`, init) as Request & {
      params: { id: string };
    };
    req.params = { id };
    return callJson(post, req);
  };

  test("per-id budget refuses the 61st hit on one waitpoint with 429 + Retry-After", async () => {
    const clock = fakeClock();
    const r = createWorkflowRoutes({ waitpointResumeLimits: { now: clock.now } });
    const post = r["/api/webhooks/waitpoints/:id"]?.POST;
    const { waitpointId } = await pausedWaitpoint();

    // First hit resumes the waitpoint (202); every later hit is a 410, and a
    // 410 still spends budget -- that is the point, a retry storm on one id
    // has to be bounded whether or not the retries can do anything.
    const first = await hit(post, waitpointId, {});
    expect(first.status).toBe(202);
    for (let i = 2; i <= WAITPOINT_RESUME_PER_ID_PER_MINUTE; i++) {
      const res = await hit(post, waitpointId, {});
      expect(res.status).toBe(410);
    }

    const overBudget = await hit(post, waitpointId, {});
    expect(overBudget.status).toBe(429);

    // And the window is a window: once it slides past, the id is served again.
    clock.advance(61_000);
    const afterWindow = await hit(post, waitpointId, {});
    expect(afterWindow.status).toBe(410);
  });

  test("per-id 429 carries a Retry-After the sender can honour", async () => {
    const clock = fakeClock();
    const r = createWorkflowRoutes({ waitpointResumeLimits: { now: clock.now } });
    const post = r["/api/webhooks/waitpoints/:id"]?.POST;
    const { waitpointId } = await pausedWaitpoint();
    for (let i = 0; i < WAITPOINT_RESUME_PER_ID_PER_MINUTE; i++) await hit(post, waitpointId, {});

    const req = new Request(`http://x/api/webhooks/waitpoints/${waitpointId}`, {
      method: "POST",
    }) as Request & { params: { id: string } };
    req.params = { id: waitpointId };
    const res = await (post as (q: Request) => Promise<Response>)(req);
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  test("unknown-id probes burn their own budget and leave real resumes untouched", async () => {
    const clock = fakeClock();
    const r = createWorkflowRoutes({ waitpointResumeLimits: { now: clock.now } });
    const post = r["/api/webhooks/waitpoints/:id"]?.POST;
    const { waitpointId } = await pausedWaitpoint();

    for (let i = 0; i < WAITPOINT_RESUME_UNKNOWN_ID_PER_MINUTE; i++) {
      const res = await hit(post, `no-such-waitpoint-${i}`, {});
      expect(res.status).toBe(404);
    }
    // Enumeration is no longer free: the next guess costs a 429, not an answer.
    const probe = await hit(post, "no-such-waitpoint-overflow", {});
    expect(probe.status).toBe(429);

    // The probe flood must not have locked out the legitimate resumer: the
    // enumeration budget is deliberately separate from the resume budgets.
    const real = await hit(post, waitpointId, { externalSignal: "wake-up" });
    expect(real.status).toBe(202);
  });

  test("backlog cap answers 503 without resuming the waitpoint", async () => {
    const { MAX_QUEUED_WEBHOOK_RUNS } = await import("../runner/triggers/manager");
    const { getWaitpoint } = await import("../db/repos/waitpoint");
    const r = createWorkflowRoutes({
      waitpointResumeLimits: { queueDepth: () => MAX_QUEUED_WEBHOOK_RUNS },
    });
    const post = r["/api/webhooks/waitpoints/:id"]?.POST;
    const { waitpointId } = await pausedWaitpoint();
    const before = queueStats().queued;

    const res = await hit(post, waitpointId, {});
    expect(res.status).toBe(503);
    expect(queueStats().queued).toBe(before);
    expect(getWaitpoint(waitpointId)?.resumedAt).toBeNull();
  });

  test("a body whose declared size is over the cap is refused with 413", async () => {
    const r = createWorkflowRoutes();
    const post = r["/api/webhooks/waitpoints/:id"]?.POST;
    const { waitpointId } = await pausedWaitpoint();
    const { getWaitpoint } = await import("../db/repos/waitpoint");

    const res = await hit(post, waitpointId, { small: true }, {
      "Content-Length": String(WAITPOINT_RESUME_MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(getWaitpoint(waitpointId)?.resumedAt).toBeNull();
  });

  test("a body over the cap is refused on its actual size when it declares none", async () => {
    const r = createWorkflowRoutes();
    const post = r["/api/webhooks/waitpoints/:id"]?.POST;
    const { waitpointId } = await pausedWaitpoint();
    const { getWaitpoint } = await import("../db/repos/waitpoint");

    // A body built this way declares no content-length in Bun, so this is the
    // read-it-and-measure branch rather than the header branch above.
    const oversized = JSON.stringify({ blob: "a".repeat(WAITPOINT_RESUME_MAX_BODY_BYTES) });
    const req = new Request(`http://x/api/webhooks/waitpoints/${waitpointId}`, {
      method: "POST",
      body: oversized,
    }) as Request & { params: { id: string } };
    req.params = { id: waitpointId };
    expect(req.headers.get("content-length")).toBeNull();

    const res = await (post as (q: Request) => Promise<Response>)(req);
    expect(res.status).toBe(413);
    expect(getWaitpoint(waitpointId)?.resumedAt).toBeNull();
  });

  test("a JSON body that is not an object is refused instead of silently becoming {}", async () => {
    const r = createWorkflowRoutes();
    const post = r["/api/webhooks/waitpoints/:id"]?.POST;
    const { waitpointId } = await pausedWaitpoint();
    const { getWaitpoint } = await import("../db/repos/waitpoint");

    const res = await hit(post, waitpointId, [1, 2, 3]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/JSON object/);
    expect(getWaitpoint(waitpointId)?.resumedAt).toBeNull();
  });

  test("empty and non-JSON bodies are still tolerated and resume with {}", async () => {
    const { claimNextJob } = await import("../db/repos/job-queue");
    const r = createWorkflowRoutes();
    const post = r["/api/webhooks/waitpoints/:id"]?.POST;

    const empty = await pausedWaitpoint();
    expect((await hit(post, empty.waitpointId)).status).toBe(202);
    expect(claimNextJob<{ resumePayload?: Record<string, unknown> }>()?.payload.resumePayload).toEqual({});

    const formish = await pausedWaitpoint();
    expect((await hit(post, formish.waitpointId, "a=1&b=2")).status).toBe(202);
    expect(claimNextJob<{ resumePayload?: Record<string, unknown> }>()?.payload.resumePayload).toEqual({});
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

/**
 * #650. PATCH found its row by id (no project predicate) and then wrote it
 * through `upsertConnection` with no `projectId`, which resolves its target by
 * `(DEFAULT_IDS.project, pieceName, externalId)`. For a row outside the
 * default project that is a different identity tuple, so PATCH did not update
 * the row it was asked about: it INSERTED a second row in the default project,
 * re-sealing the first row's decrypted secret under the new row's identity.
 * The row binding stops a blob being moved; it does not stop a
 * decrypt-and-reseal, which is what this was.
 *
 * `project_id` is a constant in production today, so no live caller reaches
 * this. The test writes a second project directly, which is exactly the state
 * the day projects stop being constant.
 *
 * Since #692 the `:id` routes only reach a row in the caller's project, so
 * these act AS a caller in the second project. That is the state #650 needs:
 * the defect was the write defaulting to `DEFAULT_IDS.project`, which differs
 * from the row's project whoever the caller is, so a regression to the upsert
 * would still copy the secret into the default project and fail here.
 */
describe("#650: the connections PATCH updates the row it was asked about", () => {
  const OTHER_PROJECT = "proj_other_650";
  let scoped: WorkflowRouteMap;
  beforeEach(() => {
    scoped = createWorkflowRoutes({ callerProjectId: () => OTHER_PROJECT });
  });

  async function seedInOtherProject() {
    const { upsertConnection } = await import("../db/repos/app-connection");
    return upsertConnection({
      projectId: OTHER_PROJECT,
      externalId: "scoped-650",
      displayName: "Scoped",
      type: "SECRET_TEXT",
      pieceName: "@activepieces/piece-foo",
      pieceVersion: "0.0.1",
      value: { secret: "only-in-other-project" },
    });
  }

  function patch(id: string, body: unknown) {
    return callJson(
      scoped["/api/workflows/connections/:id"]?.PATCH,
      reqWithParams("PATCH", `http://x/api/workflows/connections/${id}`, { id }, body),
    );
  }

  async function allRows() {
    const { getWorkflowDb } = await import("../db/index");
    return getWorkflowDb()
      .query<{ id: string; project_id: string }, []>("SELECT id, project_id FROM app_connection ORDER BY id")
      .all();
  }

  test("a displayName-only PATCH keeps the id and copies the secret nowhere", async () => {
    const { listConnections, getConnection } = await import("../db/repos/app-connection");
    const { DEFAULT_IDS } = await import("../db/schema");
    const conn = await seedInOtherProject();

    const res = await patch(conn.id, { displayName: "Renamed" });
    expect(res.status).toBe(200);
    // The id in the answer is the id in the URL, not a freshly minted one.
    expect((res.body as { id: string }).id).toBe(conn.id);
    // Still exactly one row, still in its own project.
    expect(await allRows()).toEqual([{ id: conn.id, project_id: OTHER_PROJECT }]);
    // And the default project holds no copy of the secret.
    expect(listConnections(DEFAULT_IDS.project)).toEqual([]);

    const fresh = getConnection(conn.id);
    expect(fresh?.displayName).toBe("Renamed");
    expect(fresh?.projectId).toBe(OTHER_PROJECT);
    expect(fresh?.value).toEqual({ secret: "only-in-other-project" });
  });

  test("a value rotation lands on the same row", async () => {
    const { getConnection } = await import("../db/repos/app-connection");
    const conn = await seedInOtherProject();

    const res = await patch(conn.id, { value: { secret: "rotated" } });
    expect(res.status).toBe(200);
    expect((res.body as { id: string }).id).toBe(conn.id);
    expect(await allRows()).toEqual([{ id: conn.id, project_id: OTHER_PROJECT }]);
    expect(getConnection(conn.id)?.value).toEqual({ secret: "rotated" });
  });

  /**
   * The same "update the row, do not rewrite it" property, one column over:
   * the upsert PATCH wrote through kept `owner_id`, `scope` and
   * `pre_select_for_new_projects` when the input left them out, but wrote
   * `metadata = NULL`, so every rotation wiped it.
   */
  test("a PATCH keeps the row's metadata", async () => {
    const { upsertConnection, getConnection } = await import("../db/repos/app-connection");
    const conn = upsertConnection({
      projectId: OTHER_PROJECT,
      externalId: "meta-650",
      displayName: "Meta",
      type: "SECRET_TEXT",
      pieceName: "@activepieces/piece-foo",
      pieceVersion: "0.0.1",
      value: { secret: "s" },
      metadata: { region: "eu" },
    });
    expect(getConnection(conn.id)?.metadata).toEqual({ region: "eu" });

    const res = await patch(conn.id, { value: { secret: "s2" } });
    expect(res.status).toBe(200);
    // On the row itself, or this would pass by missing it.
    expect((res.body as { id: string }).id).toBe(conn.id);
    expect(getConnection(conn.id)?.value).toEqual({ secret: "s2" });
    expect(getConnection(conn.id)?.metadata).toEqual({ region: "eu" });
  });

  /** A rename is not a rotation: the stored ciphertext is left byte-exact. */
  test("a displayName-only PATCH does not re-seal the secret", async () => {
    const conn = await seedInOtherProject();
    const { getWorkflowDb } = await import("../db/index");
    const stored = () =>
      getWorkflowDb().query<{ value: string }, [string]>("SELECT value FROM app_connection WHERE id = ?").get(conn.id)
        ?.value;
    const before = stored();
    expect(before).toBeString();

    const res = await patch(conn.id, { displayName: "Renamed again" });
    expect(res.status).toBe(200);
    // On the row itself, or this would pass by missing it.
    expect((res.body as { id: string }).id).toBe(conn.id);
    expect(await allRows()).toEqual([{ id: conn.id, project_id: OTHER_PROJECT }]);
    expect(stored()).toBe(before);
  });

  /**
   * The route reads the row, then awaits the body, then writes. A body that
   * is still streaming holds that window open for as long as the client likes.
   */
  function streamingPatch(id: string) {
    let push!: (body: unknown) => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (body) => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
          controller.close();
        };
      },
    });
    const req = new Request(`http://x/api/workflows/connections/${id}`, {
      method: "PATCH",
      body: stream,
      headers: { "Content-Type": "application/json" },
      duplex: "half",
    } as RequestInit) as Request & { params: { id: string } };
    req.params = { id };
    const pending = callJson(scoped["/api/workflows/connections/:id"]?.PATCH, req);
    return { pending, push };
  }

  test("a DELETE that lands while the body is in flight is not undone", async () => {
    const conn = await seedInOtherProject();
    const { pending, push } = streamingPatch(conn.id);

    const deleted = await callJson(
      scoped["/api/workflows/connections/:id"]?.DELETE,
      reqWithParams("DELETE", `http://x/api/workflows/connections/${conn.id}`, { id: conn.id }),
    );
    expect(deleted.status).toBe(200);

    push({ displayName: "Too late" });
    const res = await pending;
    expect(res.status).toBe(404);
    // The deleted secret did not come back under a fresh id.
    expect(await allRows()).toEqual([]);
  });

  test("a rename in flight does not write back a secret rotated meanwhile", async () => {
    const { getConnection } = await import("../db/repos/app-connection");
    const conn = await seedInOtherProject();
    const { pending, push } = streamingPatch(conn.id);

    const rotated = await patch(conn.id, { value: { secret: "rotated-meanwhile" } });
    expect(rotated.status).toBe(200);

    push({ displayName: "Renamed late" });
    expect((await pending).status).toBe(200);
    const fresh = getConnection(conn.id);
    expect(fresh?.displayName).toBe("Renamed late");
    expect(fresh?.value).toEqual({ secret: "rotated-meanwhile" });
  });
});

/**
 * #692. The connections GET listed `DEFAULT_IDS.project` and the POST wrote
 * there, while DELETE and PATCH found their row by bare id in any project. So
 * an id that the list never showed could still be deleted or rewritten.
 * Latent while `project_id` is a constant; these write a second project
 * directly, which is the state the day it is not.
 */
describe("#692: the connections routes share one project scope", () => {
  const OTHER_PROJECT = "proj_other_692";

  async function seed(projectId: string, externalId: string) {
    const { upsertConnection } = await import("../db/repos/app-connection");
    return upsertConnection({
      projectId,
      externalId,
      displayName: "Seeded",
      type: "SECRET_TEXT",
      pieceName: "@activepieces/piece-foo",
      pieceVersion: "0.0.1",
      value: { secret: `in-${projectId}` },
    });
  }

  async function storedRow(id: string) {
    const { getWorkflowDb } = await import("../db/index");
    return getWorkflowDb()
      .query<{ id: string; project_id: string; display_name: string; value: string; updated: number }, [string]>(
        "SELECT id, project_id, display_name, value, updated FROM app_connection WHERE id = ?",
      )
      .get(id);
  }

  test("PATCH and DELETE answer 404 for an id in another project, and leave it untouched", async () => {
    const foreign = await seed(OTHER_PROJECT, "foreign-692");
    const before = await storedRow(foreign.id);
    expect(before?.project_id).toBe(OTHER_PROJECT);

    for (const body of [{ displayName: "Hijacked" }, { value: { secret: "overwritten" } }]) {
      const res = await callJson(
        routes["/api/workflows/connections/:id"]?.PATCH,
        reqWithParams("PATCH", `http://x/api/workflows/connections/${foreign.id}`, { id: foreign.id }, body),
      );
      expect(res).toEqual({ status: 404, body: { error: "connection not found" } });
    }
    const del = await callJson(
      routes["/api/workflows/connections/:id"]?.DELETE,
      reqWithParams("DELETE", `http://x/api/workflows/connections/${foreign.id}`, { id: foreign.id }),
    );
    expect(del.status).toBe(404);
    expect(del.body.error).toBe("connection not found");

    // Byte-exact: same name, same ciphertext, same timestamp, same project.
    expect(await storedRow(foreign.id)).toEqual(before);

    // And indistinguishable from an id that exists nowhere, so the answer
    // does not confirm that a guessed id is real in some other project.
    const missing = "conn_does_not_exist_692";
    const missingPatch = await callJson(
      routes["/api/workflows/connections/:id"]?.PATCH,
      reqWithParams("PATCH", `http://x/api/workflows/connections/${missing}`, { id: missing }, { displayName: "x" }),
    );
    const missingDel = await callJson(
      routes["/api/workflows/connections/:id"]?.DELETE,
      reqWithParams("DELETE", `http://x/api/workflows/connections/${missing}`, { id: missing }),
    );
    expect(missingPatch).toEqual({ status: 404, body: { error: "connection not found" } });
    expect(missingDel).toEqual(del);
  });

  test("a caller in that project can still PATCH and DELETE the same row", async () => {
    // The control for the 404s above: they are about the project, not the route.
    const own = await seed(OTHER_PROJECT, "own-692");
    const scoped = createWorkflowRoutes({ callerProjectId: () => OTHER_PROJECT });
    const patched = await callJson(
      scoped["/api/workflows/connections/:id"]?.PATCH,
      reqWithParams("PATCH", `http://x/api/workflows/connections/${own.id}`, { id: own.id }, { displayName: "Mine" }),
    );
    expect(patched.status).toBe(200);
    expect((await storedRow(own.id))?.display_name).toBe("Mine");
    const del = await callJson(
      scoped["/api/workflows/connections/:id"]?.DELETE,
      reqWithParams("DELETE", `http://x/api/workflows/connections/${own.id}`, { id: own.id }),
    );
    expect(del.status).toBe(200);
    expect(await storedRow(own.id)).toBeNull();
  });

  test("GET lists, and POST writes, the caller's project rather than the default", async () => {
    const { DEFAULT_IDS } = await import("../db/schema");
    const inDefault = await seed(DEFAULT_IDS.project, "default-692");
    const inOther = await seed(OTHER_PROJECT, "other-692");
    const scoped = createWorkflowRoutes({ callerProjectId: () => OTHER_PROJECT });
    const ids = (body: unknown) => (body as { connections: Array<{ id: string }> }).connections.map((c) => c.id);

    const listed = await callJson(
      scoped["/api/workflows/connections"]?.GET,
      plainReq("GET", "http://x/api/workflows/connections"),
    );
    expect(listed.status).toBe(200);
    expect(ids(listed.body)).toEqual([inOther.id]);

    const created = await callJson(
      scoped["/api/workflows/connections"]?.POST,
      plainReq("POST", "http://x/api/workflows/connections", {
        externalId: "posted-692",
        displayName: "Posted",
        type: "SECRET_TEXT",
        pieceName: "@activepieces/piece-foo",
        value: { secret: "s" },
      }),
    );
    expect(created.status).toBe(201);
    expect((await storedRow((created.body as { id: string }).id))?.project_id).toBe(OTHER_PROJECT);

    // And the default caller still sees only the default project.
    const defaultList = await callJson(
      routes["/api/workflows/connections"]?.GET,
      plainReq("GET", "http://x/api/workflows/connections"),
    );
    expect(ids(defaultList.body)).toEqual([inDefault.id]);
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

describe("workflow API: pieces library on a MANAGED install", () => {
  /**
   * Managed = a host installed the whole catalog into a read-only shared
   * tree. What these pin: the catalog is offered whole with no install state
   * and no per-piece detail, and the two mutations are refused BEFORE they
   * touch the tenant's own writable `~/.jarvis/pieces` -- which is the only
   * thing stopping a hand-rolled POST, since that directory stays writable.
   */
  const MANAGED_DIR = "/opt/jarvis-pieces/1.2.3";

  /** A temp JARVIS_PIECES_DIR, so a developer's own installs can't leak in. */
  async function withTempPiecesDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "jarvis-lib-managed-"));
    const prev = process.env.JARVIS_PIECES_DIR;
    process.env.JARVIS_PIECES_DIR = dir;
    try {
      return await fn(dir);
    } finally {
      if (prev === undefined) delete process.env.JARVIS_PIECES_DIR;
      else process.env.JARVIS_PIECES_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("GET offers the WHOLE catalog, with no install state and no detail", async () => {
    const { CATALOG } = await import("../pieces-library/catalog");
    await withTempPiecesDir(async () => {
      const r = createWorkflowRoutes({ sharedPiecesDir: MANAGED_DIR });
      const get = r["/api/workflows/pieces/library"]?.GET;
      const { status, body } = await callJson(
        get,
        plainReq("GET", "http://x/api/workflows/pieces/library"),
      );
      expect(status).toBe(200);
      expect(body.managed).toBe(true);
      // The whole catalog is available -- not the subset a user installed.
      expect(body.entries.length).toBe(CATALOG.length);
      for (const entry of body.entries) {
        // What the UI still binds to.
        expect(typeof entry.id).toBe("string");
        expect(typeof entry.npmPackage).toBe("string");
        expect(typeof entry.displayName).toBe("string");
        expect(entry.tier === "verified" || entry.tier === "community").toBe(true);
        // ...and what must not reach it. Absent on the WIRE, not merely
        // unrendered: hiding these client-side would leave a stale cached
        // bundle free to show them again.
        for (const gone of [
          "installed",
          "versionRange",
          "vettedVersion",
          "vettedAt",
          "estimatedSizeMb",
          "licenseSpdx",
          "sourceUrl",
        ]) {
          expect(Object.hasOwn(entry, gone)).toBe(false);
        }
      }
    });
  });

  test("POST install is refused, and writes nothing to the tenant's pieces dir", async () => {
    await withTempPiecesDir(async (dir) => {
      const { readdirSync } = await import("node:fs");
      const r = createWorkflowRoutes({ sharedPiecesDir: MANAGED_DIR });
      const post = r["/api/workflows/pieces/library/:id/install"]?.POST;
      const { status, body } = await callJson(
        post,
        // A REAL catalog id: a 403 that only ever fired for unknown ids
        // would be the pre-existing 404 wearing a different number.
        reqWithParams("POST", "http://x/api/workflows/pieces/library/gmail/install", {
          id: "gmail",
        }),
      );
      expect(status).toBe(403);
      expect(body.error).toMatch(/managed by this install's host/);
      // The guard has to come before the manifest write, not just before the
      // bun install -- a written manifest would be reconciled onto disk at
      // the next daemon start.
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  test("DELETE is refused even for a piece the manifest really holds", async () => {
    await withTempPiecesDir(async (dir) => {
      // A leftover user install -- e.g. made before this instance became
      // managed. Uninstall is still not the tenant's call, and the refusal
      // must not depend on the manifest being empty.
      const { writeManifest, readManifest } = await import("../pieces-library/installer");
      const piece = {
        id: "gmail",
        npmPackage: "@activepieces/piece-gmail",
        versionRange: "^0.12.2",
        resolvedVersion: "0.12.3",
        installedAt: 1,
      };
      await writeManifest({ version: 1, pieces: [piece] }, dir);

      const r = createWorkflowRoutes({ sharedPiecesDir: MANAGED_DIR });
      const del = r["/api/workflows/pieces/library/:id"]?.DELETE;
      const { status, body } = await callJson(
        del,
        reqWithParams("DELETE", "http://x/api/workflows/pieces/library/gmail", { id: "gmail" }),
      );
      expect(status).toBe(403);
      expect(body.error).toMatch(/managed by this install's host/);
      expect((await readManifest(dir)).pieces).toEqual([piece]);
    });
  });

  test("an EMPTY sharedPiecesDir is not managed -- install stays the user's", async () => {
    // `null` means "definitively no shared tree"; the self-managed Library
    // must survive it, or a self-hosted install would lose its only way to
    // get a piece.
    await withTempPiecesDir(async () => {
      const r = createWorkflowRoutes({ sharedPiecesDir: null });
      const { status, body } = await callJson(
        r["/api/workflows/pieces/library"]?.GET,
        plainReq("GET", "http://x/api/workflows/pieces/library"),
      );
      expect(status).toBe(200);
      expect(body.managed).toBe(false);
      expect(typeof body.entries[0].versionRange).toBe("string");
      expect(body.entries[0].installed).toBeNull();
    });
  });
});

/**
 * The self-managed Library. Every case here assumes the user owns the
 * catalog, so the mode is pinned rather than inherited: without
 * `sharedPiecesDir`, `piecesManagedByHost` consults JARVIS_SHARED_PIECES_DIR,
 * and a developer or CI runner that happens to export it would flip this
 * whole suite into managed mode and fail it with 403s that look like real
 * regressions. The managed suite above pins its own side the same way.
 */
const SELF_MANAGED = { sharedPiecesDir: null } as const;

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
      const r = createWorkflowRoutes(SELF_MANAGED);
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
    const r = createWorkflowRoutes(SELF_MANAGED);
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
    const r = createWorkflowRoutes(SELF_MANAGED);
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

      const r = createWorkflowRoutes(SELF_MANAGED);
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
      const r = createWorkflowRoutes(SELF_MANAGED);
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

/**
 * #609. #598 capped the two FLOW-level write routes and deliberately left the
 * two VERSION routes unbounded, because they carry the whole step graph and a
 * flow-row-sized limit would have been a guess that could break a large flow's
 * save. These are the two halves of that: the cap refuses an oversized body
 * before it is parsed, and a legitimately large flow still saves.
 */
describe("#609: the version write routes bound their body", () => {
  const VERSION_CAP = VERSION_WRITE_MAX_BODY_BYTES;

  async function makeFlow(): Promise<string> {
    const { body } = await callJson(
      routes["/api/workflows"]?.POST,
      plainReq("POST", "http://x/api/workflows", { displayName: "host" }),
    );
    return (body as { flow: { id: string } }).flow.id;
  }
  const postVersion = (id: string, b: unknown) =>
    callJson(
      routes["/api/workflows/:id/versions"]?.POST,
      reqWithParams("POST", `http://x/api/workflows/${id}/versions`, { id }, b),
    );
  const patchVersion = (id: string, versionId: string, b: unknown) =>
    callJson(
      routes["/api/workflows/:id/versions/:versionId"]?.PATCH,
      reqWithParams("PATCH", `http://x/api/workflows/${id}/versions/${versionId}`, { id, versionId }, b),
    );

  /** A chain of `nodes` PIECE steps, each carrying `pad` characters of input. */
  function graph(nodes: number, pad: number): Record<string, unknown> {
    let tail: Record<string, unknown> | undefined;
    for (let i = nodes - 1; i >= 1; i--) {
      tail = {
        name: `step_${i}`, type: "PIECE",
        settings: { pieceName: "@jarvispieces/piece-jarvis-tool", pieceVersion: "0.0.1",
          actionName: "invoke", input: { toolName: "run_command", params: { command: "P".repeat(pad) } } },
        ...(tail ? { nextAction: tail } : {}),
      };
    }
    return { name: "trigger", type: "EMPTY", displayName: "Manual", settings: {}, ...(tail ? { nextAction: tail } : {}) };
  }

  test("a body over the cap is refused before it is parsed, and the refusal names the limit", async () => {
    const id = await makeFlow();
    // Padding inside the graph, so the body is oversized for the reason a real
    // one would be rather than by a field nothing reads.
    const over = { displayName: "too big", trigger: graph(2, VERSION_CAP) };
    const refused = await postVersion(id, over);
    expect(refused.status).toBe(413);
    // Named, because the likeliest legitimate way to hit this is a large CODE
    // step and a bare "too large" gives the author nothing to act on.
    expect((refused.body as { error: string }).error).toBe(`request body too large; the limit is ${VERSION_CAP} bytes`);

    const created = await postVersion(id, { displayName: "fine" });
    expect(created.status).toBe(201);
    const versionId = (created.body as { id: string }).id;
    const patched = await patchVersion(id, versionId, over);
    expect(patched.status).toBe(413);
  });

  test("a declared content-length over the cap is refused without reading the body", async () => {
    const id = await makeFlow();
    const req = new Request(`http://x/api/workflows/${id}/versions`, {
      method: "POST",
      body: JSON.stringify({ displayName: "lying" }),
      headers: { "Content-Type": "application/json", "content-length": String(VERSION_CAP + 1) },
    }) as Request & { params: { id: string } };
    req.params = { id };
    let read = 0;
    req.text = async () => { read++; return "{}"; };
    const { status } = await callJson(routes["/api/workflows/:id/versions"]?.POST, req);
    expect(status).toBe(413);
    // The point of checking the declared size first: nothing is pulled off the
    // socket for an obviously oversized request.
    expect(read).toBe(0);
  });

  /**
   * The half that matters more than the refusal: the cap was derived so it
   * cannot break a legitimate save, and #598 left these routes alone precisely
   * because breaking one is worse than the exposure.
   *
   * 100 nodes is the ceiling on a RUNNABLE flow (workflow-readiness raises a
   * LIMIT past it). The term that is NOT bounded by that is `uiMeta.orphans`:
   * the editor sends every detached node with its whole `nextAction` subtree,
   * so a canvas with a 100-node chain pulled off the trigger carries a second
   * full graph. That is what this test has to include -- an earlier version
   * passed `orphans: []` and exercised less than half the body the derivation
   * is sized against.
   */
  test("a 100-node flow with multi-KB steps and a full orphan twin still saves", async () => {
    const id = await makeFlow();
    const big = graph(100, 4_000);
    const positions = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [i === 0 ? "trigger" : `step_${i}`, { x: i * 10, y: i * 20 }]),
    );
    // The whole request body, measured the way the cap measures it.
    const withTwin = { trigger: big, uiMeta: { schema: 1, positions, orphans: [graph(100, 4_000)] } };
    const size = JSON.stringify({ displayName: "large but legitimate", ...withTwin }).length;
    expect(size).toBeGreaterThan(800_000);
    // Stated as a ratio rather than "an order of magnitude", which it is not.
    expect(size * 4).toBeLessThan(VERSION_CAP);

    const created = await postVersion(id, { displayName: "large but legitimate", trigger: big });
    expect(created.status).toBe(201);
    const versionId = (created.body as { id: string }).id;
    // And again through the route the visual editor actually saves with.
    const patched = await patchVersion(id, versionId, withTwin);
    expect(patched.status).toBe(200);
  });

  /**
   * The construction a 1 MB cap would have refused, which is why this one is
   * 4 MB: 100 code steps with ~10 KB of hand-written JavaScript each.
   * `settings.sourceCode` lives inside the graph JSON and nothing caps it.
   */
  test("a 100-node flow of CODE steps with real source still saves", async () => {
    const id = await makeFlow();
    let tail: Record<string, unknown> | undefined;
    for (let i = 99; i >= 1; i--) {
      tail = {
        name: `step_${i}`, type: "CODE",
        settings: {
          sourceCode: { code: "// line of a bundled module\n".repeat(360), packageJson: '{"dependencies":{}}' },
          input: {},
        },
        ...(tail ? { nextAction: tail } : {}),
      };
    }
    const codeGraph = { name: "trigger", type: "EMPTY", displayName: "Manual", settings: {}, nextAction: tail };
    expect(JSON.stringify(codeGraph).length).toBeGreaterThan(1_000_000);
    const created = await postVersion(id, { displayName: "code heavy", trigger: codeGraph });
    expect(created.status).toBe(201);
  });

  test("a body that is not a JSON object is refused instead of half-applied", async () => {
    const id = await makeFlow();
    const created = await postVersion(id, { displayName: "fine" });
    const versionId = (created.body as { id: string }).id;
    // Was a 500 (invalid JSON) and a 200 (an array spread into the patch as
    // index keys). Both are now the caller's bug, reported as one.
    expect((await postVersion(id, [1, 2, 3])).status).toBe(400);
    expect((await patchVersion(id, versionId, "a string")).status).toBe(400);
    expect((await patchVersion(id, versionId, 42)).status).toBe(400);

    const malformed = new Request(`http://x/api/workflows/${id}/versions`, {
      method: "POST", body: "{not json", headers: { "Content-Type": "application/json" },
    }) as Request & { params: { id: string } };
    malformed.params = { id };
    expect((await callJson(routes["/api/workflows/:id/versions"]?.POST, malformed)).status).toBe(400);
  });
});

/**
 * #609. #598 clamped the listing it touched and left this one as a separate
 * subject. It is the more expensive one to leave open: listRuns has no bound of
 * its own and a run row carries `steps`, the whole captured output of every step.
 */
describe("#609: the runs listing clamps its limit", () => {
  async function flowWithRuns(count: number): Promise<string> {
    const { createFlow } = await import("../db/repos/flow");
    const { createDraftVersion } = await import("../db/repos/flow-version");
    const { createFlowRun } = await import("../db/repos/flow-run");
    const flow = createFlow();
    const version = createDraftVersion({
      flowId: flow.id, displayName: "runs",
      trigger: { name: "trigger", type: "EMPTY" } as unknown as Record<string, unknown>,
    });
    for (let i = 0; i < count; i++) {
      createFlowRun({ flowId: flow.id, flowVersionId: version.id, triggeredBy: "test", startTime: Date.now() + i });
    }
    return flow.id;
  }
  const list = (id: string, query: string) =>
    callJson(
      routes["/api/workflows/:id/runs"]?.GET,
      reqWithParams("GET", `http://x/api/workflows/${id}/runs${query}`, { id }),
    );

  test("one request cannot pull every run, and the default is unchanged", async () => {
    const id = await flowWithRuns(105);
    // Non-vacuous: there are more rows than either the clamp or the default.
    const huge = await list(id, "?limit=100000");
    expect(huge.status).toBe(200);
    expect((huge.body as RunsPage).items.length).toBe(100);
    // At the boundary, and below it, the caller gets what it asked for.
    expect(((await list(id, "?limit=100")).body as RunsPage).items.length).toBe(100);
    expect(((await list(id, "?limit=7")).body as RunsPage).items.length).toBe(7);
    expect(((await list(id, "")).body as RunsPage).items.length).toBe(50);
  });

  test("a negative or non-numeric limit lands somewhere sane instead of reaching SQLite", async () => {
    const id = await flowWithRuns(3);
    expect(((await list(id, "?limit=-1")).body as RunsPage).items.length).toBe(1);
    expect(((await list(id, "?limit=abc")).body as RunsPage).items.length).toBe(3);
    expect(((await list(id, "?limit=2.9")).body as RunsPage).items.length).toBe(2);
    expect(((await list(id, "?offset=-5&limit=2")).body as RunsPage).items.length).toBe(2);
  });
});

/**
 * #632. `PATCH /api/workflows/:id/versions/:versionId` did
 * `const { uiMeta, ...versionPatch } = body` on a body that is a CAST and not a
 * schema, and forwarded everything left over to `updateDraftVersion` -- which
 * accepted `updatedBy`, `notes` and `backupFiles`.
 *
 * `updatedBy` is the authorization half: it is an attribution column and the
 * route has no caller identity, so a caller could claim someone else edited the
 * draft. `backupFiles` is a filename -> file-CONTENT map that
 * `flow-version-adapter` reads into the engine operation payload and that no
 * shipped caller writes.
 *
 * Non-vacuous by construction: each of the three columns is seeded with a
 * DISTINCT prior value first, so the assertions below say "unchanged" and not
 * merely "still the insert default". Reverting either half of the fix (the
 * route's allowlist, or the three fields' removal from
 * `UpdateDraftVersionInput` and from its UPDATE) makes them fail.
 */
describe("#632: a version patch picks its fields instead of spreading the body", () => {
  async function seededDraft(): Promise<{ id: string; versionId: string }> {
    const { createFlow } = await import("../db/repos/flow");
    const { createDraftVersion } = await import("../db/repos/flow-version");
    const { getWorkflowDb } = await import("../db/index");
    const flow = createFlow();
    const version = createDraftVersion({
      flowId: flow.id,
      displayName: "attributed",
      trigger: { name: "trigger", type: "EMPTY" } as unknown as Record<string, unknown>,
      updatedBy: "original-author",
    });
    getWorkflowDb().run(
      `UPDATE flow_version SET notes = ?, backup_files = ? WHERE id = ?`,
      [JSON.stringify([{ id: "note_1", text: "mine" }]), JSON.stringify({ "keep.js": "original" }), version.id],
    );
    return { id: flow.id, versionId: version.id };
  }

  const patch = (id: string, versionId: string, body: unknown) =>
    callJson(
      routes["/api/workflows/:id/versions/:versionId"]?.PATCH,
      reqWithParams("PATCH", `http://x/api/workflows/${id}/versions/${versionId}`, { id, versionId }, body),
    );

  async function columns(versionId: string) {
    const { getWorkflowDb } = await import("../db/index");
    return getWorkflowDb()
      .query<{ notes: string; backup_files: string | null; updated_by: string | null }, [string]>(
        `SELECT notes, backup_files, updated_by FROM flow_version WHERE id = ?`,
      )
      .get(versionId)!;
  }

  test("updatedBy, notes and backupFiles are not writable through the route", async () => {
    const { id, versionId } = await seededDraft();
    const before = await columns(versionId);
    expect(before.updated_by).toBe("original-author");

    const { status } = await patch(id, versionId, {
      displayName: "renamed by someone else",
      trigger: { name: "trigger", type: "EMPTY" },
      updatedBy: "attacker",
      notes: [{ id: "note_2", text: "theirs" }],
      backupFiles: { "index.js": "require('child_process').exec('id')" },
    });
    // The patch SUCCEEDS: the extra keys are ignored rather than refused, so a
    // client still sending a field it used to be allowed to send is not broken.
    expect(status).toBe(200);

    const after = await columns(versionId);
    expect(after.updated_by).toBe("original-author");
    expect(JSON.parse(after.notes)).toEqual([{ id: "note_1", text: "mine" }]);
    expect(JSON.parse(after.backup_files!)).toEqual({ "keep.js": "original" });
  });

  test("the fields that ARE on the allowlist still apply", async () => {
    const { id, versionId } = await seededDraft();
    const { status, body } = await patch(id, versionId, {
      displayName: "renamed",
      trigger: { name: "trigger", type: "EMPTY", displayName: "Manual" },
      connectionIds: ["conn_a"],
      agentIds: ["agent_a"],
    });
    expect(status).toBe(200);
    expect((body as { displayName: string }).displayName).toBe("renamed");
    expect((body as { connectionIds: string[] }).connectionIds).toEqual(["conn_a"]);
    expect((body as { agentIds: string[] }).agentIds).toEqual(["agent_a"]);
    expect((body as { trigger: { displayName: string } }).trigger.displayName).toBe("Manual");
  });

  /**
   * `connectionIds` and `agentIds` were cast-only, and they are
   * `JSON.stringify`'d into columns `rowToFlowVersion` hands back TYPED as
   * `string[]` -- so the cast was a claim the whole read side believed.
   */
  test("connectionIds and agentIds are checked, not cast", async () => {
    const { id, versionId } = await seededDraft();
    expect((await patch(id, versionId, { connectionIds: { a: 1 } })).status).toBe(400);
    expect((await patch(id, versionId, { agentIds: "agent_a" })).status).toBe(400);
    expect((await patch(id, versionId, { agentIds: ["ok", 7] })).status).toBe(400);
    expect((await patch(id, versionId, { connectionIds: [] })).status).toBe(200);
  });

  /**
   * #653. Shape-checked but not size-checked: about 1,000,000 single-character
   * ids (999,995, measured) fit inside `VERSION_WRITE_MAX_BODY_BYTES`, and the
   * column they land in is `JSON.parse`d on every version read -- 50 rows per
   * `listVersions`. Measured on this runtime, parsing that column costs ~19 ms,
   * so a listing of 50 such rows holds the event loop for about a second.
   */
  test("connectionIds and agentIds are bounded in count and in entry length", async () => {
    const { id, versionId } = await seededDraft();
    const { getFlowVersion } = await import("../db/repos/flow-version");
    for (const key of ["connectionIds", "agentIds"] as const) {
      // At the caps: accepted and stored whole.
      const atCap = Array.from({ length: FLOW_VERSION_REF_IDS_MAX_ENTRIES }, (_, i) =>
        `${i}`.padEnd(FLOW_VERSION_REF_ID_MAX_CHARS, "x"));
      const ok = await patch(id, versionId, { [key]: atCap });
      expect(ok.status).toBe(200);
      expect(getFlowVersion(versionId)![key]).toEqual(atCap);

      // One entry over the count: refused, and the stored list is untouched.
      const tooMany = await patch(id, versionId, { [key]: [...atCap, "one-more"] });
      expect(tooMany.status).toBe(413);
      expect((tooMany.body as { error: string }).error).toMatch(
        new RegExp(`${key} has ${FLOW_VERSION_REF_IDS_MAX_ENTRIES + 1} entries; the limit is ${FLOW_VERSION_REF_IDS_MAX_ENTRIES}`),
      );
      expect(getFlowVersion(versionId)![key]).toEqual(atCap);

      // One character over on one entry: refused, naming the entry.
      const tooLong = await patch(id, versionId, { [key]: ["ok", "y".repeat(FLOW_VERSION_REF_ID_MAX_CHARS + 1)] });
      expect(tooLong.status).toBe(413);
      expect((tooLong.body as { error: string }).error).toMatch(
        new RegExp(`${key}\\[1\\] is ${FLOW_VERSION_REF_ID_MAX_CHARS + 1} characters; the limit is ${FLOW_VERSION_REF_ID_MAX_CHARS}`),
      );
      expect(getFlowVersion(versionId)![key]).toEqual(atCap);

      // Count before elements: 101 non-strings is a size refusal, so a flood
      // is refused without the element walk.
      expect((await patch(id, versionId, { [key]: Array(FLOW_VERSION_REF_IDS_MAX_ENTRIES + 1).fill(7) })).status).toBe(413);
    }

    // The issue's own construction: a body of single-character ids that the
    // body cap admits. Refused for its count, not its bytes.
    const flood = Array.from({ length: 999_995 }, () => "a");
    const body = JSON.stringify({ connectionIds: flood });
    expect(body.length).toBeLessThanOrEqual(VERSION_WRITE_MAX_BODY_BYTES);
    const refused = await patch(id, versionId, { connectionIds: flood });
    expect(refused.status).toBe(413);
    expect((refused.body as { error: string }).error).toMatch(/connectionIds has 999995 entries/);
  });

  /**
   * The other half of the same route's body. `uiMeta` is forwarded wholesale to
   * `upsertFlowVersionUiMeta`, which took `positions` on trust while
   * `getFlowVersionUiMeta` has always refused a non-object on the way out -- so
   * a bad layout was stored and then silently discarded on every load.
   */
  /**
   * The POST sibling has no transaction around `createDraftVersion` and
   * `upsertFlowVersionUiMeta`, so once the shape check started throwing, a
   * malformed `uiMeta` would have created the draft and THEN answered 400. That
   * is not cosmetic: a new draft becomes the LATEST draft, which is the version
   * an ENABLED flow with nothing published actually runs, so a refused request
   * would have promoted a live draft.
   */
  test("a refused uiMeta on POST does not leave a draft version behind", async () => {
    const { createFlow } = await import("../db/repos/flow");
    const { listVersions } = await import("../db/repos/flow-version");
    const flow = createFlow();
    const post = (b: unknown) =>
      callJson(
        routes["/api/workflows/:id/versions"]?.POST,
        reqWithParams("POST", `http://x/api/workflows/${flow.id}/versions`, { id: flow.id }, b),
      );
    const refused = await post({ displayName: "bad layout", trigger: { name: "trigger", type: "EMPTY" }, uiMeta: { schema: 1, positions: "nope", orphans: [] } });
    expect(refused.status).toBe(400);
    expect((refused.body as { error: string }).error).toMatch(/uiMeta.positions must be an object/);
    // Nothing was created.
    expect(listVersions(flow.id)).toHaveLength(0);
    // And a good one still works.
    expect((await post({ displayName: "good layout", trigger: { name: "trigger", type: "EMPTY" }, uiMeta: { schema: 1, positions: {}, orphans: [] } })).status).toBe(201);
    expect(listVersions(flow.id)).toHaveLength(1);
  });

  test("uiMeta is shape-checked on the way in, the way it already was on the way out", async () => {
    const { id, versionId } = await seededDraft();
    expect((await patch(id, versionId, { uiMeta: { schema: 1, positions: "nope", orphans: [] } })).status).toBe(400);
    expect((await patch(id, versionId, { uiMeta: { schema: 1, positions: {}, orphans: {} } })).status).toBe(400);
    expect((await patch(id, versionId, { uiMeta: { schema: 1, positions: { trigger: { x: 1, y: 2 } }, orphans: [] } })).status).toBe(200);
    const { getFlowVersionUiMeta } = await import("../db/repos/flow-version-ui-meta");
    expect(getFlowVersionUiMeta(versionId).positions).toEqual({ trigger: { x: 1, y: 2 } });
  });
});

/**
 * #635. Four routes parsed an unbounded body and only then applied a cap --
 * the two sample routes, which had a per-ENTRY cap that could not run until
 * `req.json()` had already materialized the caller's object graph, and the two
 * connections routes, which had no post-parse cap of any kind.
 *
 * Three separate resources are bounded here and each has its own test below:
 * the request BODY, the map's KEYS (which arrive in the URL and no body cap can
 * reach), and the map's TOTAL (which made the per-entry cap close to useless).
 */
describe("#635: the sample-data and connections routes bound their ingress", () => {
  async function draftVersion(): Promise<{ id: string; versionId: string }> {
    const { createFlow } = await import("../db/repos/flow");
    const { createDraftVersion } = await import("../db/repos/flow-version");
    const flow = createFlow();
    const version = createDraftVersion({
      flowId: flow.id,
      displayName: "bounded",
      trigger: { name: "trigger", type: "EMPTY" } as unknown as Record<string, unknown>,
    });
    return { id: flow.id, versionId: version.id };
  }

  const sampleData = (id: string, versionId: string, stepName: string, body: unknown) =>
    callJson(
      routes["/api/workflows/:id/versions/:versionId/sample-data/:stepName"]?.PATCH,
      reqWithParams(
        "PATCH",
        `http://x/api/workflows/${id}/versions/${versionId}/sample-data/${encodeURIComponent(stepName)}`,
        { id, versionId, stepName },
        body,
      ),
    );

  const sampleInput = (id: string, versionId: string, stepName: string, body: unknown) =>
    callJson(
      routes["/api/workflows/:id/versions/:versionId/sample-input/:stepName"]?.PATCH,
      reqWithParams(
        "PATCH",
        `http://x/api/workflows/${id}/versions/${versionId}/sample-input/${encodeURIComponent(stepName)}`,
        { id, versionId, stepName },
        body,
      ),
    );

  test("an oversized sample-data body is refused before it is parsed", async () => {
    const { id, versionId } = await draftVersion();
    // Over the 2,000,000 body cap but NOT a legal fixture either way, which is
    // the point: the refusal happens before `JSON.parse` sees it.
    const huge = { output: { blob: "x".repeat(2_100_000) } };
    const over = await sampleData(id, versionId, "step_a", huge);
    expect(over.status).toBe(413);
    expect((over.body as { error: string }).error).toMatch(/request body too large; the limit is 2000000 bytes/);
    expect((await sampleInput(id, versionId, "step_a", { input: { blob: "x".repeat(2_100_000) } })).status).toBe(413);
  });

  /**
   * The declared-size half of `readWriteBody`: nothing is read off the socket
   * for an obviously oversized request.
   */
  test("a content-length over the cap is refused with no body read at all", async () => {
    const { id, versionId } = await draftVersion();
    const req = new Request(`http://x/api/workflows/${id}/versions/${versionId}/sample-data/step_a`, {
      method: "PATCH",
      body: JSON.stringify({ output: { ok: true } }),
      headers: { "Content-Type": "application/json", "Content-Length": "9999999" },
    }) as Request & { params: Record<string, string> };
    req.params = { id, versionId, stepName: "step_a" };
    // `Content-Length` is a forbidden header name in the fetch spec, which
    // browsers strip. Asserted so this test cannot pass vacuously if the
    // runtime ever starts stripping it -- the point is the DECLARED size path,
    // and the body here is tiny.
    expect(req.headers.get("content-length")).toBe("9999999");
    const { status } = await callJson(
      routes["/api/workflows/:id/versions/:versionId/sample-data/:stepName"]?.PATCH,
      req,
    );
    expect(status).toBe(413);
  });

  /**
   * The cap is derived FROM the per-entry cap, so the two must not collide. A
   * body that carries an over-the-per-entry-cap fixture has to be told its
   * FIXTURE is too big -- the actionable sentence -- and not that its request
   * was. Any body cap at or below ~307 KB would flip this.
   */
  test("an over-the-per-entry-cap fixture still gets the per-entry message, not the body one", async () => {
    const { id, versionId } = await draftVersion();
    const { status, body } = await sampleData(id, versionId, "step_a", {
      output: { blob: "x".repeat(300 * 1024) },
    });
    expect(status).toBe(413);
    expect((body as { error: string }).error).toMatch(/exceeds 262144 bytes/);
    expect((body as { error: string }).error).not.toMatch(/request body too large/);
  });

  test("a legal fixture at the per-entry ceiling still succeeds through the new reader", async () => {
    const { id, versionId } = await draftVersion();
    // Just under 256 KB serialized, the largest legitimate single fixture.
    const blob = "y".repeat(256 * 1024 - 64);
    const { status, body } = await sampleData(id, versionId, "step_a", { output: { blob } });
    expect(status).toBe(200);
    expect((body as { sampleData: Record<string, { blob: string }> }).sampleData.step_a!.blob.length).toBe(blob.length);
  });

  /**
   * `{}` still clears, which is the documented way and what the existing
   * "null/missing output clears the entry" test sends. What changed is that a
   * malformed or absent body no longer silently deletes the entry.
   */
  test("a malformed or absent body is a 400 instead of silently clearing the entry", async () => {
    const { id, versionId } = await draftVersion();
    const { setSampleDataEntry } = await import("../db/repos/flow-version");
    setSampleDataEntry(versionId, "step_a", { keep: 1 });

    const malformed = new Request(`http://x/api/workflows/${id}/versions/${versionId}/sample-data/step_a`, {
      method: "PATCH",
      body: "{not json",
      headers: { "Content-Type": "application/json" },
    }) as Request & { params: Record<string, string> };
    malformed.params = { id, versionId, stepName: "step_a" };
    expect((await callJson(routes["/api/workflows/:id/versions/:versionId/sample-data/:stepName"]?.PATCH, malformed)).status).toBe(400);

    // A body that parses but is not an object used to clear the entry too.
    expect((await sampleData(id, versionId, "step_a", [1, 2, 3])).status).toBe(400);

    // The entry survived all of that.
    const { getFlowVersion } = await import("../db/repos/flow-version");
    expect(getFlowVersion(versionId)!.sampleData).toEqual({ step_a: { keep: 1 } });

    // And `{}` still clears, unchanged.
    expect((await sampleData(id, versionId, "step_a", {})).status).toBe(200);
    expect(getFlowVersion(versionId)!.sampleData).toBeNull();
  });

  /**
   * `stepName` rides in the URL PATH, so no body cap can reach it. A
   * multi-kilobyte map key arrives on a request with a two-byte body.
   */
  test("an over-long stepName is refused, and a realistic one is not", async () => {
    const { id, versionId } = await draftVersion();
    const long = "s".repeat(121);
    const over = await sampleData(id, versionId, long, { output: { x: 1 } });
    expect(over.status).toBe(413);
    expect((over.body as { error: string }).error).toMatch(/stepName is 121 characters; the limit is 120/);
    expect((await sampleInput(id, versionId, long, { input: { x: 1 } })).status).toBe(413);
    // At the boundary, and for an ordinary name, nothing changes.
    expect((await sampleData(id, versionId, "s".repeat(120), { output: { x: 1 } })).status).toBe(200);
    expect((await sampleData(id, versionId, "send_email", { output: { x: 1 } })).status).toBe(200);
  });

  /**
   * `__proto__` as a map key assigns to `Object.prototype`'s setter rather than
   * creating an own property, so the write silently stored nothing and reported
   * 200 -- and on an empty map it cleared the column.
   */
  test("a reserved stepName is refused rather than silently storing nothing", async () => {
    const { id, versionId } = await draftVersion();
    for (const reserved of ["__proto__", "prototype", "constructor"]) {
      const refused = await sampleData(id, versionId, reserved, { output: { x: 1 } });
      expect(refused.status).toBe(400);
      expect((refused.body as { error: string }).error).toMatch(/is reserved/);
      expect((await sampleInput(id, versionId, reserved, { input: { x: 1 } })).status).toBe(400);
    }
    const { getFlowVersion } = await import("../db/repos/flow-version");
    expect(getFlowVersion(versionId)!.sampleData).toBeNull();
  });

  test("the connections routes refuse an oversized body before parsing it", async () => {
    const r = createWorkflowRoutes();
    const over = await callJson(
      r["/api/workflows/connections"]?.POST,
      plainReq("POST", "http://x/api/workflows/connections", {
        externalId: "big", displayName: "big", type: "SECRET_TEXT", pieceName: "gmail",
        value: { secret_text: "x".repeat(300 * 1024) },
      }),
    );
    expect(over.status).toBe(413);
    expect((over.body as { error: string }).error).toMatch(/request body too large; the limit is 262144 bytes/);
  });

  /**
   * POST used a BARE `req.json()`, so a malformed body threw a SyntaxError that
   * matched none of `trapErrors`' patterns and came back as a 500 carrying the
   * JSON parser's own message.
   */
  test("a malformed connections body is a 400, not a 500", async () => {
    const r = createWorkflowRoutes();
    const malformed = new Request("http://x/api/workflows/connections", {
      method: "POST", body: "{not json", headers: { "Content-Type": "application/json" },
    });
    const { status, body } = await callJson(r["/api/workflows/connections"]?.POST, malformed);
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/body must be valid JSON/);
  });

  test("a connections PATCH status is checked instead of cast into the column", async () => {
    const r = createWorkflowRoutes();
    const created = await callJson(
      r["/api/workflows/connections"]?.POST,
      plainReq("POST", "http://x/api/workflows/connections", {
        externalId: "rotatable", displayName: "rotatable", type: "SECRET_TEXT",
        pieceName: "gmail", value: { secret: "k" },
      }),
    );
    const connectionId = (created.body as { id: string }).id;
    const patch = (b: unknown) =>
      callJson(
        r["/api/workflows/connections/:id"]?.PATCH,
        reqWithParams("PATCH", `http://x/api/workflows/connections/${connectionId}`, { id: connectionId }, b),
      );
    const bad = await patch({ status: "TOTALLY_FINE" });
    expect(bad.status).toBe(400);
    expect((bad.body as { error: string }).error).toMatch(/status must be ACTIVE\|MISSING\|ERROR/);
    expect((await patch({ status: "ERROR" })).status).toBe(200);
    expect(((await patch({ status: "ERROR" })).body as { status: string }).status).toBe("ERROR");
  });
});

/**
 * #635, the other half: the per-entry cap bounded ONE fixture and nothing
 * bounded the map, so 100 entries at the per-entry ceiling is 25.3 MB in a
 * column `rowToFlowVersion` parses on every version read.
 *
 * Enforced in the repo rather than at the route because `withOwnedFlowVersion`
 * wraps the setters in one transaction, so the check is atomic with the
 * read-modify-write it guards -- and because the route is not the only writer.
 */
describe("#635: the sample-data map is bounded as a whole, by every writer", () => {
  async function draft(): Promise<string> {
    const { createFlow } = await import("../db/repos/flow");
    const { createDraftVersion } = await import("../db/repos/flow-version");
    const flow = createFlow();
    return createDraftVersion({
      flowId: flow.id,
      displayName: "mapped",
      trigger: { name: "trigger", type: "EMPTY" } as unknown as Record<string, unknown>,
    }).id;
  }

  test("the entry COUNT is capped, which a byte cap alone does not do", async () => {
    const versionId = await draft();
    const { setSampleDataEntry, SAMPLE_DATA_MAP_MAX_ENTRIES } = await import("../db/repos/flow-version");
    for (let i = 0; i < SAMPLE_DATA_MAP_MAX_ENTRIES; i++) {
      setSampleDataEntry(versionId, `step_${i}`, { i });
    }
    // Tiny values, so nothing here is near the byte cap -- only the count is.
    expect(() => setSampleDataEntry(versionId, "one_too_many", { i: -1 })).toThrow(
      /sampleData would hold 101 entries; the limit is 100/,
    );
    // Overwriting an existing key is not a new entry, so it still works.
    expect(() => setSampleDataEntry(versionId, "step_0", { i: 999 })).not.toThrow();
  });

  test("the map TOTAL is capped across entries that each pass the per-entry cap", async () => {
    const versionId = await draft();
    const { setSampleDataEntry, SAMPLE_DATA_MAP_MAX_BYTES } = await import("../db/repos/flow-version");
    // Each entry is ~200 KB, comfortably inside the 256 KB per-entry cap, so
    // nothing below is refused for being an oversized fixture.
    const chunk = { blob: "z".repeat(200 * 1024) };
    let written = 0;
    let refusal: string | null = null;
    for (let i = 0; i < 40; i++) {
      try { setSampleDataEntry(versionId, `step_${i}`, chunk); written++; }
      catch (e) { refusal = (e as Error).message; break; }
    }
    // It stopped, and it stopped for the MAP and not for the entry.
    expect(refusal).toMatch(/would total \d+ bytes; the limit is 4194304/);
    expect(refusal).toMatch(/Clear the sample data for steps you are not testing/);
    // Non-vacuous: it got a useful way in before refusing.
    expect(written).toBeGreaterThan(15);
    const { getFlowVersion } = await import("../db/repos/flow-version");
    expect(JSON.stringify(getFlowVersion(versionId)!.sampleData).length).toBeLessThanOrEqual(SAMPLE_DATA_MAP_MAX_BYTES);
  });

  /**
   * A row written before the caps existed is never migrated, so its author has
   * to be able to get out from under it. "The new total is under the cap" as a
   * rule would have permitted only deletion -- replacing a huge entry with a
   * merely large one would have been refused for making the row SMALLER.
   *
   * The write below leaves the map at ~6 MB, still OVER the 4 MiB cap, which is
   * what makes this test consult the exemption clause instead of passing
   * because the result happens to be small. Deleting
   * `&& length > current.length` from `sampleMapRefusal` makes it fail.
   */
  test("a shrinking write is allowed even while the map is still over the cap", async () => {
    const versionId = await draft();
    const { getWorkflowDb } = await import("../db/index");
    const { setSampleDataEntry, getFlowVersion, SAMPLE_DATA_MAP_MAX_BYTES } =
      await import("../db/repos/flow-version");
    const legacy = { step_a: { blob: "q".repeat(9_000_000) }, step_b: { blob: "k".repeat(5_000_000) } };
    getWorkflowDb().run(`UPDATE flow_version SET sample_data = ? WHERE id = ?`, [JSON.stringify(legacy), versionId]);

    expect(() => setSampleDataEntry(versionId, "step_a", { blob: "q".repeat(1_000_000) })).not.toThrow();
    const after = JSON.stringify(getFlowVersion(versionId)!.sampleData).length;
    // Smaller than it was, and STILL over the cap -- so the clause was the only
    // thing that let this through.
    expect(after).toBeLessThan(14_000_000);
    expect(after).toBeGreaterThan(SAMPLE_DATA_MAP_MAX_BYTES);

    // And the exemption is not a way to GROW: a write that makes the still-over
    // -cap map bigger is refused, so grow/shrink alternation cannot climb.
    expect(() => setSampleDataEntry(versionId, "step_c", { blob: "z".repeat(1_000_000) })).toThrow(
      /would total \d+ bytes; the limit is 4194304/,
    );
  });

  /**
   * The COUNT dimension needs the same exemption, and getting this wrong made
   * an over-count row a one-way trap: with an unconditional count check,
   * deleting one of 150 entries yields 149, which is still over 100, so every
   * single-entry write including a clear answered 413.
   *
   * `sampleInput` is the one that mattered: its route family has only a PATCH,
   * so there is no DELETE and no `replaceSampleInput` to clear it whole.
   */
  test("an over-count map can still be shrunk one entry at a time", async () => {
    const versionId = await draft();
    const { getWorkflowDb } = await import("../db/index");
    const { setSampleDataEntry, setSampleInputEntry, getFlowVersion } =
      await import("../db/repos/flow-version");
    const legacy: Record<string, unknown> = {};
    for (let i = 0; i < 150; i++) legacy[`step_${i}`] = { i };
    getWorkflowDb().run(
      `UPDATE flow_version SET sample_data = ?, sample_input = ? WHERE id = ?`,
      [JSON.stringify(legacy), JSON.stringify(legacy), versionId],
    );

    // Deleting is allowed, though 149 is still over the 100-entry cap.
    expect(() => setSampleDataEntry(versionId, "step_0", null)).not.toThrow();
    expect(Object.keys(getFlowVersion(versionId)!.sampleData!).length).toBe(149);
    // Overwriting an existing key is allowed too: it adds no entry.
    expect(() => setSampleDataEntry(versionId, "step_1", { i: 999 })).not.toThrow();
    // Adding a NEW key to an over-count map is still refused.
    expect(() => setSampleDataEntry(versionId, "brand_new", { i: 1 })).toThrow(
      /would hold 150 entries; the limit is 100/,
    );
    // Same for sampleInput, which has no whole-map clear to fall back on.
    expect(() => setSampleInputEntry(versionId, "step_0", null)).not.toThrow();
    expect(() => setSampleInputEntry(versionId, "brand_new", { i: 1 })).toThrow(
      /would hold 150 entries; the limit is 100/,
    );
  });

  /**
   * The writer that makes the map cap matter: it writes one entry per step of
   * the run in a single call, after every successful run. Capping only the
   * hand-edit path would have left this able to build the 25 MB map, and would
   * have falsified the function's own promise that auto-capture can never
   * produce an entry the user could not have saved by hand.
   */
  test("auto-capture stops at the map cap instead of growing past it", async () => {
    const versionId = await draft();
    const { mergeRunOutputsIntoSampleData, getFlowVersion, SAMPLE_DATA_MAP_MAX_BYTES } =
      await import("../db/repos/flow-version");
    // 40 steps x ~200 KB: every entry passes the per-entry cap, the map does not.
    const runSteps: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) runSteps[`step_${i}`] = { output: { blob: "w".repeat(200 * 1024) } };

    const { written, skipped } = mergeRunOutputsIntoSampleData(versionId, runSteps);
    expect(written.length).toBeGreaterThan(15);
    expect(written.length).toBeLessThan(40);
    expect(skipped.length).toBe(40 - written.length);
    expect(skipped[0]!.reason).toMatch(/map is at its 4194304-byte \/ 100-entry limit/);
    expect(JSON.stringify(getFlowVersion(versionId)!.sampleData).length).toBeLessThanOrEqual(SAMPLE_DATA_MAP_MAX_BYTES);
  });

  test("sampleInput is bounded by the same pair", async () => {
    const versionId = await draft();
    const { setSampleInputEntry, SAMPLE_DATA_MAP_MAX_ENTRIES } = await import("../db/repos/flow-version");
    for (let i = 0; i < SAMPLE_DATA_MAP_MAX_ENTRIES; i++) {
      setSampleInputEntry(versionId, `step_${i}`, { i });
    }
    expect(() => setSampleInputEntry(versionId, "one_too_many", { i: -1 })).toThrow(
      /sampleInput would hold 101 entries; the limit is 100/,
    );
  });
});

/**
 * #636. `listRuns` ordered by `created DESC` alone -- a millisecond timestamp
 * with no uniqueness -- so same-millisecond runs had no defined order.
 *
 * The REPRODUCIBLE consequence, which is what the first test pins, is not the
 * one the issue leads with: with no tiebreak SQLite leaves equal sort keys in
 * scan order, so a block of same-millisecond runs came back OLDEST first and
 * the first page of a "newest first" listing showed the oldest runs in the
 * block. `createFlowRun` stamps `created` from `Date.now()`, so a tight loop --
 * or a trigger enqueueing a batch -- puts the whole block in one millisecond.
 *
 * Skip-and-repeat across pages, which the issue leads with, is a separate
 * matter: it is NOT fixed by a tiebreak and was not reproducible without one.
 * Measured both ways on a static table, paging returns every row exactly once
 * either way; what breaks OFFSET paging is a write BETWEEN two page reads, and
 * that is true of any total order. The paging tests below therefore passed
 * before this change too, and are kept as property guards rather than as
 * regression tests -- labelled so nobody mistakes them for proof of a fix.
 * See `listRuns`' own docblock.
 */
describe("#636: run ordering is defined, so a page means something", () => {
  async function flowWithRuns(count: number): Promise<{ flowId: string; ids: string[] }> {
    const { createFlow } = await import("../db/repos/flow");
    const { createDraftVersion } = await import("../db/repos/flow-version");
    const { createFlowRun } = await import("../db/repos/flow-run");
    const flow = createFlow();
    const version = createDraftVersion({
      flowId: flow.id, displayName: "paged",
      trigger: { name: "trigger", type: "EMPTY" } as unknown as Record<string, unknown>,
    });
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(createFlowRun({ flowId: flow.id, flowVersionId: version.id, triggeredBy: `run_${i}` }).id);
    }
    return { flowId: flow.id, ids };
  }

  const page = async (id: string, query: string) =>
    ((await callJson(
      routes["/api/workflows/:id/runs"]?.GET,
      reqWithParams("GET", `http://x/api/workflows/${id}/runs${query}`, { id }),
    )).body as RunsPage<{ id: string; created: number }>).items;

  /**
   * THE regression test. Fails before the fix, where the first page carried the
   * OLDEST runs of the same-millisecond block instead of the newest.
   */
  test("same-millisecond runs come back newest first, not oldest first", async () => {
    const { flowId, ids } = await flowWithRuns(120);
    // Non-vacuous: the block really is tied on `created`, so there really is an
    // order for SQL to have left undefined.
    const all = await page(flowId, "?limit=100");
    expect(new Set(all.map((run) => run.created)).size).toBeLessThan(all.length);
    // The newest 40 of the 120, in reverse insertion order.
    const first = await page(flowId, "?limit=40");
    expect(first.map((run) => run.id)).toEqual([...ids].reverse().slice(0, 40));
  });

  test("the repo-level order is insertion order reversed, which `id DESC` would not have given", async () => {
    const { createFlow } = await import("../db/repos/flow");
    const { createDraftVersion } = await import("../db/repos/flow-version");
    const { createFlowRun, listRuns } = await import("../db/repos/flow-run");
    const flow = createFlow();
    const version = createDraftVersion({
      flowId: flow.id, displayName: "ordered",
      trigger: { name: "trigger", type: "EMPTY" } as unknown as Record<string, unknown>,
    });
    const a = createFlowRun({ flowId: flow.id, flowVersionId: version.id, triggeredBy: "a" });
    const b = createFlowRun({ flowId: flow.id, flowVersionId: version.id, triggeredBy: "b" });
    const c = createFlowRun({ flowId: flow.id, flowVersionId: version.id, triggeredBy: "c" });
    // `rowid DESC` is chronological. `id DESC` is `apId()`, i.e. nanoid, so it
    // would have ordered these three at random -- total, but not newest-first.
    expect(listRuns({ flowId: flow.id }).map((run) => run.id)).toEqual([c.id, b.id, a.id]);
  });

  /** PROPERTY GUARD, not a regression test: this held before the fix too. */
  test("paging an unchanged table covers every run exactly once", async () => {
    const total = 120;
    const { flowId } = await flowWithRuns(total);
    const seen: string[] = [];
    for (let offset = 0; offset < total; offset += 40) {
      seen.push(...(await page(flowId, `?limit=40&offset=${offset}`)).map((run) => run.id));
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });

  /** PROPERTY GUARD, not a regression test: this held before the fix too. */
  test("re-reading a page gives the same page, and adjacent pages do not overlap", async () => {
    const { flowId } = await flowWithRuns(90);
    const first = (await page(flowId, "?limit=30&offset=0")).map((run) => run.id);
    const second = (await page(flowId, "?limit=30&offset=30")).map((run) => run.id);
    expect((await page(flowId, "?limit=30&offset=0")).map((run) => run.id)).toEqual(first);
    expect(first.filter((runId) => second.includes(runId))).toEqual([]);
  });

  test("the filter combinations the four old query branches covered still work", async () => {
    const { createFlow } = await import("../db/repos/flow");
    const { createDraftVersion } = await import("../db/repos/flow-version");
    const { createFlowRun, listRuns } = await import("../db/repos/flow-run");
    const one = createFlow();
    const two = createFlow();
    const vOne = createDraftVersion({ flowId: one.id, displayName: "one" });
    const vTwo = createDraftVersion({ flowId: two.id, displayName: "two" });
    createFlowRun({ flowId: one.id, flowVersionId: vOne.id, status: "SUCCEEDED" });
    createFlowRun({ flowId: one.id, flowVersionId: vOne.id, status: "FAILED" });
    createFlowRun({ flowId: two.id, flowVersionId: vTwo.id, status: "SUCCEEDED" });
    expect(listRuns().length).toBe(3);
    expect(listRuns({ flowId: one.id }).length).toBe(2);
    expect(listRuns({ flowId: one.id, status: "FAILED" }).length).toBe(1);
    expect(listRuns({ status: "SUCCEEDED" }).length).toBe(2);
    // The composed WHERE concatenates only literal fragments, so a filter value
    // that looks like SQL stays a bound parameter and matches nothing.
    expect(listRuns({ flowId: `' OR 1=1 --` }).length).toBe(0);
  });
});

/**
 * #652. The runs listing was a bare array, so a client had nothing to page
 * with. It now answers `{ items, nextOffset }`, the `/readiness` shape, and
 * `nextOffset` means the same thing there and here: set when the page came back
 * full, null when it did not.
 */
describe("#652: the runs listing says where the next page starts", () => {
  async function flowWithRuns(count: number, failedEvery = 0): Promise<{ flowId: string; ids: string[] }> {
    const { createFlow } = await import("../db/repos/flow");
    const { createDraftVersion } = await import("../db/repos/flow-version");
    const { createFlowRun } = await import("../db/repos/flow-run");
    const flow = createFlow();
    const version = createDraftVersion({
      flowId: flow.id, displayName: "paged",
      trigger: { name: "trigger", type: "EMPTY" } as unknown as Record<string, unknown>,
    });
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const status = failedEvery && i % failedEvery === 0 ? "FAILED" : "SUCCEEDED";
      ids.push(createFlowRun({ flowId: flow.id, flowVersionId: version.id, triggeredBy: `run_${i}`, status }).id);
    }
    return { flowId: flow.id, ids };
  }

  const page = async (id: string, query: string) => {
    const res = await callJson(
      routes["/api/workflows/:id/runs"]?.GET,
      reqWithParams("GET", `http://x/api/workflows/${id}/runs${query}`, { id }),
    );
    expect(res.status).toBe(200);
    return res.body as RunsPage<{ id: string; status: string }>;
  };

  test("a full page names the next offset and a short one names none", async () => {
    const { flowId } = await flowWithRuns(5);
    expect(await page(flowId, "?limit=2")).toMatchObject({ nextOffset: 2 });
    expect(await page(flowId, "?limit=2&offset=2")).toMatchObject({ nextOffset: 4 });
    const last = await page(flowId, "?limit=2&offset=4");
    expect(last.items).toHaveLength(1);
    expect(last.nextOffset).toBeNull();
    // The default page: 5 runs under a default of 50 is short.
    expect(await page(flowId, "")).toMatchObject({ nextOffset: null });
    // The clamped limit is what the offset steps by, not the one asked for.
    expect((await page(flowId, "?limit=-3")).nextOffset).toBe(1);
  });

  test("following nextOffset from the start visits every run once, newest first", async () => {
    const { flowId, ids } = await flowWithRuns(105);
    const seen: string[] = [];
    const sizes: number[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const next: RunsPage<{ id: string; status: string }> = await page(flowId, `?limit=40&offset=${offset}`);
      sizes.push(next.items.length);
      seen.push(...next.items.map((run) => run.id));
      offset = next.nextOffset;
    }
    expect(sizes).toEqual([40, 40, 25]);
    expect(seen).toEqual([...ids].reverse());
  });

  test("a status filter pages within the filter", async () => {
    // Every third run FAILED: 0, 3, ..., 27 -> 10 of 30.
    const { flowId, ids } = await flowWithRuns(30, 3);
    const failed = ids.filter((_, i) => i % 3 === 0).reverse();
    const first = await page(flowId, "?status=FAILED&limit=6");
    expect(first.items.map((run) => run.id)).toEqual(failed.slice(0, 6));
    expect(first.nextOffset).toBe(6);
    const second = await page(flowId, `?status=FAILED&limit=6&offset=${first.nextOffset}`);
    expect(second.items.map((run) => run.id)).toEqual(failed.slice(6));
    expect(second.nextOffset).toBeNull();
  });
});

/**
 * #649. `/run`, `/publish` and `/code-steps` were left out of #635 because an
 * absent body is part of their contract, so the shared reader was not a drop-in.
 * It now has an `allowEmpty` mode, decided on the text after both size checks.
 */
describe("#649: /run, /publish and /code-steps bound their bodies and keep the empty-body contract", () => {
  type Route = "run" | "publish" | "code-steps";

  async function newFlow(): Promise<string> {
    const created = await callJson(routes["/api/workflows"]?.POST, plainReq("POST", "http://x", { displayName: "x" }));
    return created.body.flow.id;
  }

  async function hit(route: Route, id: string, body?: BodyInit, headers: Record<string, string> = {}) {
    const req = new Request(`http://x/api/workflows/${id}/${route}`, { method: "POST", body, headers }) as
      Request & { params: { id: string } };
    req.params = { id };
    return callJson(routes[`/api/workflows/:id/${route}`]?.POST, req);
  }

  const emptyStream = () => new ReadableStream({ start(c) { c.close(); } });

  /**
   * `req.body === null` is not the test for "absent": a chunked body with no
   * bytes has a stream and no content-length, and whitespace was accepted by
   * the readers this replaced. All four mean the default.
   */
  test("an absent body still means the default on /publish and /run, however it arrives", async () => {
    const absent: [string, () => BodyInit | undefined][] = [
      ["no body", () => undefined],
      ["empty string", () => ""],
      ["whitespace", () => " \n"],
      ["empty chunked stream", emptyStream],
    ];
    for (const [label, body] of absent) {
      const published = await hit("publish", await newFlow(), body());
      expect({ label, status: published.status }).toEqual({ label, status: 200 });
      expect(published.body.version.state).toBe("LOCKED");

      const ran = await hit("run", await newFlow(), body());
      expect({ label, status: ran.status }).toEqual({ label, status: 202 });
      expect(ran.body.environment).toBe("PRODUCTION");
    }
  });

  test("/code-steps with no body is told what to send, not that it sent bad JSON", async () => {
    const id = await newFlow();
    const empty = await hit("code-steps", id);
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/enabled must be a boolean/);
    expect((await hit("code-steps", id, JSON.stringify({ enabled: true }))).status).toBe(200);
  });

  test("a body that is not a JSON object is refused on all three, and /run starts nothing", async () => {
    for (const route of ["run", "publish", "code-steps"] as const) {
      const malformed = await hit(route, await newFlow(), "{not json");
      expect({ route, status: malformed.status }).toEqual({ route, status: 400 });
      expect(malformed.body.error).toMatch(/body must be valid JSON/);
      const array = await hit(route, await newFlow(), "[]");
      expect({ route, status: array.status }).toEqual({ route, status: 400 });
      expect(array.body.error).toMatch(/body must be a JSON object/);
    }
    // It used to fall back to {} and start a production run with no payload.
    expect(queueStats().queued).toBe(0);
  });

  test("/publish and /code-steps refuse an oversized body, declared or not", async () => {
    for (const route of ["publish", "code-steps"] as const) {
      const declared = await hit(route, await newFlow(), "{}", { "Content-Length": String(262_144 + 1) });
      expect({ route, status: declared.status }).toEqual({ route, status: 413 });
      const actual = await hit(route, await newFlow(), JSON.stringify({ pad: "a".repeat(262_144) }));
      expect({ route, status: actual.status }).toEqual({ route, status: 413 });
      expect(actual.body.error).toMatch(/the limit is 262144 bytes/);
    }
  });

  /**
   * `payload` is one run's trigger input, so `/run` shares the resume cap
   * rather than the flow-write one: a payload between the two is legitimate.
   */
  test("/run takes a payload over the flow-write cap and refuses one over the resume cap", async () => {
    const big = await hit("run", await newFlow(), JSON.stringify({ payload: { s: "a".repeat(300_000) } }));
    expect(big.status).toBe(202);

    const declared = await hit("run", await newFlow(), "{}", {
      "Content-Length": String(WAITPOINT_RESUME_MAX_BODY_BYTES + 1),
    });
    expect(declared.status).toBe(413);
    const actual = await hit("run", await newFlow(), JSON.stringify({ payload: { s: "a".repeat(WAITPOINT_RESUME_MAX_BODY_BYTES) } }));
    expect(actual.status).toBe(413);
    expect(actual.body.error).toMatch(new RegExp(`the limit is ${WAITPOINT_RESUME_MAX_BODY_BYTES} bytes`));
    expect(queueStats().queued).toBe(1);
  });

  test("/run refuses an environment outside the union instead of a 500 from the column CHECK", async () => {
    const bogus = await hit("run", await newFlow(), JSON.stringify({ environment: "BOGUS" }));
    expect(bogus.status).toBe(400);
    expect(bogus.body.error).toMatch(/environment must be PRODUCTION or TESTING/);
    expect(queueStats().queued).toBe(0);

    const testing = await hit("run", await newFlow(), JSON.stringify({ environment: "TESTING" }));
    expect(testing.status).toBe(202);
    expect(testing.body.environment).toBe("TESTING");
  });

  test("/run's triggeredBy is a short string, because it is stored and read back to the model", async () => {
    for (const triggeredBy of [{ a: 1 }, 7, "t".repeat(RUN_TRIGGERED_BY_MAX_CHARS + 1)]) {
      const refused = await hit("run", await newFlow(), JSON.stringify({ triggeredBy }));
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/triggeredBy must be a string of at most/);
    }
    expect(queueStats().queued).toBe(0);

    const atCap = "t".repeat(RUN_TRIGGERED_BY_MAX_CHARS);
    const accepted = await hit("run", await newFlow(), JSON.stringify({ triggeredBy: atCap }));
    expect(accepted.status).toBe(202);
    expect(accepted.body.triggeredBy).toBe(atCap);
  });

  test("a route that requires a body still refuses an empty one", async () => {
    const empty = await callJson(routes["/api/workflows"]?.POST, new Request("http://x", { method: "POST", body: "" }));
    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatch(/body must be valid JSON/);
  });
});
