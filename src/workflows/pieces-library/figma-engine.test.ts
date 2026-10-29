/** Actual npm piece in the real engine. Only fetch to its provider host is redirected
 * in a disposable engine copy; no live Figma calls or account credentials are used.
 * Gated on JARVIS_TEST_ENGINE_BUILD=1 like the other engine tests; CI runs it
 * in test.yml's engine step. It installs the pinned 0.6.3 from npm. */
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
import { JarvisFigmaConnectionSource } from "../credentials/figma-source";
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
const piece = "@activepieces/piece-figma";
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-figma-engine-"));
  initWorkflowDb(join(dir, "db.sqlite"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, dependencies: { [piece]: "0.6.3" } }),
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
          access_token: "ENGINE_ONLY_FIGMA",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      }
      if (req.headers.get("authorization") !== "Bearer ENGINE_ONLY_FIGMA")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      const file = {
        name: "Sandbox design",
        version: "1234567890123456789",
        lastModified: "2026-10-29T12:00:00Z",
        document: {
          id: "0:0",
          type: "DOCUMENT",
          name: "Document",
          children: [],
        },
      };
      const comment = {
        id: "9876543210123456789",
        file_key: "FileKey123",
        message: "Sandbox design",
        created_at: "2026-10-29T12:00:00Z",
        user: { id: "1234567890123456789", handle: "Designer" },
      };
      if (path === "/v1/files/FileKey123") return Response.json(file);
      if (path === "/v1/files/FileKey123/comments") {
        if (req.method === "POST") expect(body).toEqual({ message: file.name });
        return Response.json(
          req.method === "POST" ? comment : { comments: [comment] },
        );
      }
      return Response.json({ error: "unknown route" }, { status: 404 });
    },
  });
  mkdirSync(join(dir, "connections"));
  writeFileSync(
    join(dir, "connections/figma.json"),
    JSON.stringify({
      version: 1,
      provider: "figma",
      status: "connected",
      generation: randomUUID(),
      access_token: "ENGINE_ONLY_FIGMA",
      refresh_token: "ENGINE_ONLY_REFRESH",
      expires_at: new Date(0).toISOString(),
      refresh: {
        url: "https://app.usejarvis.dev/api/integrations/figma/refresh",
        instance_id: randomUUID(),
        secret: "a".repeat(64),
      },
      account: { id: "1", label: "Sandbox owner" },
      workspaces: [],
      connected_at: new Date().toISOString(),
    }),
  );
  const resolver = new CredentialResolver();
  resolver.register(
    new JarvisFigmaConnectionSource(
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
  const redirect = `const providerFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://api.figma.com'){url.protocol='http:';url.host='127.0.0.1:${provider.port}';return providerFetch(url,init);}return providerFetch(input,init);};\n`;
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
  "actual published Figma metadata, three managed actions and downstream output references",
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
    expect(Object.keys(metadata.actions).sort()).toEqual([
      "custom_api_call",
      "get_comments",
      "get_file",
      "post_comment",
    ]);
    if (process.env.FIGMA_CATALOG_FIXTURE)
      writeFileSync(
        process.env.FIGMA_CATALOG_FIXTURE,
        JSON.stringify(metadata),
      );
    for (const name of ["get_file", "get_comments", "post_comment"]) {
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
        pieceVersion: "0.6.3",
        actionName,
        input: { auth: "{{connections.jarvis:figma}}", ...input },
      },
      ...(nextAction ? { nextAction } : {}),
    });
    const again = step("again", "get_file", {
      file_key: "{{comments.response_body.comments[0].file_key}}",
    });
    const comments = step(
      "comments",
      "get_comments",
      { file_key: "{{post.response_body.file_key}}" },
      again,
    );
    const post = step(
      "post",
      "post_comment",
      { file_key: "FileKey123", message: "{{read.response_body.name}}" },
      comments,
    );
    const read = step(
      "read",
      "get_file",
      {
        file_key: "https://www.figma.com/design/FileKey123/Sandbox?node-id=1-2",
      },
      post,
    );
    const flow = createFlow(),
      version = createDraftVersion({
        flowId: flow.id,
        displayName: "Figma qualification",
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
      "GET /v1/files/FileKey123",
      "POST /v1/files/FileKey123/comments",
      "GET /v1/files/FileKey123/comments",
      "GET /v1/files/FileKey123",
    ]);
    const output = (step: string) =>
      (complete.steps?.[step] as any).output.output;
    expect(output("post").response_body.message).toBe("Sandbox design");
    expect(output("again").response_body.version).toBe("1234567890123456789");
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
      ["get_file", "read"],
      ["get_comments", "comments"],
      ["post_comment", "post"],
    ])
      sampleTypes(metadata.actions[name!]!.outputSample, output(step!), name!);
    expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_FIGMA");
    expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_REFRESH");
  },
  90000,
);
