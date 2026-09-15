// Activates when A1 (#459) lands. This branch remains based on main; run this
// file in the combined integration checkout to verify A1's actual receipts.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkflowDb, closeWorkflowDb } from "../db";
import { createFlow } from "../db/repos/flow";
import { createDraftVersion } from "../db/repos/flow-version";
import { createFlowRun, getFlowRun } from "../db/repos/flow-run";
import { cancelFlowRun } from "../db/repos/run-cancellation";
import { ToolRegistry } from "../../actions/tools/registry";
import { AuthorityEngine } from "../../authority/engine";
import { AuditTrail } from "../../authority/audit";
import { EmergencyController } from "../../authority/emergency";
import { ApprovalManager } from "../../authority/approval";
import { CredentialResolver } from "../credentials/adapter";
import { WorkflowEventBuffer } from "./event-buffer";
import { buildSandboxServiceBackends, type BuildServiceBackendsOptions } from "./service-backends";

const effectsPath = join(import.meta.dir, "../db/repos/workflow-effect.ts");
const schedulerPath = join(import.meta.dir, "effect-approval-scheduler.ts");
const a1Test = test.skipIf(!existsSync(effectsPath));
beforeEach(() => { initWorkflowDb(":memory:"); });
afterEach(() => { closeWorkflowDb(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

function fixture(route: "tool" | "notify", effect: () => Promise<unknown>) {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: "Cancellation + Authority", trigger: {
    name: "trigger", type: "EMPTY", nextAction: { name: "action", type: "PIECE", settings: {
      pieceName: `@jarvispieces/piece-jarvis-${route}`, pieceVersion: "0.0.1",
      actionName: route === "tool" ? "invoke" : "notify", input: {},
    } },
  } });
  const run = createFlowRun({ flowId: flow.id, flowVersionId: version.id, status: "RUNNING" });
  const registry = new ToolRegistry();
  registry.register({ name: "write_file", description: "Synthetic remote effect", category: "file-ops", parameters: {}, execute: effect });
  const authority = new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
    learning: { enabled: false, suggest_threshold: 10 }, emergency_state: "normal" });
  const approvals = new ApprovalManager();
  const backends = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(),
    llmManager: {}, wsService: {}, eventBuffer: new WorkflowEventBuffer(), toolRegistry: registry,
    authorityEngine: authority, emergencyController: new EmergencyController(), auditTrail: new AuditTrail(),
    approvalManager: approvals, onWorkflowApproval: () => {},
    channelService: { getChannelStatus: () => ({ telegram: true, discord: true }), getBroadcastRecipient: () => "recipient",
      sendWorkflowNotification: effect },
  } as unknown as BuildServiceBackendsOptions);
  const context = { runId: run.id, projectId: run.projectId, stepName: "action", executionPath: [] };
  const invoke = () => route === "tool"
    ? backends.toolsInvoke!({ toolName: "write_file", params: { path: "/tmp/synthetic", content: "hello" } }, context)
    : backends.notify!({ message: "test", channels: ["telegram", "discord"], priority: "normal" }, context);
  return { run, invoke, approvals, authority };
}

a1Test("A1 preserves a committed effect receipt after cancellation and restart", async () => {
  const { listWorkflowEffects } = await import(effectsPath);
  const dir = mkdtempSync(join(tmpdir(), "jarvis-cancel-a1-"));
  closeWorkflowDb();
  try {
    const dbPath = join(dir, "workflow.db");
    initWorkflowDb(dbPath);
    const started = deferred(), finish = deferred();
    let calls = 0;
    const f = fixture("tool", async () => { calls++; started.resolve(); await finish.promise; return { remoteId: "committed-receipt" }; });
    const result = f.invoke();
    await started.promise;
    expect(listWorkflowEffects(f.run.id)[0].status).toBe("dispatching");
    cancelFlowRun(f.run.id);
    finish.resolve();
    await result;
    closeWorkflowDb(); initWorkflowDb(dbPath);
    expect(getFlowRun(f.run.id)?.status).toBe("STOPPED");
    expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: "succeeded", result: { remoteId: "committed-receipt" } });
    await expect(f.invoke()).rejects.toThrow("canceled");
    expect(calls).toBe(1);
  } finally { closeWorkflowDb(); rmSync(dir, { recursive: true, force: true }); }
});

a1Test("A1 notification receipt keeps a delivered channel when cancellation prevents later channels", async () => {
  const { listWorkflowEffects } = await import(effectsPath);
  const started = deferred(), finish = deferred();
  let calls = 0;
  const f = fixture("notify", async () => { calls++; started.resolve(); await finish.promise; });
  const result = f.invoke();
  await started.promise;
  cancelFlowRun(f.run.id); finish.resolve();
  const report = await result;
  expect(report).toMatchObject({ delivered: ["telegram"], failed: [{ channel: "discord" }] });
  expect(listWorkflowEffects(f.run.id)[0]).toMatchObject({ status: "succeeded", result: report });
  expect(calls).toBe(1);
});

a1Test("A1 approval granted after cancellation cannot resume or dispatch the effect", async () => {
  const { resumeResolvedWorkflowEffects } = await import(schedulerPath);
  let calls = 0;
  const f = fixture("tool", async () => { calls++; });
  f.authority.setGovernedCategories(["write_data"]);
  const reply = await f.invoke() as unknown as { approval: { approvalId: string } };
  expect(reply.approval).toBeDefined();
  cancelFlowRun(f.run.id);
  f.approvals.approve(reply.approval.approvalId, "test-user");
  expect(resumeResolvedWorkflowEffects()).toBe(0);
  await expect(f.invoke()).rejects.toThrow("canceled");
  expect(calls).toBe(0);
  expect(getFlowRun(f.run.id)?.status).toBe("STOPPED");
});
