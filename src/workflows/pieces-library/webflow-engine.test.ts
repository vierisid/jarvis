/** Actual npm piece in the real engine. Only fetch to its provider host is redirected
 * in a disposable engine copy; no live Webflow calls or account credentials are used.
 * Gated on JARVIS_TEST_ENGINE_BUILD=1 like the other engine tests; CI runs it
 * in test.yml's engine step. It installs the pinned 0.3.0 from npm. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { initWorkflowDb, closeWorkflowDb, DEFAULT_IDS } from "../db";
import { createFlow } from "../db/repos/flow";
import { createDraftVersion } from "../db/repos/flow-version";
import { createFlowRun, getFlowRun } from "../db/repos/flow-run";
import { enqueue } from "../db/repos/job-queue";
import { CredentialResolver } from "../credentials/adapter";
import { JarvisWebflowConnectionSource } from "../credentials/webflow-source";
import { AuthorityEngine } from "../../authority/engine";
import { ApprovalManager } from "../../authority/approval";
import { AuditTrail } from "../../authority/audit";
import { EmergencyController } from "../../authority/emergency";
import { WorkflowEventBuffer } from "../runtime/event-buffer";
import { buildSandboxServiceBackends } from "../runtime/service-backends";
import { buildPieceCatalog } from "../runtime/piece-catalog";
import { resolveGovernedPieceAction } from "../runtime/piece-effects";
import { SandboxApi } from "../sandbox-api/server";
import { workflowLogsBase } from "../sandbox-api/config";
import { buildEngineBundle } from "../runner/engine-runtime/build";
import { EngineRuntime } from "../runner/engine-runtime/engine-runtime";
import { EngineFlowExecutor } from "../runner/engine-runtime/engine-flow-executor";
import { createRunFlowHandler } from "../runner/handler";
import { Worker } from "../queue/worker";
const gate = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const piece = "@activepieces/piece-webflow";
let dir: string,
  api: SandboxApi,
  runtime: EngineRuntime,
  provider: ReturnType<typeof Bun.serve>;
let runId: string | undefined;
const requests: Array<{
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}> = [];

beforeAll(async () => {
  if (!gate) return;
  dir = mkdtempSync(join(tmpdir(), "jarvis-webflow-engine-"));
  initWorkflowDb(join(dir, "db.sqlite"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, dependencies: { [piece]: "0.3.0" } }),
  );
  const install = spawnSync(
    "bun",
    ["install", "--silent", "--backend", "copy"],
    { cwd: dir, encoding: "utf8" },
  );
  if (install.status !== 0)
    throw new Error("npm install failed: " + install.stderr);
  provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname,
        body = req.method === "GET" ? null : ((await req.json()) as any);
      requests.push({
        method: req.method,
        path,
        body,
        auth: req.headers.get("authorization"),
      });
      if (req.headers.get("authorization") !== "Bearer ENGINE_ONLY_WEBFLOW")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      const site = "a".repeat(24),
        collection = "b".repeat(24),
        id = "c".repeat(24),
        locale = "d".repeat(24);
      const item = {
        id,
        cmsLocaleId: locale,
        fieldData: { name: "Sandbox draft", slug: "sandbox-draft" },
        isDraft: true,
        isArchived: false,
        lastPublished: null,
        lastUpdated: "2026-10-29T12:00:00Z",
        createdOn: "2026-10-29T12:00:00Z",
      };
      if (path === "/v2/sites/" + site + "/collections")
        return Response.json({
          collections: [{ id: collection, displayName: "Articles" }],
        });
      if (path === "/v2/sites/" + site)
        return Response.json({
          id: site,
          locales: { primary: { cmsLocaleId: locale } },
        });
      if (path === "/v2/collections/" + collection)
        return Response.json({
          id: collection,
          fields: [
            {
              slug: "name",
              displayName: "Name",
              type: "PlainText",
              isRequired: true,
              isEditable: true,
            },
            {
              slug: "slug",
              displayName: "Slug",
              type: "PlainText",
              isRequired: true,
              isEditable: true,
            },
          ],
        });
      if (
        path === "/v2/collections/" + collection + "/items" &&
        req.method === "GET"
      )
        return Response.json({
          items: [item],
          pagination: { offset: 0, limit: 100, total: 1 },
        });
      if (
        path === "/v2/collections/" + collection + "/items" ||
        path === "/v2/collections/" + collection + "/items/" + id
      ) {
        if (req.method !== "GET") {
          expect(body.isDraft).toBe(true);
          expect(body.isArchived).toBe(false);
          expect(body.fieldData.name).toBe("Sandbox draft");
        }
        return Response.json(item);
      }
      return Response.json({ error: "unknown route" }, { status: 404 });
    },
  });
  mkdirSync(join(dir, "connections"));
  writeFileSync(
    join(dir, "connections/webflow.json"),
    JSON.stringify({
      version: 1,
      provider: "webflow",
      status: "connected",
      generation: randomUUID(),
      access_token: "ENGINE_ONLY_WEBFLOW",
      account: { id: "e".repeat(24), label: "owner@example.test" },
      workspaces: [{ id: "a".repeat(24), name: "Sandbox site" }],
      connected_at: new Date().toISOString(),
    }),
  );
  const resolver = new CredentialResolver();
  resolver.register(new JarvisWebflowConnectionSource(dir));
  api = new SandboxApi({
    services: buildSandboxServiceBackends({
      credentialResolver: resolver,
      llmManager: {} as any,
      channelService: {} as any,
      wsService: {} as any,
      eventBuffer: new WorkflowEventBuffer(),
      approvalManager: new ApprovalManager(),
      auditTrail: new AuditTrail(),
      emergencyController: new EmergencyController(),
      authorityEngine: new AuthorityEngine({
        default_level: 10,
        governed_categories: [],
        overrides: [],
        context_rules: [],
        learning: { enabled: false, suggest_threshold: 10 },
        emergency_state: "normal",
      }),
    }),
  });
  await api.start({ port: 0 });
  const bundle = await buildEngineBundle(),
    fixtureBundle = join(dir, "engine-fixture.cjs");
  const redirect = `const providerFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://api.webflow.com'){url.protocol='http:';url.host='127.0.0.1:${provider.port}';return providerFetch(url,init);}return providerFetch(input,init);};\n`;
  writeFileSync(
    fixtureBundle,
    redirect + readFileSync(bundle.bundlePath, "utf8"),
  );
  runtime = new EngineRuntime({
    api,
    bundlePath: fixtureBundle,
    expectedDigest: createHash("sha256")
      .update(readFileSync(fixtureBundle))
      .digest("hex"),
    cwd: dir,
    customPiecesPaths: [dir],
    devPieces: [],
    baseCodeDir: join(dir, "code"),
    egressPolicy: "private-allowed",
  });
}, 120000);
afterAll(async () => {
  if (!gate) return;
  await runtime?.shutdown();
  await api?.stop();
  provider?.stop(true);
  closeWorkflowDb();
  if (runId) rmSync(join(workflowLogsBase(), runId + ".bin"), { force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});
test.skipIf(!gate)(
  "actual published Webflow metadata, four managed actions and downstream output references",
  async () => {
    const { catalog, failures } = await buildPieceCatalog({
      runtime,
      pieceRoots: [join(dir, "node_modules/@activepieces")],
      projectId: DEFAULT_IDS.project,
      pieceTimeoutMs: 30000,
      overallTimeoutMs: 45000,
    });
    expect(failures).toEqual([]);
    const metadata = catalog.get(piece)!;
    expect(metadata.auth?.type).toBe("OAUTH2");
    expect(Object.keys(metadata.actions).sort()).toEqual(
      [
        "create_collection_item",
        "custom_api_call",
        "delete_collection_item",
        "find_collection_item",
        "find_order",
        "list_collections",
        "list_sites",
        "publish_collection_item",
        "fulfill_order",
        "get_collection_item",
        "refund_order",
        "unfulfill_order",
        "update_collection_item",
      ].sort(),
    );
    if (process.env.WEBFLOW_CATALOG_FIXTURE)
      writeFileSync(
        process.env.WEBFLOW_CATALOG_FIXTURE,
        JSON.stringify(metadata),
      );
    for (const name of [
      "create_collection_item",
      "get_collection_item",
      "update_collection_item",
      "find_collection_item",
    ]) {
      expect(metadata.actions[name]?.requireAuth).toBe(true);
      expect(metadata.actions[name]?.outputSample).toBeDefined();
      expect(resolveGovernedPieceAction(piece, name)?.known).toBe(true);
    }
    const step = (
      name: string,
      actionName: string,
      input: Record<string, unknown>,
      nextAction?: any,
    ) => ({
      name,
      type: "PIECE" as const,
      settings: {
        pieceName: piece,
        pieceVersion: "0.3.0",
        actionName,
        input: { auth: "{{connections.jarvis:webflow}}", ...input },
      },
      ...(nextAction ? { nextAction } : {}),
    });
    const location = { site_id: "a".repeat(24), collection_id: "b".repeat(24) };
    const find = step("find", "find_collection_item", {
      ...location,
      field_name: "name",
      field_value: "{{update.fieldData.name}}",
      max_results: 20,
    });
    const update = step(
      "update",
      "update_collection_item",
      {
        ...location,
        collection_item_id: "{{read.id}}",
        collection_fields: { name: "{{read.fieldData.name}}" },
      },
      find,
    );
    const read = step(
      "read",
      "get_collection_item",
      { ...location, collection_item_id: "{{create.id}}" },
      update,
    );
    const create = step(
      "create",
      "create_collection_item",
      {
        ...location,
        collection_fields: { name: "Sandbox draft", slug: "sandbox-draft" },
      },
      read,
    );
    const flow = createFlow(),
      version = createDraftVersion({
        flowId: flow.id,
        displayName: "Webflow qualification",
        trigger: { name: "trigger", type: "EMPTY", nextAction: create },
      });
    const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id });
    runId = run.id;
    const worker = new Worker({
      log: () => {},
      handlers: {
        RUN_FLOW: createRunFlowHandler({
          executor: new EngineFlowExecutor(runtime, {
            terminalTimeoutMs: 5000,
          }),
        }),
      },
    });
    enqueue({
      jobType: "RUN_FLOW",
      flowRunId: run.id,
      maxAttempts: 1,
      payload: { runId: run.id },
    });
    await worker.drain();
    const complete = getFlowRun(run.id)!;
    expect({ status: complete.status, steps: complete.steps }).toMatchObject({
      status: "SUCCEEDED",
    });
    expect(
      requests
        .filter((r) => r.method !== "GET")
        .map((r) => r.method + " " + r.path),
    ).toEqual([
      "POST /v2/collections/" + "b".repeat(24) + "/items",
      "PATCH /v2/collections/" + "b".repeat(24) + "/items/" + "c".repeat(24),
    ]);
    expect(
      requests.every(
        (r) => r.path.startsWith("/v2/") && !/live|publish/.test(r.path),
      ),
    ).toBe(true);
    const output = (step: string) =>
      (complete.steps?.[step] as any).output.output;
    expect(output("find").result[0].fieldData.name).toBe("Sandbox draft");
    function sampleTypes(sample: any, value: any, path: string) {
      expect(value, path).toBeDefined();
      if (Array.isArray(sample)) {
        expect(Array.isArray(value), path).toBe(true);
        if (sample.length) sampleTypes(sample[0], value[0], path + "[0]");
      } else if (sample && typeof sample === "object") {
        for (const [key, v] of Object.entries(sample))
          sampleTypes(v, value[key], path + "." + key);
      } else expect(typeof value, path).toBe(typeof sample);
    }
    for (const [name, step] of [
      ["create_collection_item", "create"],
      ["get_collection_item", "read"],
      ["update_collection_item", "update"],
      ["find_collection_item", "find"],
    ])
      sampleTypes(metadata.actions[name!]!.outputSample, output(step!), name!);
    expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_WEBFLOW");
  },
  90000,
);
