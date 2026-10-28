/** Actual npm piece in the real engine. Only fetch to its provider host is redirected
 * in a disposable engine copy; no live Typeform calls or account credentials are used.
 * Gated on JARVIS_TEST_ENGINE_BUILD=1 like the other engine tests; CI runs it
 * in test.yml's engine step. It installs the pinned 0.7.1 from npm. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
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
import { JarvisTypeformConnectionSource } from "../credentials/typeform-source";
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
const piece = "@activepieces/piece-typeform";
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-typeform-engine-"));
  initWorkflowDb(join(dir, "db.sqlite"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, dependencies: { [piece]: "0.7.1" } }),
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
        body =
          req.method === "GET" || req.method === "DELETE"
            ? null
            : ((await req.json()) as any);
      requests.push({
        method: req.method,
        path,
        body,
        auth: req.headers.get("authorization"),
      });
      if (req.headers.get("authorization") !== "Bearer ENGINE_ONLY_TYPEFORM")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      if (path === "/workspaces")
        return Response.json({
          total_items: 1,
          page_count: 1,
          items: [{ id: "workspace1", name: "Sandbox" }],
        });
      if (path === "/forms")
        return Response.json({
          total_items: 1,
          page_count: 1,
          items: [{ id: "form1", title: "Feedback" }],
        });
      if (path === "/forms/form1")
        return Response.json({
          id: "form1",
          title: "Feedback",
          _links: {
            responses: "https://api.typeform.com/forms/form1/responses",
          },
          fields: [{ id: "field1", type: "short_text", title: "Feedback" }],
        });
      if (path === "/forms/form1/responses")
        return Response.json({
          total_items: 1,
          page_count: 1,
          items: [
            {
              response_id: "response1",
              token: "response1",
              submitted_at: "2026-10-28T10:00:00Z",
              answers: [{ type: "text", text: "Helpful" }],
            },
          ],
        });
      return Response.json({ error: "unknown route" }, { status: 404 });
    },
  });
  mkdirSync(join(dir, "connections"));
  writeFileSync(
    join(dir, "connections/typeform.json"),
    JSON.stringify({
      version: 1,
      provider: "typeform",
      status: "connected",
      generation: randomUUID(),
      access_token: "ENGINE_ONLY_TYPEFORM",
      account: { id: "workspace1:admin1", label: "Sandbox owner" },
      workspaces: [{ id: "workspace1", name: "Jarvis sandbox" }],
      refresh_token: "REFRESH_PRIVATE",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      refresh: {
        url: "https://app.usejarvis.dev/api/integrations/typeform/refresh",
        instance_id: randomUUID(),
        secret: "a".repeat(64),
      },
      connected_at: new Date().toISOString(),
    }),
  );
  const resolver = new CredentialResolver();
  resolver.register(
    new JarvisTypeformConnectionSource({
      daemon: { data_dir: dir },
      usejarvis_integrations: {
        page_url: "https://app.usejarvis.dev/account",
      },
    } as any),
  );
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
  const redirect = `const providerFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://api.typeform.com'){url.protocol='http:';url.host='127.0.0.1:${provider.port}';return providerFetch(url,init);}return providerFetch(input,init);};\n`;
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
  "catalog extraction and four read actions through actual engine, managed credential and downstream references",
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
    if (process.env.TYPEFORM_CATALOG_FIXTURE)
      writeFileSync(
        process.env.TYPEFORM_CATALOG_FIXTURE,
        JSON.stringify(metadata),
      );
    for (const name of [
      "list_workspaces",
      "list_forms",
      "get_form",
      "list_responses",
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
        pieceVersion: "0.7.1",
        actionName,
        input: { auth: "{{connections.jarvis:typeform}}", ...input },
      },
      ...(nextAction ? { nextAction } : {}),
    });
    const responses = step("responses", "list_responses", {
      form_id: "{{form.id}}",
      pageSize: 25,
    });
    const form = step(
      "form",
      "get_form",
      { form_id: "{{forms.items[0].id}}" },
      responses,
    );
    const forms = step(
      "forms",
      "list_forms",
      { workspace: "{{workspaces.items[0].id}}" },
      form,
    );
    const workspaces = step("workspaces", "list_workspaces", {}, forms);
    const flow = createFlow(),
      version = createDraftVersion({
        flowId: flow.id,
        displayName: "Typeform qualification",
        trigger: { name: "trigger", type: "EMPTY", nextAction: workspaces },
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
    expect(requests.map((r) => r.method + " " + r.path)).toEqual([
      "GET /workspaces",
      "GET /forms",
      "GET /forms/form1",
      "GET /forms/form1",
      "GET /forms/form1/responses",
    ]);
    expect((complete.steps?.responses as any).output.output).toMatchObject({
      items: [{ response_id: "response1", answers: [{ text: "Helpful" }] }],
    });
    const formField = metadata.actions.list_responses!.inputSchema?.fields.find(
      (f) => f.name === "form_id",
    );
    expect(formField).toMatchObject({ type: "string", required: true });
    expect(JSON.stringify(complete.steps)).not.toContain(
      "ENGINE_ONLY_TYPEFORM",
    );
  },
  90000,
);
