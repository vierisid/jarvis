/** Published Help Scout package through Worker and EngineRuntime. It installs the
 * pinned piece from npm and builds an engine bundle, so it runs only with
 * JARVIS_TEST_ENGINE_BUILD=1 (the required test job's bun test run sets it). Provider HTTP alone is
 * redirected in a disposable engine bundle. No live credentials. */
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
import { JarvisHelpScoutConnectionSource } from "../credentials/help-scout-source";
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
const piece = "@activepieces/piece-help-scout";
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-help-scout-engine-"));
  initWorkflowDb(join(dir, "db.sqlite"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, dependencies: { [piece]: "0.2.1" } }),
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
      if (path === "/refresh") {
        if (body.ack) return Response.json({ acknowledged: true });
        expect(body.refreshToken).toBe("ENGINE_ONLY_REFRESH");
        return Response.json({
          access_token: "ENGINE_ONLY_HELP_SCOUT",
          refresh_token: "ENGINE_ONLY_ROTATED",
          receipt: "f73b15a1-3e5c-4ecb-941d-ce0921c55e27",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      }
      if (req.headers.get("authorization") !== "Bearer ENGINE_ONLY_HELP_SCOUT")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      const customer = {
        id: 123,
        firstName: "Example",
        lastName: "Customer",
        _embedded: { emails: [{ value: "customer@example.test" }] },
      };
      const conversation = {
        id: 456,
        number: 12,
        mailboxId: 34,
        subject: "Example request",
        status: "active",
        preview: "Example message",
        primaryCustomer: { id: 123, email: "customer@example.test" },
      };
      const page = (key: string, rows: unknown[]) => ({
        _embedded: { [key]: rows },
        page: { number: 1, totalPages: 1, totalElements: rows.length },
      });
      if (path === "/v2/customers")
        return Response.json(page("customers", [customer]));
      if (path === "/v2/conversations")
        return Response.json(page("conversations", [conversation]));
      if (path === "/v2/conversations/456") return Response.json(conversation);
      if (path === "/v2/conversations/456/notes" && req.method === "POST") {
        expect(body).toEqual({ text: "Example request", user: 123 });
        return new Response(null, {
          status: 201,
          headers: { "Resource-ID": "789" },
        });
      }
      return Response.json({ error: "unknown route" }, { status: 404 });
    },
  });
  mkdirSync(join(dir, "connections"));
  writeFileSync(
    join(dir, "connections/help-scout.json"),
    JSON.stringify({
      version: 1,
      provider: "help-scout",
      status: "connected",
      generation: randomUUID(),
      access_token: "ENGINE_ONLY_HELP_SCOUT",
      refresh_token: "ENGINE_ONLY_REFRESH",
      expires_at: new Date(0).toISOString(),
      refresh: {
        url: "https://app.usejarvis.dev/api/integrations/help-scout/refresh",
        instance_id: randomUUID(),
        secret: "a".repeat(64),
      },
      account: { id: "123", label: "Sandbox owner" },
      workspaces: [],
      connected_at: new Date().toISOString(),
    }),
  );
  const resolver = new CredentialResolver();
  resolver.register(
    new JarvisHelpScoutConnectionSource(
      {
        daemon: { data_dir: dir },
        usejarvis_integrations: {
          page_url: "https://app.usejarvis.dev/account",
        },
      } as any,
      ((url: string, init: RequestInit) =>
        fetch(
          `http://127.0.0.1:${provider.port}/refresh`,
          init,
        )) as typeof fetch,
    ),
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
  const redirect = `const providerFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://api.helpscout.net'){url.protocol='http:';url.host='127.0.0.1:${provider.port}';return providerFetch(url,init);}return providerFetch(input,init);};\n`;
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
test.skipIf(!gate)("published Help Scout metadata, all three managed actions, refresh acknowledgement and downstream references", async () => {
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
  expect(Object.keys(metadata.actions).sort()).toEqual([
    "add_note",
    "create_conversation",
    "create_customer",
    "custom_api_call",
    "find_conversation",
    "find_customer",
    "find_user",
    "send_reply",
    "update_customer_properties",
  ]);
  for (const name of Object.keys(metadata.actions))
    expect(resolveGovernedPieceAction(piece, name)?.known).toBe(true);
  if (process.env.HELP_SCOUT_CATALOG_FIXTURE)
    writeFileSync(
      process.env.HELP_SCOUT_CATALOG_FIXTURE,
      JSON.stringify(metadata),
    );
  for (const name of ["find_customer", "find_conversation", "add_note"]) {
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
      pieceVersion: "0.2.1",
      actionName,
      input: { auth: "{{connections.jarvis:help-scout}}", ...input },
    },
    ...(nextAction ? { nextAction } : {}),
  });
  const note = step("note", "add_note", {
    conversationId: "{{lookup.data.id}}",
    text: "{{lookup.data.subject}}",
  });
  const lookup = step(
    "lookup",
    "find_conversation",
    { conversationId: "{{find.data.id}}" },
    note,
  );
  const find = step(
    "find",
    "find_conversation",
    { mailboxId: "34", number: "12" },
    lookup,
  );
  const read = step(
    "customer",
    "find_customer",
    { email: "customer@example.test" },
    find,
  );
  const flow = createFlow(),
    version = createDraftVersion({
      flowId: flow.id,
      displayName: "Help Scout qualification",
      trigger: { name: "trigger", type: "EMPTY", nextAction: read },
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
    "POST /refresh",
    "POST /refresh",
    "GET /v2/customers",
    "GET /v2/conversations",
    "GET /v2/conversations/456",
    "POST /v2/conversations/456/notes",
  ]);
  const output = (step: string) =>
    (complete.steps?.[step] as any).output.output;
  expect(output("note")).toEqual({ id: "789" });
  expect(output("lookup").data.id).toBe(456);
  expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_ROTATED");
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
    ["find_customer", "customer"],
    ["find_conversation", "find"],
    ["find_conversation", "lookup"],
    ["add_note", "note"],
  ])
    sampleTypes(metadata.actions[name!]!.outputSample, output(step!), name!);
  expect(JSON.stringify(complete.steps)).not.toContain(
    "ENGINE_ONLY_HELP_SCOUT",
  );
  expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_REFRESH");
}, 90000);
