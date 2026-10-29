/** Actual npm piece in the real engine. Only fetch to its provider host is redirected
 * in a disposable engine copy; no live Monday calls or account credentials are used.
 * Gated on JARVIS_TEST_ENGINE_BUILD=1 like the other engine tests; CI runs it
 * in test.yml's engine step. It installs the pinned 0.4.0 from npm. */
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
import { JarvisMondayConnectionSource } from "../credentials/monday-source";
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
const piece = "@activepieces/piece-monday";
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-monday-engine-"));
  initWorkflowDb(join(dir, "db.sqlite"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, dependencies: { [piece]: "0.4.0" } }),
  );
  const install = spawnSync(
    "bun",
    ["install", "--silent", "--backend", "copy"],
    { cwd: dir, encoding: "utf8" },
  );
  if (install.status !== 0)
    throw new Error("npm install failed: " + install.stderr);
  const board = {
    id: "100",
    name: "Sandbox",
    groups: [{ id: "topics", title: "Tasks" }],
    columns: [
      { id: "text", title: "Text", type: "text" },
      { id: "number", title: "Number", type: "numbers" },
    ],
  };
  const items = new Map<string, any>([
    [
      "200",
      {
        id: "200",
        name: "Source item",
        board: { id: "100" },
        column_values: [
          {
            id: "text",
            type: "text",
            text: "Source text",
            value: '"Source text"',
          },
        ],
      },
    ],
  ]);
  provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as any,
        q = body.query,
        v = body.variables;
      requests.push({
        method: req.method,
        path: new URL(req.url).pathname,
        body,
        auth: req.headers.get("authorization"),
      });
      if (req.headers.get("authorization") !== "ENGINE_ONLY_MONDAY")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      expect(req.headers.get("API-Version")).toBe("2026-07");
      if (q.includes("JarvisBoard"))
        return Response.json({ data: { boards: [board] } });
      if (q.includes("JarvisItem"))
        return Response.json({
          data: { items: items.has(v.ids[0]) ? [items.get(v.ids[0])] : [] },
        });
      if (q.includes("JarvisCreateItem")) {
        expect(v.name).toBe("Follow up on Source item");
        expect(v.board).toBe("100");
        const value = {
          id: "201",
          name: v.name,
          board: { id: v.board },
          column_values: [
            { id: "text", type: "text", text: "Hello", value: '"Hello"' },
          ],
        };
        items.set("201", value);
        return Response.json({ data: { create_item: value } });
      }
      if (q.includes("JarvisChangeColumns")) {
        expect(v.item).toBe("201");
        expect(v.board).toBe("100");
        const value = items.get(v.item),
          changes = JSON.parse(v.values);
        if (changes.name) value.name = changes.name;
        else
          value.column_values = [
            { id: "number", type: "numbers", text: "12", value: '"12"' },
          ];
        return Response.json({
          data: { change_multiple_column_values: value },
        });
      }
      if (q.includes("JarvisCreateUpdate")) {
        expect(v.item).toBe("201");
        expect(v.body).toBe("Updated item 201: Renamed item");
        return Response.json({ data: { create_update: { id: "300" } } });
      }
      return Response.json({ errors: [{ message: "unknown operation" }] });
    },
  });
  mkdirSync(join(dir, "connections"));
  writeFileSync(
    join(dir, "connections/monday.json"),
    JSON.stringify({
      version: 1,
      provider: "monday",
      status: "connected",
      generation: randomUUID(),
      access_token: "ENGINE_ONLY_MONDAY",
      account: {
        id: "789:456",
        label: "Sandbox owner",
      },
      workspaces: [{ id: "workspace1", name: "Jarvis sandbox" }],
      refresh_token: "REFRESH_PRIVATE",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      refresh: {
        url: "https://app.usejarvis.dev/api/integrations/monday/refresh",
        instance_id: randomUUID(),
        secret: "a".repeat(64),
      },
      connected_at: new Date().toISOString(),
    }),
  );
  const resolver = new CredentialResolver();
  resolver.register(
    new JarvisMondayConnectionSource({
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
  const redirect = `const providerFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://api.monday.com'){url.protocol='http:';url.host='127.0.0.1:${provider.port}';return providerFetch(url,init);}return providerFetch(input,init);};\n`;
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
  "actual published Monday metadata, five managed actions and downstream references",
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
    expect(metadata.auth?.type).toBe("SECRET_TEXT");
    if (process.env.MONDAY_CATALOG_FIXTURE)
      writeFileSync(
        process.env.MONDAY_CATALOG_FIXTURE,
        JSON.stringify(metadata),
      );
    const actions = [
      "monday_create_item",
      "monday_get_item_column_values",
      "monday_update_item_name",
      "monday_update_column_values_of_item",
      "monday_create_update",
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
        pieceVersion: "0.4.0",
        actionName,
        input: { auth: "{{connections.jarvis:monday}}", ...input },
      },
      ...(nextAction ? { nextAction } : {}),
    });
    const comment = step("comment", "monday_create_update", {
      board_id: "100",
      item_id: "{{updated.data.change_multiple_column_values.id}}",
      body: "Updated item {{updated.data.change_multiple_column_values.id}}: {{renamed.data.change_multiple_column_values.name}}",
    });
    const updated = step(
      "updated",
      "monday_update_column_values_of_item",
      {
        board_id: "100",
        item_id: "{{renamed.data.change_multiple_column_values.id}}",
        column_values: { number: 12 },
      },
      comment,
    );
    const renamed = step(
      "renamed",
      "monday_update_item_name",
      {
        board_id: "100",
        item_id: "{{created.data.create_item.id}}",
        name: "Renamed item",
      },
      updated,
    );
    const created = step(
      "created",
      "monday_create_item",
      {
        board_id: "100",
        group_id: "topics",
        item_name: "Follow up on {{found.name}}",
        column_values: { text: "Hello" },
      },
      renamed,
    );
    const found = step(
      "found",
      "monday_get_item_column_values",
      { board_id: "100", item_id: "200" },
      created,
    );
    const flow = createFlow(),
      version = createDraftVersion({
        flowId: flow.id,
        displayName: "Monday qualification",
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
    expect(requests).toHaveLength(11);
    expect(requests.every((r) => r.path === "/v2")).toBe(true);
    expect(
      requests.filter((r) => (r.body as any).query.startsWith("mutation")),
    ).toHaveLength(4);
    expect((complete.steps?.comment as any).output.output).toEqual({
      data: { create_update: { id: "300" } },
    });
    expect(
      metadata.actions.monday_create_item!.inputSchema?.fields.find(
        (f) => f.name === "item_name",
      ),
    ).toMatchObject({ type: "string", required: true });
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
      ["found", "monday_get_item_column_values"],
      ["created", "monday_create_item"],
      ["renamed", "monday_update_item_name"],
      ["updated", "monday_update_column_values_of_item"],
      ["comment", "monday_create_update"],
    ])
      matchSample(
        metadata.actions[action!]!.outputSample,
        (complete.steps?.[name!] as any).output.output,
        action!,
      );
    expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_MONDAY");
    expect(JSON.stringify(complete.steps)).not.toContain("REFRESH_PRIVATE");
  },
  90000,
);
