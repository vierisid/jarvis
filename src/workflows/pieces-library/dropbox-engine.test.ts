/** Actual npm piece in the real engine. Only fetch to its provider host is redirected
 * in a disposable engine copy; no live Dropbox calls or account credentials are used.
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
import { JarvisDropboxConnectionSource } from "../credentials/dropbox-source";
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
const piece = "@activepieces/piece-dropbox";
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-dropbox-engine-"));
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
        body = (await req.json()) as any;
      requests.push({
        method: req.method,
        path,
        body,
        auth: req.headers.get("authorization"),
      });
      if (path === "/refresh") {
        expect(body.refreshToken).toBe("ENGINE_ONLY_REFRESH");
        return Response.json({
          access_token: "ENGINE_ONLY_DROPBOX",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      }
      if (req.headers.get("authorization") !== "Bearer ENGINE_ONLY_DROPBOX")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      if (path.endsWith("/create_folder_v2"))
        return Response.json({
          metadata: {
            ".tag": "folder",
            id: "id:folder1",
            name: "Sandbox",
            path_lower: "/sandbox",
            path_display: "/Sandbox",
          },
        });
      if (path.endsWith("/get_metadata"))
        return Response.json({
          ".tag": "folder",
          id: "id:folder1",
          name: "Sandbox",
          path_lower: "/sandbox",
        });
      if (path.endsWith("/list_folder"))
        return Response.json({
          entries: [{ ".tag": "folder", id: "id:folder1", name: "Sandbox" }],
          cursor: "cursor",
          has_more: false,
        });
      if (path.endsWith("/search_v2"))
        return Response.json({
          matches: [
            {
              metadata: {
                ".tag": "metadata",
                metadata: {
                  ".tag": "folder",
                  id: "id:folder1",
                  name: "Sandbox",
                },
              },
            },
          ],
          has_more: false,
        });
      return Response.json({ error: "unknown route" }, { status: 404 });
    },
  });
  mkdirSync(join(dir, "connections"));
  writeFileSync(
    join(dir, "connections/dropbox.json"),
    JSON.stringify({
      version: 1,
      provider: "dropbox",
      status: "connected",
      generation: randomUUID(),
      access_token: "ENGINE_ONLY_DROPBOX",
      refresh_token: "ENGINE_ONLY_REFRESH",
      expires_at: new Date(0).toISOString(),
      refresh: {
        url: "https://app.usejarvis.dev/api/integrations/dropbox/refresh",
        instance_id: randomUUID(),
        secret: "a".repeat(64),
      },
      settings: { home_namespace_id: "123" },
      account: { id: "dbid:1", label: "Sandbox owner" },
      workspaces: [{ id: "123", name: "Dropbox home" }],
      connected_at: new Date().toISOString(),
    }),
  );
  const resolver = new CredentialResolver();
  resolver.register(
    new JarvisDropboxConnectionSource(
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
  const redirect = `const providerFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://api.dropboxapi.com'){url.protocol='http:';url.host='127.0.0.1:${provider.port}';return providerFetch(url,init);}return providerFetch(input,init);};\n`;
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
  "catalog extraction and create/metadata/list/search through actual engine, managed credential and downstream references",
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
    for (const name of [
      "create_new_dropbox_folder",
      "get_dropbox_file_metadata",
      "list_dropbox_folder",
      "search_dropbox",
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
        input: { auth: "{{connections.jarvis:dropbox}}", ...input },
      },
      ...(nextAction ? { nextAction } : {}),
    });
    const find = step("find", "search_dropbox", {
      query: "{{read.name}}",
      max_results: 10,
      filename_only: true,
    });
    const list = step(
      "list",
      "list_dropbox_folder",
      { path: "{{read.path_lower}}", limit: 10 },
      find,
    );
    const read = step(
      "read",
      "get_dropbox_file_metadata",
      { path: "{{create.metadata.id}}" },
      list,
    );
    const create = step(
      "create",
      "create_new_dropbox_folder",
      { path: "/Sandbox", autorename: false },
      read,
    );
    const flow = createFlow(),
      version = createDraftVersion({
        flowId: flow.id,
        displayName: "Dropbox qualification",
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
      "POST /refresh",
      "POST /2/files/create_folder_v2",
      "POST /2/files/get_metadata",
      "POST /2/files/list_folder",
      "POST /2/files/search_v2",
    ]);
    expect((complete.steps?.find as any).output.output).toMatchObject({
      has_more: false,
    });
    expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_DROPBOX");
    expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_REFRESH");
  },
  90000,
);
