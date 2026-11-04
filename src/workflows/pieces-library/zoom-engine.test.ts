/** Published Zoom package through Worker and EngineRuntime. Provider HTTP alone
 * is redirected in a disposable engine bundle; no live credentials.
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
import { JarvisZoomConnectionSource } from "../credentials/zoom-source";
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
const piece = "@activepieces/piece-zoom";
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-zoom-engine-"));
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
    throw new Error("bun install failed: " + install.stderr);
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
          access_token: "ENGINE_ONLY_ZOOM",
          refresh_token: "ENGINE_ONLY_ROTATED",
          receipt: "f73b15a1-3e5c-4ecb-941d-ce0921c55e27",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      }
      if (req.headers.get("authorization") !== "Bearer ENGINE_ONLY_ZOOM")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      const meeting = {
        id: 12345678901,
        topic: "Sandbox meeting",
        type: 2,
        host_id: "zoom-user",
        start_time: "2030-06-01T14:00:00Z",
        duration: 30,
        timezone: "UTC",
        agenda: "Example agenda",
        join_url: "https://zoom.us/j/12345678901?pwd=participant",
        start_url: "https://zoom.us/s/12345678901?zak=HOST_ONLY_SECRET",
        password: "HOST_ONLY_PASSCODE",
      };
      if (path === "/v2/users/me/meetings" && req.method === "POST") {
        expect(body).toMatchObject({
          topic: "Sandbox meeting",
          type: 2,
          default_password: true,
          settings: {
            waiting_room: true,
            auto_recording: "none",
            use_pmi: false,
          },
        });
        return Response.json(meeting, { status: 201 });
      }
      if (path === "/v2/meetings/12345678901") {
        if (req.method === "PATCH") {
          expect(body).toEqual({ topic: "Sandbox meeting" });
          return new Response(null, { status: 204 });
        }
        return Response.json(meeting);
      }
      return Response.json({ error: "unknown route" }, { status: 404 });
    },
  });
  mkdirSync(join(dir, "connections"));
  writeFileSync(
    join(dir, "connections/zoom.json"),
    JSON.stringify({
      version: 1,
      provider: "zoom",
      status: "connected",
      generation: randomUUID(),
      access_token: "ENGINE_ONLY_ZOOM",
      refresh_token: "ENGINE_ONLY_REFRESH",
      expires_at: new Date(0).toISOString(),
      refresh: {
        url: "https://app.usejarvis.dev/api/integrations/zoom/refresh",
        instance_id: randomUUID(),
        secret: "a".repeat(64),
      },
      account: { id: "zoom-user", label: "Sandbox owner" },
      workspaces: [],
      connected_at: new Date().toISOString(),
    }),
  );
  const resolver = new CredentialResolver();
  resolver.register(
    new JarvisZoomConnectionSource(
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
  const redirect = `const providerFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://api.zoom.us'){url.protocol='http:';url.host='127.0.0.1:${provider.port}';return providerFetch(url,init);}return providerFetch(input,init);};\n`;
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
test.skipIf(!gate)("published Zoom metadata, all five managed actions, refresh acknowledgement and downstream references", async () => {
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
    "zoom_create_meeting",
    "zoom_create_meeting_registrant",
    "zoom_delete_meeting",
    "zoom_find_meeting",
    "zoom_get_current_user",
    "zoom_get_meeting",
    "zoom_list_meetings",
    "zoom_list_past_meeting_instances",
    "zoom_list_recordings",
    "zoom_update_meeting",
    "zoom_update_meeting_by_id",
  ]);
  for (const name of Object.keys(metadata.actions))
    expect(resolveGovernedPieceAction(piece, name)?.known).toBe(true);
  if (process.env.ZOOM_CATALOG_FIXTURE)
    writeFileSync(process.env.ZOOM_CATALOG_FIXTURE, JSON.stringify(metadata));
  for (const name of [
    "zoom_create_meeting",
    "zoom_find_meeting",
    "zoom_get_meeting",
    "zoom_update_meeting",
    "zoom_update_meeting_by_id",
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
      input: { auth: "{{connections.jarvis:zoom}}", ...input },
    },
    ...(nextAction ? { nextAction } : {}),
  });
  const final = step("final", "zoom_get_meeting", {
    meeting_id: "{{updateById.meeting_id}}",
  });
  const updateById = step(
    "updateById",
    "zoom_update_meeting_by_id",
    { meeting_id: "{{update.meeting_id}}", topic: "{{find.topic}}" },
    final,
  );
  const update = step(
    "update",
    "zoom_update_meeting",
    { meeting_id: "{{find.id}}", topic: "{{find.topic}}" },
    updateById,
  );
  const find = step(
    "find",
    "zoom_find_meeting",
    { meeting_id: "{{create.id}}" },
    update,
  );
  const read = step(
    "create",
    "zoom_create_meeting",
    { topic: "Sandbox meeting", start_time: "2030-06-01T14:00:00Z" },
    find,
  );
  const flow = createFlow(),
    version = createDraftVersion({
      flowId: flow.id,
      displayName: "Zoom qualification",
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
    "POST /v2/users/me/meetings",
    "GET /v2/meetings/12345678901",
    "GET /v2/meetings/12345678901",
    "PATCH /v2/meetings/12345678901",
    "GET /v2/meetings/12345678901",
    "PATCH /v2/meetings/12345678901",
    "GET /v2/meetings/12345678901",
  ]);
  const output = (step: string) =>
    (complete.steps?.[step] as any).output.output;
  expect(output("final").id).toBe(12345678901);
  expect(output("final").topic).toBe("Sandbox meeting");
  for (const secret of [
    "ENGINE_ONLY_ROTATED",
    "HOST_ONLY_SECRET",
    "HOST_ONLY_PASSCODE",
  ])
    expect(JSON.stringify(complete.steps)).not.toContain(secret);
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
    ["zoom_create_meeting", "create"],
    ["zoom_find_meeting", "find"],
    ["zoom_update_meeting", "update"],
    ["zoom_update_meeting_by_id", "updateById"],
    ["zoom_get_meeting", "final"],
  ])
    sampleTypes(metadata.actions[name!]!.outputSample, output(step!), name!);
  expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_ZOOM");
  expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_REFRESH");
}, 90000);
