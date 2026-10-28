/** Actual npm piece in the real engine. Only fetch to its provider host is redirected
 * in a disposable engine copy; no live Calendly calls or account credentials are used.
 * Gated on JARVIS_TEST_ENGINE_BUILD=1 like the other engine tests; CI runs it
 * in test.yml's engine step. It installs the pinned 0.7.1 from npm. */
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
import { JarvisCalendlyConnectionSource } from "../credentials/calendly-source";
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
const piece = "@activepieces/piece-calendly";
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-calendly-engine-"));
  initWorkflowDb(join(dir, "db.sqlite"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, dependencies: { [piece]: "0.7.1" } }),
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
      if (req.headers.get("authorization") !== "Bearer ENGINE_ONLY_CALENDLY")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      const event = {
        uri: "https://api.calendly.com/scheduled_events/e1",
        name: "Introduction",
        status: "active",
        start_time: "2026-10-28T10:00:00Z",
        end_time: "2026-10-28T10:30:00Z",
        event_type: "https://api.calendly.com/event_types/t1",
      };
      const page = (items: unknown[]) =>
        Response.json({
          collection: items,
          pagination: { count: items.length, next_page_token: "cursor-2" },
        });
      if (path === "/event_types")
        return page([
          {
            uri: event.event_type,
            name: "Introduction",
            active: true,
            duration: 30,
            scheduling_url: "https://calendly.com/sandbox/introduction",
          },
        ]);
      if (path === "/scheduling_links") {
        expect(body).toEqual({
          max_event_count: 1,
          owner: event.event_type,
          owner_type: "EventType",
        });
        return Response.json({
          resource: {
            booking_url: "https://calendly.com/d/sandbox/link",
            owner: event.event_type,
            owner_type: "EventType",
          },
        });
      }
      if (path === "/scheduled_events") {
        expect(new URL(req.url).searchParams.get("user")).toBe(
          "https://api.calendly.com/users/u1",
        );
        return page([event]);
      }
      if (path === "/scheduled_events/e1")
        return Response.json({ resource: event });
      if (path === "/scheduled_events/e1/invitees")
        return page([
          {
            uri: event.uri + "/invitees/i1",
            name: "Alex",
            email: "alex@example.test",
            status: "active",
            event: event.uri,
          },
        ]);
      return Response.json({ error: "unknown route" }, { status: 404 });
    },
  });
  mkdirSync(join(dir, "connections"));
  writeFileSync(
    join(dir, "connections/calendly.json"),
    JSON.stringify({
      version: 1,
      provider: "calendly",
      status: "connected",
      generation: randomUUID(),
      access_token: "ENGINE_ONLY_CALENDLY",
      account: { id: "u1", label: "Sandbox owner" },
      workspaces: [{ id: "workspace1", name: "Jarvis sandbox" }],
      refresh_token: "REFRESH_PRIVATE",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      refresh: {
        url: "https://app.usejarvis.dev/api/integrations/calendly/refresh",
        instance_id: randomUUID(),
        secret: "a".repeat(64),
      },
      connected_at: new Date().toISOString(),
    }),
  );
  const resolver = new CredentialResolver();
  resolver.register(
    new JarvisCalendlyConnectionSource({
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
  const redirect = `const providerFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://api.calendly.com'){url.protocol='http:';url.host='127.0.0.1:${provider.port}';return providerFetch(url,init);}return providerFetch(input,init);};\n`;
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
  "catalog extraction and five actions through actual engine, managed credential and downstream references",
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
    if (process.env.CALENDLY_CATALOG_FIXTURE)
      writeFileSync(
        process.env.CALENDLY_CATALOG_FIXTURE,
        JSON.stringify(metadata),
      );
    for (const name of [
      "list_event_types",
      "create_scheduling_link",
      "list_scheduled_events",
      "get_scheduled_event",
      "list_event_invitees",
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
        pieceVersion: "0.7.1",
        actionName,
        input: { auth: "{{connections.jarvis:calendly}}", ...input },
      },
      ...(nextAction ? { nextAction } : {}),
    });
    const invitees = step("invitees", "list_event_invitees", {
      scheduledEvent: "{{event.uri}}",
    });
    const event = step(
      "event",
      "get_scheduled_event",
      { scheduledEvent: "{{events.items[0].uri}}" },
      invitees,
    );
    const events = step("events", "list_scheduled_events", {}, event);
    const link = step(
      "link",
      "create_scheduling_link",
      { eventType: "{{types.items[0].uri}}" },
      events,
    );
    const types = step("types", "list_event_types", {}, link);
    const flow = createFlow(),
      version = createDraftVersion({
        flowId: flow.id,
        displayName: "Calendly qualification",
        trigger: { name: "trigger", type: "EMPTY", nextAction: types },
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
      "GET /event_types",
      "POST /scheduling_links",
      "GET /scheduled_events",
      "GET /scheduled_events/e1",
      "GET /scheduled_events/e1/invitees",
    ]);
    expect((complete.steps?.invitees as any).output.output).toMatchObject({
      items: [{ email: "alex@example.test" }],
    });
    expect((complete.steps?.link as any).output.output).toMatchObject({
      booking_url: "https://calendly.com/d/sandbox/link",
    });
    const required =
      metadata.actions.create_scheduling_link!.inputSchema?.fields.find(
        (f) => f.name === "eventType",
      );
    expect(required).toMatchObject({ type: "string", required: true });
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
      ["types", "list_event_types"],
      ["link", "create_scheduling_link"],
      ["events", "list_scheduled_events"],
      ["event", "get_scheduled_event"],
      ["invitees", "list_event_invitees"],
    ])
      matchSample(
        metadata.actions[action!]!.outputSample,
        (complete.steps?.[name!] as any).output.output,
        action!,
      );
    expect(JSON.stringify(complete.steps)).not.toContain(
      "ENGINE_ONLY_CALENDLY",
    );
  },
  90000,
);
