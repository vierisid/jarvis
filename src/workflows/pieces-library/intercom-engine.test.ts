/** Actual npm piece in the real engine. Only fetch to its provider host is redirected
 * in a disposable engine copy; no live Intercom calls or account credentials are used.
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
import { JarvisIntercomConnectionSource } from "../credentials/intercom-source";
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
const piece = "@activepieces/piece-intercom";
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
  dir = mkdtempSync(join(tmpdir(), "jarvis-intercom-engine-"));
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
        body = req.method === "GET" || req.method === "DELETE" ? null : (await req.json()) as any;
      requests.push({
        method: req.method,
        path,
        body,
        auth: req.headers.get("authorization"),
      });
      if (req.headers.get("authorization") !== "Bearer ENGINE_ONLY_INTERCOM")
        return Response.json({error:"unauthorized"},{status:401});
      const contact={id:"contact1",type:"contact",email:"contact@example.test",name:"Sandbox"};
      const tag={id:"tag1",type:"tag",name:"Follow up"};
      if(path==="/contacts/contact1")return Response.json(contact);
      if(path==="/contacts/search")return Response.json({data:[contact],total_count:1});
      if(path==="/contacts/contact1/notes")return Response.json({id:"note1",type:"note",body:body.body,contact:{id:"contact1"}});
      if(path==="/tags")return Response.json({type:"list",data:[tag]});
      if(path==="/contacts/contact1/tags" || path==="/contacts/contact1/tags/tag1")return Response.json(tag);
      if(path==="/conversations/conversation1" || path==="/conversations/conversation1/reply")return Response.json({id:"conversation1",type:"conversation",title:"Question",conversation_parts:{conversation_parts:[{id:"part1",part_type:"note",body:body?.body ?? "Existing internal note",author:{type:"admin",id:"admin1",name:"Owner"},created_at:1}]}});
      return Response.json({ error: "unknown route" }, { status: 404 });
    },
  });
  mkdirSync(join(dir, "connections"));
  writeFileSync(
    join(dir, "connections/intercom.json"),
    JSON.stringify({
      version: 1,
      provider: "intercom",
      status: "connected",
      generation: randomUUID(),
      access_token: "ENGINE_ONLY_INTERCOM",
      account: {id:"workspace1:admin1",label:"Sandbox owner"},
      workspaces:[{id:"workspace1",name:"Jarvis sandbox"}],
      settings:{region:"eu",api_host:"api.eu.intercom.io",admin_id:"admin1"},
      connected_at: new Date().toISOString(),
    }),
  );
  const resolver = new CredentialResolver();
  resolver.register(
    new JarvisIntercomConnectionSource(
      {
        daemon: { data_dir: dir },
        usejarvis_integrations: {
          page_url: "https://app.usejarvis.dev/account",
        },
      } as any,
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
  const redirect = `const providerFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin==='https://api.eu.intercom.io'){url.protocol='http:';url.host='127.0.0.1:${provider.port}';return providerFetch(url,init);}return providerFetch(input,init);};\n`;
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
  "catalog extraction and six support actions through actual engine, managed credential and downstream references",
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
    if (process.env.INTERCOM_CATALOG_FIXTURE) writeFileSync(process.env.INTERCOM_CATALOG_FIXTURE,JSON.stringify(metadata));
    for (const name of [
      "get_contact", "get_conversation_by_id", "add_note_to_contact", "add_note_to_conversation_by_id", "list-all-tags", "add-or-remove-tag-on-contact",
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
        input: { auth: "{{connections.jarvis:intercom}}", ...input },
      },
      ...(nextAction ? { nextAction } : {}),
    });
    const untag=step("untag","add-or-remove-tag-on-contact",{contactId:"{{contact.id}}",tagId:"{{tag.id}}",untag:true});
    const tag=step("tag","add-or-remove-tag-on-contact",{contactId:"{{contact.id}}",tagId:"{{tags.data[0].id}}",untag:false},untag);
    const tags=step("tags","list-all-tags",{},tag);
    const conversationNote=step("conversationNote","add_note_to_conversation_by_id",{conversationId:"{{conversation.id}}",body:"{{note.body}}"},tags);
    const note=step("note","add_note_to_contact",{contactId:"{{contact.id}}",body:"{{conversation.parts[0].body}}"},conversationNote);
    const conversation=step("conversation","get_conversation_by_id",{conversationId:"conversation1",plainText:true},note);
    const contact=step("contact","get_contact",{lookupBy:"email",value:"contact@example.test"},conversation);
    const flow = createFlow(),
      version = createDraftVersion({
        flowId: flow.id,
        displayName: "Intercom qualification",
        trigger: { name: "trigger", type: "EMPTY", nextAction: contact },
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
    expect(requests.map(r=>r.method+" "+r.path)).toEqual([
      "POST /contacts/search","GET /conversations/conversation1","POST /contacts/contact1/notes",
      "POST /conversations/conversation1/reply","GET /tags","POST /contacts/contact1/tags","DELETE /contacts/contact1/tags/tag1",
    ]);
    expect((complete.steps?.note as any).output.output).toMatchObject({id:"note1",body:"Existing internal note"});
    expect((complete.steps?.conversationNote as any).output.output).toMatchObject({id:"conversation1",conversation_parts:{conversation_parts:[{body:"Existing internal note"}]}});
    expect((complete.steps?.untag as any).output.output).toMatchObject({id:"tag1"});
    expect(requests[3]?.body).toMatchObject({message_type:"note",type:"admin",admin_id:"admin1"});
    expect(JSON.stringify(complete.steps)).not.toContain("ENGINE_ONLY_INTERCOM");
  },
  90000,
);
