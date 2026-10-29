/** Actual npm piece in the real engine. Only fetch to its provider host is redirected
 * in a disposable engine copy; no live Linear calls or account credentials are used.
 * Gated on JARVIS_TEST_ENGINE_BUILD=1 like the other engine tests; CI runs it
 * in test.yml's engine step. It installs the pinned 0.9.1 from npm. */
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
import { JarvisLinearConnectionSource } from "../credentials/linear-source";
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
const piece = "@activepieces/piece-linear";
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-linear-engine-"));
  initWorkflowDb(join(dir, "db.sqlite"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, dependencies: { [piece]: "0.9.1" } }),
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
      if (req.headers.get("authorization") !== "Bearer ENGINE_ONLY_LINEAR")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      const issue = {
        id: "11111111-1111-4111-8111-111111111111",
        identifier: "ENG-1",
        title: "Qualification issue",
        description: "Sandbox",
        url: "https://linear.app/jarvis/issue/ENG-1",
        priority: 2,
        team: {
          id: "22222222-2222-4222-8222-222222222222",
          name: "Engineering",
          key: "ENG",
        },
        createdAt: "2026-10-29T10:00:00Z",
        updatedAt: "2026-10-29T10:00:00Z",
      };
      if (path === "/graphql") {
        const { query, variables } = body;
        if (query.includes("JarvisSearchIssues"))
          return Response.json({
            data: {
              searchIssues: {
                nodes: [issue],
                totalCount: 2,
                pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
              },
            },
          });
        if (query.includes("JarvisGetIssue")) {
          expect([issue.id, issue.identifier]).toContain(variables.id);
          return Response.json({ data: { issue } });
        }
        if (query.includes("JarvisCreateIssue")) {
          expect(variables.input.teamId).toBe(issue.team.id);
          expect(variables.input.title).toBe("Qualification issue");
          return Response.json({
            data: { issueCreate: { success: true, lastSyncId: 1, issue } },
          });
        }
        if (query.includes("JarvisUpdateIssue")) {
          expect(variables.id).toBe(issue.id);
          expect(variables.input.title).toBe("Updated issue");
          return Response.json({
            data: {
              issueUpdate: {
                success: true,
                lastSyncId: 2,
                issue: { ...issue, title: "Updated issue" },
              },
            },
          });
        }
        if (query.includes("JarvisCreateComment")) {
          expect(variables.input.issueId).toBe(issue.id);
          expect(variables.input.body).toBe("Reviewed ENG-1");
          return Response.json({
            data: {
              commentCreate: {
                success: true,
                lastSyncId: 3,
                comment: {
                  id: "33333333-3333-4333-8333-333333333333",
                  body: variables.input.body,
                  url: issue.url + "#comment",
                  createdAt: issue.createdAt,
                  updatedAt: issue.updatedAt,
                },
              },
            },
          });
        }
      }
      return Response.json({ error: "unknown route" }, { status: 404 });
    },
  });
  mkdirSync(join(dir, "connections"));
  writeFileSync(
    join(dir, "connections/linear.json"),
    JSON.stringify({
      version: 1,
      provider: "linear",
      status: "connected",
      generation: randomUUID(),
      access_token: "ENGINE_ONLY_LINEAR",
      account: {
        id: "44444444-4444-4444-8444-444444444444",
        label: "Sandbox owner",
      },
      workspaces: [{ id: "workspace1", name: "Jarvis sandbox" }],
      refresh_token: "REFRESH_PRIVATE",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      refresh: {
        url: "https://app.usejarvis.dev/api/integrations/linear/refresh",
        instance_id: randomUUID(),
        secret: "a".repeat(64),
      },
      connected_at: new Date().toISOString(),
    }),
  );
  const resolver = new CredentialResolver();
  resolver.register(
    new JarvisLinearConnectionSource({
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
  const redirect = `const providerFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://api.linear.app'){url.protocol='http:';url.host='127.0.0.1:${provider.port}';return providerFetch(url,init);}return providerFetch(input,init);};\n`;
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
    if (process.env.LINEAR_CATALOG_FIXTURE)
      writeFileSync(
        process.env.LINEAR_CATALOG_FIXTURE,
        JSON.stringify(metadata),
      );
    for (const name of [
      "linear_get_issue",
      "linear_search_issues",
      "linear_create_issue",
      "linear_update_issue",
      "linear_create_comment",
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
        pieceVersion: "0.9.1",
        actionName,
        input: { auth: "{{connections.jarvis:linear}}", ...input },
      },
      ...(nextAction ? { nextAction } : {}),
    });
    const team = "22222222-2222-4222-8222-222222222222";
    const comment = step("comment", "linear_create_comment", {
      team_id: team,
      issue_id: "{{updated.issue.id}}",
      body: "Reviewed {{found.identifier}}",
    });
    const update = step(
      "updated",
      "linear_update_issue",
      {
        team_id: team,
        issue_id: "{{created.issue.id}}",
        title: "Updated issue",
      },
      comment,
    );
    const create = step(
      "created",
      "linear_create_issue",
      { team_id: team, title: "Qualification issue" },
      update,
    );
    const get = step(
      "found",
      "linear_get_issue",
      { issue_id: "{{search.items[0].identifier}}" },
      create,
    );
    const search = step(
      "search",
      "linear_search_issues",
      { term: "Qualification", team_id: team },
      get,
    );
    const flow = createFlow(),
      version = createDraftVersion({
        flowId: flow.id,
        displayName: "Linear qualification",
        trigger: { name: "trigger", type: "EMPTY", nextAction: search },
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
    expect(requests.length).toBe(7);
    expect(
      requests.every((r) => r.path === "/graphql" && r.method === "POST"),
    ).toBe(true);
    expect((complete.steps?.comment as any).output.output).toMatchObject({
      success: true,
      comment: { body: "Reviewed ENG-1" },
    });
    expect((complete.steps?.updated as any).output.output).toMatchObject({
      success: true,
      issue: { title: "Updated issue" },
    });
    const required =
      metadata.actions.linear_create_issue!.inputSchema?.fields.find(
        (f) => f.name === "title",
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
      ["search", "linear_search_issues"],
      ["found", "linear_get_issue"],
      ["created", "linear_create_issue"],
      ["updated", "linear_update_issue"],
      ["comment", "linear_create_comment"],
    ])
      matchSample(
        metadata.actions[action!]!.outputSample,
        (complete.steps?.[name!] as any).output.output,
        action!,
      );
    expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_LINEAR");
  },
  90000,
);
