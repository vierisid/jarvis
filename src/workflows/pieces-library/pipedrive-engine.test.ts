/** Actual npm piece in the real engine. Installs the pinned npm piece, extracts
 * metadata, then executes all eight qualified actions through Worker +
 * EngineRuntime with downstream references. Only provider/refresh network
 * boundaries are local fixtures; no live Pipedrive calls or account credentials.
 * Gated on JARVIS_TEST_ENGINE_BUILD=1 like the other engine tests; CI runs it
 * in test.yml's engine step. */
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
import { JarvisPipedriveConnectionSource } from "../credentials/pipedrive-source";
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
const piece = "@activepieces/piece-pipedrive";
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-pipedrive-engine-"));
  initWorkflowDb(join(dir, "db.sqlite"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, dependencies: { [piece]: "0.10.3" } }),
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
        expect(body.refreshToken).toBe("ENGINE_ONLY_REFRESH");
        return Response.json({
          access_token: "ENGINE_ONLY_PIPEDRIVE",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      }
      if (req.headers.get("authorization") !== "Bearer ENGINE_ONLY_PIPEDRIVE")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      const person = {
        id: 101,
        name: "Sandbox Person",
        emails: [{ value: "test@example.test", primary: true, label: "work" }],
      };
      const deal = {
        id: 202,
        title: "Sandbox Person",
        value: 0,
        currency: "EUR",
        person_id: 101,
        status: "open",
      };
      if (path.endsWith("/search")) {
        const params = new URL(req.url).searchParams;
        expect(params.get("term")).toBe("Sandbox Person");
        return Response.json({
          success: true,
          data: {
            items: [
              {
                item: path.includes("persons") ? person : deal,
                result_score: 1,
              },
            ],
          },
          additional_data: { next_cursor: null },
        });
      }
      if (path.startsWith("/api/v2/persons")) {
        if (req.method === "POST")
          expect(body).toEqual({
            name: "Sandbox Person",
            emails: [
              { value: "test@example.test", label: "work", primary: true },
            ],
          });
        if (req.method === "PATCH")
          expect(body).toEqual({ name: "Sandbox Person" });
        return Response.json({ success: true, data: person });
      }
      if (path.startsWith("/api/v2/deals")) {
        if (req.method === "POST")
          expect(body).toEqual({
            title: "Sandbox Person",
            person_id: 101,
            value: 0,
            currency: "EUR",
          });
        if (req.method === "PATCH")
          expect(body).toEqual({ status: "open", probability: 0 });
        return Response.json({ success: true, data: deal });
      }
      return Response.json({ error: "unknown route" }, { status: 404 });
    },
  });
  mkdirSync(join(dir, "connections"));
  writeFileSync(
    join(dir, "connections/pipedrive.json"),
    JSON.stringify({
      version: 1,
      provider: "pipedrive",
      status: "connected",
      generation: randomUUID(),
      access_token: "ENGINE_ONLY_PIPEDRIVE",
      refresh_token: "ENGINE_ONLY_REFRESH",
      expires_at: new Date(0).toISOString(),
      refresh: {
        url: "https://app.usejarvis.dev/api/integrations/pipedrive/refresh",
        instance_id: randomUUID(),
        secret: "a".repeat(64),
      },
      account: { id: "34:12", label: "Sandbox owner" },
      workspaces: [{ id: "34", name: "Sandbox" }],
      settings: { api_host: "sandbox.pipedrive.com", company_id: "34" },
      definition: { allowedApiHosts: ["sandbox.pipedrive.com"] },
      connected_at: new Date().toISOString(),
    }),
  );
  const resolver = new CredentialResolver();
  resolver.register(
    new JarvisPipedriveConnectionSource(
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
  const redirect = `const providerFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://sandbox.pipedrive.com'){url.protocol='http:';url.host='127.0.0.1:${provider.port}';return providerFetch(url,init);}return providerFetch(input,init);};\n`;
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
test.skipIf(!gate)("actual published Pipedrive metadata, eight managed actions and downstream output references", async () => {
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
  expect(Object.keys(metadata.actions)).toHaveLength(62);
  expect(Object.keys(metadata.triggers ?? {})).toHaveLength(14);
  if (process.env.PIPEDRIVE_CATALOG_FIXTURE)
    writeFileSync(
      process.env.PIPEDRIVE_CATALOG_FIXTURE,
      JSON.stringify(metadata),
    );
  const qualified = [
    "get-person",
    "search-persons",
    "create-person",
    "update-person",
    "get-deal",
    "search-deals",
    "create-deal",
    "update-deal",
  ];
  for (const name of qualified) {
    expect(metadata.actions[name]?.requireAuth).toBe(true);
    expect(metadata.actions[name]?.outputSample).toBeDefined();
    expect(resolveGovernedPieceAction(piece, name)?.known).toBe(true);
  }
  for (const name of Object.keys(metadata.actions).filter(
    (n) => n !== "custom_api_call",
  ))
    expect(resolveGovernedPieceAction(piece, name)?.known, name).toBe(true);
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
      pieceVersion: "0.10.3",
      actionName,
      input: { auth: "{{connections.jarvis:pipedrive}}", ...input },
    },
    ...(nextAction ? { nextAction } : {}),
  });
  const updateDeal = step("updateDeal", "update-deal", {
    dealId: "{{searchDeal.data[0].id}}",
    status: "open",
    probability: 0,
  });
  const searchDeal = step(
    "searchDeal",
    "search-deals",
    { term: "{{getDeal.data.title}}", fields: ["title"] },
    updateDeal,
  );
  const getDeal = step(
    "getDeal",
    "get-deal",
    { dealId: "{{createDeal.data.id}}" },
    searchDeal,
  );
  const createDeal = step(
    "createDeal",
    "create-deal",
    {
      title: "{{updatePerson.data.name}}",
      personId: "{{updatePerson.data.id}}",
      dealValue: 0,
      dealValueCurrency: "EUR",
    },
    getDeal,
  );
  const updatePerson = step(
    "updatePerson",
    "update-person",
    {
      personId: "{{searchPerson.data[0].id}}",
      name: "{{searchPerson.data[0].name}}",
    },
    createDeal,
  );
  const searchPerson = step(
    "searchPerson",
    "search-persons",
    { term: "{{getPerson.data.name}}", fields: ["name"] },
    updatePerson,
  );
  const getPerson = step(
    "getPerson",
    "get-person",
    { personId: "{{createPerson.data.id}}" },
    searchPerson,
  );
  const read = step(
    "createPerson",
    "create-person",
    { name: "Sandbox Person", email: ["test@example.test"] },
    getPerson,
  );
  const flow = createFlow(),
    version = createDraftVersion({
      flowId: flow.id,
      displayName: "Pipedrive qualification",
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
    "POST /api/v2/persons",
    "GET /api/v2/persons/101",
    "GET /api/v2/persons/search",
    "PATCH /api/v2/persons/101",
    "POST /api/v2/deals",
    "GET /api/v2/deals/202",
    "GET /api/v2/deals/search",
    "PATCH /api/v2/deals/202",
  ]);
  const output = (step: string) =>
    (complete.steps?.[step] as any).output.output;
  expect(output("createDeal").data.person_id).toBe(101);
  expect(output("searchPerson").found).toBe(true);
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
    ["get-person", "getPerson"],
    ["create-person", "createPerson"],
    ["search-persons", "searchPerson"],
    ["update-person", "updatePerson"],
    ["get-deal", "getDeal"],
    ["create-deal", "createDeal"],
    ["search-deals", "searchDeal"],
    ["update-deal", "updateDeal"],
  ])
    sampleTypes(metadata.actions[name!]!.outputSample, output(step!), name!);
  expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_PIPEDRIVE");
  expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_REFRESH");
}, 90000);
