/** Actual npm piece in the real engine. Only fetch to its provider host is redirected
 * in a disposable engine copy; no live Airtable calls or account credentials are used.
 * Gated on JARVIS_TEST_ENGINE_BUILD=1 like the other engine tests; CI runs it
 * in test.yml's engine step. It installs the pinned 0.9.2 from npm. */
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
import { JarvisAirtableConnectionSource } from "../credentials/airtable-source";
import { AuthorityEngine } from "../../authority/engine";
import { ApprovalManager } from "../../authority/approval";
import { AuditTrail } from "../../authority/audit";
import { EmergencyController } from "../../authority/emergency";
import { WorkflowEventBuffer } from "../runtime/event-buffer";
import { buildSandboxServiceBackends } from "../runtime/service-backends";
import { buildPieceCatalog } from "../runtime/piece-catalog";
import {
  resolveGovernedPieceAction,
  MANAGED_PIECE_ADAPTERS,
} from "../runtime/piece-effects";
import { SandboxApi } from "../sandbox-api/server";
import { workflowLogsBase } from "../sandbox-api/config";
import { buildEngineBundle } from "../runner/engine-runtime/build";
import { EngineRuntime } from "../runner/engine-runtime/engine-runtime";
import { EngineFlowExecutor } from "../runner/engine-runtime/engine-flow-executor";
import { createRunFlowHandler } from "../runner/handler";
import { Worker } from "../queue/worker";
const gate = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const piece = "@activepieces/piece-airtable";
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-airtable-engine-"));
  initWorkflowDb(join(dir, "db.sqlite"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, dependencies: { [piece]: "0.9.2" } }),
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
      if (req.headers.get("authorization") !== "Bearer ENGINE_ONLY_AIRTABLE")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      const record = {
        id: "recAAAAAAAAAAAAAA",
        createdTime: "2026-10-28T10:00:00Z",
        fields: { Name: "Hello" },
      };
      if (path === "/v0/meta/bases/appAAAAAAAAAAAAAA/tables")
        return Response.json({
          tables: [
            {
              id: "tblAAAAAAAAAAAAAA",
              name: "Tasks",
              fields: [
                {
                  id: "fldAAAAAAAAAAAAAA",
                  name: "Name",
                  type: "singleLineText",
                },
              ],
              views: [],
            },
          ],
        });
      if (path === "/v0/appAAAAAAAAAAAAAA/tblAAAAAAAAAAAAAA")
        return Response.json(
          req.method === "GET" ? { records: [record] } : record,
        );
      if (path === "/v0/appAAAAAAAAAAAAAA/tblAAAAAAAAAAAAAA/recAAAAAAAAAAAAAA")
        return Response.json(record);
      return Response.json({ error: "unknown route" }, { status: 404 });
    },
  });
  mkdirSync(join(dir, "connections"));
  writeFileSync(
    join(dir, "connections/airtable.json"),
    JSON.stringify({
      version: 1,
      provider: "airtable",
      status: "connected",
      generation: randomUUID(),
      access_token: "ENGINE_ONLY_AIRTABLE",
      account: { id: "workspace1:admin1", label: "Sandbox owner" },
      workspaces: [{ id: "workspace1", name: "Jarvis sandbox" }],
      refresh_token: "REFRESH_PRIVATE",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      refresh: {
        url: "https://app.usejarvis.dev/api/integrations/airtable/refresh",
        instance_id: randomUUID(),
        secret: "a".repeat(64),
      },
      connected_at: new Date().toISOString(),
    }),
  );
  const resolver = new CredentialResolver();
  resolver.register(
    new JarvisAirtableConnectionSource({
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
  const redirect = `const providerFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://api.airtable.com'){url.protocol='http:';url.host='127.0.0.1:${provider.port}';return providerFetch(url,init);}return providerFetch(input,init);};\n`;
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
  "catalog extraction and four record actions through actual engine, managed credential and downstream references",
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
    const adapter = MANAGED_PIECE_ADAPTERS.find((a) => a.pieceName === piece)!;
    expect(Object.values(adapter.categories).flat().sort()).toEqual(
      Object.keys(metadata.actions)
        .filter((a) => a !== "custom_api_call")
        .sort(),
    );

    expect(metadata.auth?.type).toBe("SECRET_TEXT");
    if (process.env.AIRTABLE_CATALOG_FIXTURE)
      writeFileSync(
        process.env.AIRTABLE_CATALOG_FIXTURE,
        JSON.stringify(metadata),
      );
    for (const name of [
      "create_record_ai",
      "get_record",
      "update_record_ai",
      "search_records",
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
        pieceVersion: "0.9.2",
        actionName,
        input: { auth: "{{connections.jarvis:airtable}}", ...input },
      },
      ...(nextAction ? { nextAction } : {}),
    });
    const location = {
      base_id: "appAAAAAAAAAAAAAA",
      table_id_or_name: "tblAAAAAAAAAAAAAA",
    };
    const find = step("find", "search_records", {
      ...location,
      search_field: "fldAAAAAAAAAAAAAA",
      search_value: "Hello",
    });
    const update = step(
      "update",
      "update_record_ai",
      { ...location, record_id: "{{read.id}}", fields: { Name: "Updated" } },
      find,
    );
    const read = step(
      "read",
      "get_record",
      { ...location, record_id: "{{create.id}}" },
      update,
    );
    const create = step(
      "create",
      "create_record_ai",
      { ...location, fields: { Name: "Hello" } },
      read,
    );
    const flow = createFlow(),
      version = createDraftVersion({
        flowId: flow.id,
        displayName: "Airtable qualification",
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
    expect(requests.map((r) => r.method + " " + r.path)).toEqual([
      "GET /v0/meta/bases/appAAAAAAAAAAAAAA/tables",
      "POST /v0/appAAAAAAAAAAAAAA/tblAAAAAAAAAAAAAA",
      "GET /v0/appAAAAAAAAAAAAAA/tblAAAAAAAAAAAAAA/recAAAAAAAAAAAAAA",
      "GET /v0/meta/bases/appAAAAAAAAAAAAAA/tables",
      "PATCH /v0/appAAAAAAAAAAAAAA/tblAAAAAAAAAAAAAA/recAAAAAAAAAAAAAA",
      "GET /v0/meta/bases/appAAAAAAAAAAAAAA/tables",
      "GET /v0/appAAAAAAAAAAAAAA/tblAAAAAAAAAAAAAA",
    ]);
    expect((complete.steps?.find as any).output.output).toMatchObject({
      count: 1,
      records: [{ id: "recAAAAAAAAAAAAAA", fields: { Name: "Hello" } }],
    });
    expect(
      metadata.actions.update_record_ai!.inputSchema?.fields.find(
        (f) => f.name === "record_id",
      ),
    ).toMatchObject({ type: "string", required: true });
    expect(
      metadata.actions.create_record_ai!.inputSchema?.fields.find(
        (f) => f.name === "fields",
      ),
    ).toMatchObject({ type: "json", required: true });
    expect(JSON.stringify(complete.steps)).not.toContain(
      "ENGINE_ONLY_AIRTABLE",
    );
  },
  90000,
);
