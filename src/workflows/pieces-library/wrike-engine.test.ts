/** Actual npm piece in the real engine. Only fetch to its provider host is redirected
 * in a disposable engine copy; no live Wrike calls or account credentials are used.
 * Gated on JARVIS_TEST_ENGINE_BUILD=1 like the other engine tests; CI runs it
 * in the required test job, whose bun test run sets that gate. It installs the pinned 0.2.0 from npm. */
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
import { JarvisWrikeConnectionSource } from "../credentials/wrike-source";
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
const piece = "@activepieces/piece-wrike";
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-wrike-engine-"));
  initWorkflowDb(join(dir, "db.sqlite"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, dependencies: { [piece]: "0.2.0" } }),
  );
  const install = spawnSync(
    "bun",
    ["install", "--silent", "--backend", "copy"],
    { cwd: dir, encoding: "utf8" },
  );
  if (install.status !== 0)
    throw new Error("npm install failed: " + install.stderr);
  const tasks = new Map<string, any>([
    ["TASK1", { id: "TASK1", title: "Source task" }],
  ]);
  provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url),
        form = new URLSearchParams(
          req.method === "GET" ? url.search : await req.text(),
        );
      requests.push({
        method: req.method,
        path: url.pathname,
        body: Object.fromEntries(form),
        auth: req.headers.get("authorization"),
      });
      if (req.headers.get("authorization") !== "Bearer ENGINE_ONLY_WRIKE")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      if (req.method === "GET" && url.pathname === "/api/v4/tasks/TASK1")
        return Response.json({ kind: "tasks", data: [tasks.get("TASK1")] });
      if (
        req.method === "POST" &&
        url.pathname === "/api/v4/folders/FOLDER1/tasks"
      ) {
        expect(form.get("title")).toBe("Follow up on Source task");
        const task = { id: "TASK2", title: form.get("title") };
        tasks.set(task.id, task);
        return Response.json({ kind: "tasks", data: [task] });
      }
      if (req.method === "PUT" && url.pathname === "/api/v4/tasks/TASK2") {
        expect(form.get("title")).toBe("Renamed task");
        const task = tasks.get("TASK2");
        task.title = form.get("title");
        return Response.json({ kind: "tasks", data: [task] });
      }
      if (
        req.method === "POST" &&
        url.pathname === "/api/v4/tasks/TASK2/comments"
      ) {
        expect(form.get("text")).toBe("Updated TASK2: Renamed task");
        expect(form.get("plainText")).toBe("true");
        return Response.json({
          kind: "comments",
          data: [{ id: "COMMENT1", text: form.get("text") }],
        });
      }
      return Response.json({ error: "unknown operation" }, { status: 400 });
    },
  });
  mkdirSync(join(dir, "connections"));
  writeFileSync(
    join(dir, "connections/wrike.json"),
    JSON.stringify({
      version: 1,
      provider: "wrike",
      status: "connected",
      generation: randomUUID(),
      access_token: "ENGINE_ONLY_WRIKE",
      account: {
        id: "KUAAAAAA",
        label: "Sandbox owner",
      },
      workspaces: [{ id: "workspace1", name: "Jarvis sandbox" }],
      refresh_token: "REFRESH_PRIVATE",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      refresh: {
        url: "https://app.usejarvis.dev/api/integrations/wrike/refresh",
        instance_id: randomUUID(),
        secret: "a".repeat(64),
      },
      settings: { api_host: "app-eu.wrike.com" },
      definition: { allowedApiHosts: ["app-eu.wrike.com"] },
      connected_at: new Date().toISOString(),
    }),
  );
  const resolver = new CredentialResolver();
  resolver.register(
    new JarvisWrikeConnectionSource({
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
  const redirect = `const providerFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://app-eu.wrike.com'){url.protocol='http:';url.host='127.0.0.1:${provider.port}';return providerFetch(url,init);}return providerFetch(input,init);};\n`;
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
  "actual published Wrike metadata, four managed actions and downstream references",
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
    if (process.env.WRIKE_CATALOG_FIXTURE)
      writeFileSync(
        process.env.WRIKE_CATALOG_FIXTURE,
        JSON.stringify(metadata),
      );
    // Every action the installed package declares is in the governed table, so
    // an upstream addition fails here instead of falling to modify_settings.
    const all = Object.keys(metadata.actions);
    expect(all.length).toBe(9);
    expect(
      all.filter((name) => !resolveGovernedPieceAction(piece, name)!.known),
    ).toEqual([]);
    expect(Object.keys(metadata.triggers ?? {}).sort()).toEqual([
      "new_folder",
      "new_subtask_created",
      "new_task",
    ]);
    const actions = ["find_task", "create_task", "update_task", "add_comment"];
    for (const action of actions) {
      expect(metadata.actions[action]?.requireAuth).toBe(true);
      expect(metadata.actions[action]?.outputSample).toBeDefined();
      expect(resolveGovernedPieceAction(piece, action)?.known).toBe(true);
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
        pieceVersion: "0.2.0",
        actionName,
        input: { auth: "{{connections.jarvis:wrike}}", ...input },
      },
      ...(nextAction ? { nextAction } : {}),
    });
    const comment = step("comment", "add_comment", {
      entityType: "tasks",
      entityId: "{{updated.data[0].id}}",
      text: "Updated {{updated.data[0].id}}: {{updated.data[0].title}}",
    });
    const updated = step(
      "updated",
      "update_task",
      { taskId: "{{created.data[0].id}}", title: "Renamed task" },
      comment,
    );
    const created = step(
      "created",
      "create_task",
      { folderId: "FOLDER1", title: "Follow up on {{found.data[0].title}}" },
      updated,
    );
    const found = step("found", "find_task", { taskId: "TASK1" }, created);
    const flow = createFlow(),
      version = createDraftVersion({
        flowId: flow.id,
        displayName: "Wrike qualification",
        trigger: { name: "trigger", type: "EMPTY", nextAction: found },
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
    expect(requests).toHaveLength(4);
    expect(requests.map((r) => r.method)).toEqual([
      "GET",
      "POST",
      "PUT",
      "POST",
    ]);
    expect((complete.steps?.comment as any).output.output).toEqual({
      kind: "comments",
      data: [{ id: "COMMENT1", text: "Updated TASK2: Renamed task" }],
    });
    function matchSample(sample: any, actual: any, path: string) {
      if (Array.isArray(sample)) {
        expect(Array.isArray(actual), path).toBe(true);
        if (sample.length) matchSample(sample[0], actual[0], path + "[0]");
      } else if (sample && typeof sample === "object") {
        for (const [key, value] of Object.entries(sample))
          matchSample(value, actual?.[key], path + "." + key);
      } else expect(typeof actual, path).toBe(typeof sample);
    }
    for (const [name, action] of [
      ["found", "find_task"],
      ["created", "create_task"],
      ["updated", "update_task"],
      ["comment", "add_comment"],
    ])
      matchSample(
        metadata.actions[action!]!.outputSample,
        (complete.steps?.[name!] as any).output.output,
        action!,
      );
    expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_WRIKE");
    expect(JSON.stringify(complete.steps)).not.toContain("REFRESH_PRIVATE");
  },
  90000,
);
