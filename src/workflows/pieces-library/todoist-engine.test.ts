/** Actual npm piece in the real engine. Only fetch to its provider host is redirected
 * in a disposable engine copy; no live Todoist calls or account credentials are used.
 * Gated on JARVIS_TEST_ENGINE_BUILD=1 like the other engine tests; CI runs it
 * in test.yml's engine step. It installs the pinned 0.6.1 from npm. */
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
import { JarvisTodoistConnectionSource } from "../credentials/todoist-source";
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
const piece = "@activepieces/piece-todoist";
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-todoist-engine-"));
  initWorkflowDb(join(dir, "db.sqlite"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, dependencies: { [piece]: "0.6.1" } }),
  );
  const install = spawnSync(
    "bun",
    ["install", "--silent", "--backend", "copy"],
    { cwd: dir, encoding: "utf8" },
  );
  if (install.status !== 0)
    throw new Error("npm install failed: " + install.stderr);
  const fixtureTask = (id: string, content: string) => ({
    id,
    content,
    description: "Sandbox details",
    project_id: "project1",
    section_id: null,
    parent_id: null,
    labels: ["work"],
    priority: 1,
    checked: false,
    due: {
      date: "2026-10-30",
      string: "tomorrow",
      is_recurring: false,
      timezone: null,
    },
  });
  const tasks = new Map<string, any>([
    ["task0", fixtureTask("task0", "Source task")],
  ]);
  let created = 0;
  provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url),
        path = url.pathname,
        body = req.method === "POST" ? ((await req.json()) as any) : null;
      requests.push({
        method: req.method,
        path,
        body,
        auth: req.headers.get("authorization"),
      });
      if (req.headers.get("authorization") !== "Bearer ENGINE_ONLY_TODOIST")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      if (path === "/api/v1/tasks" && req.method === "GET") {
        expect(url.searchParams.get("project_id")).toBe("project1");
        return Response.json({
          results: [...tasks.values()].filter((t) => !t.checked),
          next_cursor: null,
        });
      }
      if (path === "/api/v1/tasks" && req.method === "POST") {
        expect(body.project_id).toBe("project1");
        expect(body.content).toBe(
          created === 0 ? "Follow up on Source task" : "Closed task1: true",
        );
        const value = {
          ...fixtureTask("task" + ++created, body.content),
          ...body,
        };
        tasks.set(value.id, value);
        return Response.json(value);
      }
      const match = /^\/api\/v1\/tasks\/(task[0-9]+)(\/close)?$/.exec(path);
      if (match && tasks.has(match[1]!)) {
        const value = tasks.get(match[1]!);
        if (req.method === "GET") return Response.json(value);
        if (match[2]) {
          value.checked = true;
          return Response.json({});
        }
        expect(body.content).toBe("Updated Follow up on Source task");
        Object.assign(value, body);
        return Response.json(value);
      }
      return Response.json({ error: "unknown route" }, { status: 404 });
    },
  });
  mkdirSync(join(dir, "connections"));
  writeFileSync(
    join(dir, "connections/todoist.json"),
    JSON.stringify({
      version: 1,
      provider: "todoist",
      status: "connected",
      generation: randomUUID(),
      access_token: "ENGINE_ONLY_TODOIST",
      account: {
        id: "44444444-4444-4444-8444-444444444444",
        label: "Sandbox owner",
      },
      workspaces: [{ id: "workspace1", name: "Jarvis sandbox" }],
      refresh_token: "REFRESH_PRIVATE",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      refresh: {
        url: "https://app.usejarvis.dev/api/integrations/todoist/refresh",
        instance_id: randomUUID(),
        secret: "a".repeat(64),
      },
      connected_at: new Date().toISOString(),
    }),
  );
  const resolver = new CredentialResolver();
  resolver.register(
    new JarvisTodoistConnectionSource({
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
  const redirect = `const providerFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://api.todoist.com'){url.protocol='http:';url.host='127.0.0.1:${provider.port}';return providerFetch(url,init);}return providerFetch(input,init);};\n`;
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
  "actual published Todoist metadata, four managed actions and downstream references",
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
    if (process.env.TODOIST_CATALOG_FIXTURE)
      writeFileSync(
        process.env.TODOIST_CATALOG_FIXTURE,
        JSON.stringify(metadata),
      );
    const actions = [
      "create_task",
      "find_task",
      "update_task",
      "mark_task_completed",
    ];
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
        pieceVersion: "0.6.1",
        actionName,
        input: { auth: "{{connections.jarvis:todoist}}", ...input },
      },
      ...(nextAction ? { nextAction } : {}),
    });
    const receipt = step("receipt", "create_task", {
      project_id: "project1",
      content: "Closed {{done.task_id}}: {{done.completed}}",
    });
    const done = step(
      "done",
      "mark_task_completed",
      { task_id: "{{updated.id}}" },
      receipt,
    );
    const updated = step(
      "updated",
      "update_task",
      { task_id: "{{created.id}}", content: "Updated {{created.content}}" },
      done,
    );
    const created = step(
      "created",
      "create_task",
      {
        project_id: "project1",
        content: "Follow up on {{found.content}}",
        due_date: "2026-10-30",
      },
      updated,
    );
    const found = step(
      "found",
      "find_task",
      { project_id: "project1", name: "Source task" },
      created,
    );
    const flow = createFlow(),
      version = createDraftVersion({
        flowId: flow.id,
        displayName: "Todoist qualification",
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
    expect(requests).toHaveLength(7);
    expect(requests.every((r) => r.path.startsWith("/api/v1/tasks"))).toBe(
      true,
    );
    expect((complete.steps?.done as any).output.output).toEqual({
      success: true,
      task_id: "task1",
      completed: true,
      recurrence_advanced: false,
    });
    expect((complete.steps?.receipt as any).output.output.content).toBe(
      "Closed task1: true",
    );
    expect(
      metadata.actions.create_task!.inputSchema?.fields.find(
        (f) => f.name === "content",
      ),
    ).toMatchObject({ type: "long_text", required: true });
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
      ["done", "mark_task_completed"],
    ])
      matchSample(
        metadata.actions[action!]!.outputSample,
        (complete.steps?.[name!] as any).output.output,
        action!,
      );
    expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_TODOIST");
    expect(JSON.stringify(complete.steps)).not.toContain("REFRESH_PRIVATE");
  },
  90000,
);
