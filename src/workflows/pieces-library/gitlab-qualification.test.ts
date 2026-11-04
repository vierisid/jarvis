/** Published GitLab package through Worker and EngineRuntime. Ungated in the normal suite.
 * Provider HTTP alone is redirected in a disposable engine bundle. No live credentials. */
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
import {
  managedConnectionMisuse,
  CredentialResolver,
} from "../credentials/adapter";
import { JarvisGitLabConnectionSource } from "../credentials/gitlab-source";
import { AuthorityEngine } from "../../authority/engine";
import { ApprovalManager } from "../../authority/approval";
import { AuditTrail } from "../../authority/audit";
import { EmergencyController } from "../../authority/emergency";
import { WorkflowEventBuffer } from "../runtime/event-buffer";
import { buildSandboxServiceBackends } from "../runtime/service-backends";
import { buildPieceCatalog } from "../runtime/piece-catalog";
import { compileWorkflow } from "../runtime/workflow-readiness";
import { resolveGovernedPieceAction } from "../runtime/piece-effects";
import { SandboxApi } from "../sandbox-api/server";
import { workflowLogsBase } from "../sandbox-api/config";
import { buildEngineBundle } from "../runner/engine-runtime/build";
import { EngineRuntime } from "../runner/engine-runtime/engine-runtime";
import { EngineFlowExecutor } from "../runner/engine-runtime/engine-flow-executor";
import { createRunFlowHandler } from "../runner/handler";
import { Worker } from "../queue/worker";

const piece = "@activepieces/piece-gitlab";
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-gitlab-engine-"));
  initWorkflowDb(join(dir, "db.sqlite"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, dependencies: { [piece]: "0.4.2" } }),
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
        if (body.ack) return Response.json({ acknowledged: true });
        expect(body.refreshToken).toBe("ENGINE_ONLY_REFRESH");
        return Response.json({
          access_token: "ENGINE_ONLY_GITLAB",
          refresh_token: "ENGINE_ONLY_ROTATED",
          receipt: "f73b15a1-3e5c-4ecb-941d-ce0921c55e27",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      }
      if (req.headers.get("authorization") !== "Bearer ENGINE_ONLY_GITLAB")
        return Response.json({ error: "unauthorized" }, { status: 401 });
      if (path === "/api/v4/projects/123/issues" && req.method === "POST") {
        expect(body).toEqual({
          title: "Qualification issue",
          description: "Fixture-only details",
        });
        return Response.json(
          {
            id: 1001,
            iid: 7,
            project_id: 123,
            title: body.title,
            description: body.description,
            state: "opened",
            web_url: "https://gitlab.com/example/sandbox/-/issues/7",
          },
          { status: 201 },
        );
      }
      return Response.json({ error: "unknown route" }, { status: 404 });
    },
  });
  mkdirSync(join(dir, "connections"));
  writeFileSync(
    join(dir, "connections/gitlab.json"),
    JSON.stringify({
      version: 1,
      provider: "gitlab",
      status: "connected",
      generation: randomUUID(),
      access_token: "ENGINE_ONLY_GITLAB",
      refresh_token: "ENGINE_ONLY_REFRESH",
      expires_at: new Date(0).toISOString(),
      refresh: {
        url: "https://app.usejarvis.dev/api/integrations/gitlab/refresh",
        instance_id: randomUUID(),
        secret: "a".repeat(64),
      },
      account: { id: "123", label: "Sandbox owner" },
      workspaces: [],
      connected_at: new Date().toISOString(),
    }),
  );
  const resolver = new CredentialResolver();
  resolver.register(
    new JarvisGitLabConnectionSource(
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
  const redirect = `const providerFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://gitlab.com'){url.protocol='http:';url.host='127.0.0.1:${provider.port}';return providerFetch(url,init);}return providerFetch(input,init);};\n`;
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
  await runtime?.shutdown();
  await api?.stop();
  provider?.stop(true);
  closeWorkflowDb();
  if (runId) rmSync(join(workflowLogsBase(), runId + ".bin"), { force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});
test("published GitLab metadata, issue creation, refresh acknowledgement and downstream references", async () => {
  const { catalog, failures } = await buildPieceCatalog({
    runtime,
    pieceRoots: [join(dir, "node_modules/@activepieces")],
    projectId: DEFAULT_IDS.project,
    pieceTimeoutMs: 30000,
    overallTimeoutMs: 45000,
  });
  expect(failures).toEqual([]);
  const metadata = catalog.get(piece)!;
  if (process.env.GITLAB_CATALOG_FIXTURE)
    writeFileSync(process.env.GITLAB_CATALOG_FIXTURE, JSON.stringify(metadata));
  expect(metadata.auth?.type).toBe("OAUTH2");
  expect(Object.keys(metadata.actions).sort()).toEqual([
    "add_issue_spent_time",
    "approve_merge_request",
    "archive_project",
    "cancel_job",
    "cancel_pipeline",
    "create_branch",
    "create_commit",
    "create_commit_comment",
    "create_file",
    "create_group",
    "create_issue",
    "create_issue_note",
    "create_label",
    "create_merge_request",
    "create_merge_request_draft_note",
    "create_milestone",
    "create_pipeline",
    "create_project",
    "create_project_issue",
    "create_project_webhook",
    "custom_api_call",
    "delete_branch",
    "delete_file",
    "delete_group",
    "delete_issue_note",
    "delete_label",
    "delete_merge_request",
    "delete_milestone",
    "delete_pipeline",
    "delete_project",
    "delete_project_webhook",
    "erase_job",
    "fork_project",
    "get_branch",
    "get_commit",
    "get_commit_refs",
    "get_commit_sequence",
    "get_current_user",
    "get_file",
    "get_group",
    "get_group_member",
    "get_issue",
    "get_issue_note",
    "get_issue_time_stats",
    "get_job",
    "get_job_log",
    "get_label",
    "get_merge_request",
    "get_merge_request_approval_state",
    "get_merge_request_approvals",
    "get_milestone",
    "get_pipeline",
    "get_project",
    "get_project_languages",
    "get_project_member",
    "get_project_webhook",
    "get_user",
    "get_user_status",
    "import_project_members",
    "list_branches",
    "list_commit_comments",
    "list_commits",
    "list_group_billable_members",
    "list_group_members",
    "list_group_pending_members",
    "list_group_projects",
    "list_groups",
    "list_issue_notes",
    "list_issues",
    "list_labels",
    "list_merge_request_commits",
    "list_merge_request_diff_versions",
    "list_merge_request_diffs",
    "list_merge_request_discussions",
    "list_merge_request_notes",
    "list_merge_requests",
    "list_milestones",
    "list_pipeline_jobs",
    "list_pipelines",
    "list_project_groups",
    "list_project_invited_groups",
    "list_project_members",
    "list_project_share_locations",
    "list_project_transfer_locations",
    "list_project_users",
    "list_project_webhooks",
    "list_projects",
    "list_repository_tree",
    "list_tags",
    "list_user_projects",
    "list_users",
    "merge_merge_request",
    "move_issue",
    "play_manual_job",
    "protect_branch",
    "reset_issue_spent_time",
    "reset_issue_time_estimate",
    "retry_pipeline",
    "set_issue_time_estimate",
    "set_user_status",
    "share_project_with_group",
    "star_project",
    "unapprove_merge_request",
    "unarchive_project",
    "unprotect_branch",
    "unstar_project",
    "update_file",
    "update_group",
    "update_issue",
    "update_issue_note",
    "update_label",
    "update_merge_request",
    "update_milestone",
    "update_project_webhook",
  ]);
  expect(Object.keys(metadata.triggers ?? {})).toEqual(["project_issue_event"]);
  expect(
    metadata.actions.create_issue?.inputSchema?.fields.map((f) => f.name),
  ).toEqual(["projectId", "title", "description"]);
  const source = new JarvisGitLabConnectionSource({
    daemon: { data_dir: dir },
  } as any);
  for (const name of Object.keys(metadata.actions)) {
    expect(resolveGovernedPieceAction(piece, name)?.known).toBe(true);
    const denied = managedConnectionMisuse(
      source,
      piece,
      "settings.input.auth",
      { actionName: name },
      "PIECE",
    );
    if (name === "create_issue") expect(denied).toBeNull();
    else expect(denied).not.toBeNull();
  }
  if (process.env.GITLAB_CATALOG_FIXTURE)
    writeFileSync(process.env.GITLAB_CATALOG_FIXTURE, JSON.stringify(metadata));
  for (const name of ["create_issue"]) {
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
      pieceVersion: "0.4.2",
      actionName,
      input: { auth: "{{connections.jarvis:gitlab}}", ...input },
    },
    ...(nextAction ? { nextAction } : {}),
  });
  const downstream = {
    name: "inspect",
    type: "CODE",
    settings: {
      input: {
        id: "{{create.id}}",
        iid: "{{create.iid}}",
        project: "{{create.project_id}}",
        url: "{{create.web_url}}",
      },
      sourceCode: {
        code: "export const code=async(inputs)=>inputs;",
        packageJson: "{}",
      },
    },
  };
  const read = step(
    "create",
    "create_issue",
    {
      projectId: "123",
      title: "Qualification issue",
      description: "Fixture-only details",
    },
    downstream,
  );
  const trigger={name:"trigger",type:"EMPTY",nextAction:read};
  const context={pieces:catalog,connection:(_id:string,pieceName:string,path:string,settings:Record<string,unknown>,type:unknown)=>managedConnectionMisuse(source,pieceName,path,settings,type)};
  expect(compileWorkflow(trigger,context).ready).toBe(true);
  const incomplete=structuredClone(trigger);delete (incomplete.nextAction.settings.input as any).projectId;
  expect(compileWorkflow(incomplete,context).ready).toBe(false);
  const flow = createFlow(),
    version = createDraftVersion({
      flowId: flow.id,
      displayName: "GitLab qualification",
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
    "POST /api/v4/projects/123/issues",
  ]);
  const output = (step: string) =>
    (complete.steps?.[step] as any).output.output;
  expect(output("create")).toMatchObject({ id: 1001, iid: 7, project_id: 123 });
  expect(output("inspect")).toEqual({
    id: 1001,
    iid: 7,
    project: 123,
    url: "https://gitlab.com/example/sandbox/-/issues/7",
  });
  expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_ROTATED");
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
  for (const [name, step] of [["create_issue", "create"]])
    sampleTypes(metadata.actions[name!]!.outputSample, output(step!), name!);
  expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_GITLAB");
  expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_REFRESH");
}, 90000);
