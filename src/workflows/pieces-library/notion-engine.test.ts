/** Actual npm piece in the real engine. Only fetch to its provider host is redirected
 * in a disposable engine copy; no live Notion calls or account credentials are used.
 * Gated on JARVIS_TEST_ENGINE_BUILD=1 like the other engine tests; CI runs it
 * in notion-qualification.yml. It installs the pinned 0.8.1 from npm. */
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
import { JarvisNotionConnectionSource } from "../credentials/notion-source";
import { AuthorityEngine } from "../../authority/engine";
import { ApprovalManager } from "../../authority/approval";
import { AuditTrail } from "../../authority/audit";
import { EmergencyController } from "../../authority/emergency";
import { WorkflowEventBuffer } from "../runtime/event-buffer";
import { buildSandboxServiceBackends } from "../runtime/service-backends";
import { buildPieceCatalog } from "../runtime/piece-catalog";
import {
  resolveGovernedPieceAction,
  ALL_PIECE_ADAPTERS,
} from "../runtime/piece-effects";
import { SandboxApi } from "../sandbox-api/server";
import { workflowLogsBase } from "../sandbox-api/config";
import { buildEngineBundle } from "../runner/engine-runtime/build";
import { EngineRuntime } from "../runner/engine-runtime/engine-runtime";
import { EngineFlowExecutor } from "../runner/engine-runtime/engine-flow-executor";
import { createRunFlowHandler } from "../runner/handler";
import { Worker } from "../queue/worker";
const gate = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const piece = "@activepieces/piece-notion";
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-notion-engine-"));
  initWorkflowDb(join(dir, "db.sqlite"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, dependencies: { [piece]: "0.8.1" } }),
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
      if (req.headers.get("authorization") !== "Bearer ENGINE_ONLY_NOTION")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      const id = "11111111-1111-4111-8111-111111111111";
      const page = {
        object: "page",
        id,
        url: "https://www.notion.so/" + id,
        created_time: "2026-10-28T10:00:00Z",
        last_edited_time: "2026-10-28T10:00:00Z",
        archived: false,
        parent: { type: "page_id", page_id: id },
        properties: {
          title: {
            type: "title",
            title: [{ plain_text: "Hello", text: { content: "Hello" } }],
          },
        },
      };
      const block = {
        object: "block",
        id: "22222222-2222-4222-8222-222222222222",
        type: "paragraph",
        has_children: false,
        paragraph: {
          rich_text: [{ plain_text: "Hello", text: { content: "Hello" } }],
        },
      };
      if (path === "/v1/users/me")
        return Response.json({ id: "bot1", type: "bot" });
      if (path === "/v1/pages") return Response.json(page);
      if (path === "/v1/search")
        return Response.json({
          object: "list",
          results: [page],
          has_more: false,
          next_cursor: null,
        });
      if (path === "/v1/blocks/" + id + "/children")
        return Response.json({
          object: "list",
          results: [block],
          has_more: false,
          next_cursor: null,
        });
      return Response.json({ error: "unknown route" }, { status: 404 });
    },
  });
  mkdirSync(join(dir, "connections"));
  writeFileSync(
    join(dir, "connections/notion.json"),
    JSON.stringify({
      version: 1,
      provider: "notion",
      status: "connected",
      generation: randomUUID(),
      access_token: "ENGINE_ONLY_NOTION",
      account: { id: "bot1", label: "Sandbox owner" },
      workspaces: [{ id: "workspace1", name: "Jarvis sandbox" }],
      refresh_token: "REFRESH_PRIVATE",
      expires_at: null,
      refresh: {
        url: "https://app.usejarvis.dev/api/integrations/notion/refresh",
        instance_id: randomUUID(),
        secret: "a".repeat(64),
      },
      connected_at: new Date().toISOString(),
    }),
  );
  const resolver = new CredentialResolver();
  resolver.register(
    new JarvisNotionConnectionSource(
      {
        daemon: { data_dir: dir },
        usejarvis_integrations: {
          page_url: "https://app.usejarvis.dev/account",
        },
      } as any,
      (async (input, init) => {
        const url = new URL(String(input));
        if (url.origin !== "https://api.notion.com")
          throw new Error("Unexpected origin");
        return fetch(
          "http://127.0.0.1:" + provider.port + url.pathname + url.search,
          init,
        );
      }) as typeof fetch,
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
  const redirect = `const providerFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://api.notion.com'){url.protocol='http:';url.host='127.0.0.1:${provider.port}';return providerFetch(url,init);}return providerFetch(input,init);};\n`;
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
  "catalog extraction and four page actions through actual engine, managed credential and downstream references",
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
    const adapter = ALL_PIECE_ADAPTERS.find((a) => a.pieceName === piece)!;
    for (const action of Object.keys(metadata.actions))
      expect(Object.values(adapter.categories).flat()).toContain(action);

    expect(metadata.auth?.type).toBe("OAUTH2");
    if (process.env.NOTION_CATALOG_FIXTURE)
      writeFileSync(
        process.env.NOTION_CATALOG_FIXTURE,
        JSON.stringify(metadata),
      );
    for (const name of [
      "createPage",
      "append_to_page",
      "find_page",
      "notion_get_block_children",
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
        pieceVersion: "0.8.1",
        actionName,
        input: { auth: "{{connections.jarvis:notion}}", ...input },
      },
      ...(nextAction ? { nextAction } : {}),
    });
    const find = step("find", "find_page", { title: "Hello" });
    const read = step(
      "read",
      "notion_get_block_children",
      { block_id: "{{create.id}}", markdown: false, depth: 1 },
      find,
    );
    const append = step(
      "append",
      "append_to_page",
      { pageId: "{{create.id}}", content: "More notes" },
      read,
    );
    const create = step(
      "create",
      "createPage",
      {
        pageId: "11111111-1111-4111-8111-111111111111",
        title: "Hello",
        content: "Notes",
      },
      append,
    );
    const flow = createFlow(),
      version = createDraftVersion({
        flowId: flow.id,
        displayName: "Notion qualification",
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
        .filter((r) => r.path !== "/v1/users/me")
        .map((r) => r.method + " " + r.path),
    ).toEqual([
      "POST /v1/pages",
      "PATCH /v1/blocks/11111111-1111-4111-8111-111111111111/children",
      "GET /v1/blocks/11111111-1111-4111-8111-111111111111/children",
      "POST /v1/search",
    ]);
    expect((complete.steps?.find as any).output.output).toMatchObject({
      returned: 1,
      pages: [{ id: "11111111-1111-4111-8111-111111111111", title: "Hello" }],
    });
    expect(
      metadata.actions.createPage!.inputSchema?.fields.find(
        (f) => f.name === "pageId",
      ),
    ).toMatchObject({ type: "string", required: true });
    expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_NOTION");
  },
  90000,
);
