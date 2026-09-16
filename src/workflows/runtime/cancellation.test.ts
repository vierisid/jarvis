import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb, getWorkflowDb } from "../db/index";
import { createFlow } from "../db/repos/flow";
import { createDraftVersion } from "../db/repos/flow-version";
import { createFlowRun, getFlowRun, updateRun } from "../db/repos/flow-run";
import { enqueue, getJob, cancelJob, recoverOrphanedJobs } from "../db/repos/job-queue";
import { createWorkflowRoutes } from "../api/routes";
import { createRunFlowHandler, type FlowExecutor } from "../runner/handler";
import { Worker } from "../queue/worker";
import { ToolRegistry } from "../../actions/tools/registry";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelFlowRun, getRunCancellation } from "../db/repos/run-cancellation";
import { withRunCancellation } from "./cancellation";
import { JarvisNotifierAdapter } from "../adapters/notifier";
import { routePerChannel } from "../../daemon/channel-service";
import { createWaitpoint } from "../db/repos/waitpoint";
import { runSubAgent, type RunSubAgentOptions } from "../../agents/sub-agent-runner";
import { SandboxApi } from "../sandbox-api/server";
import { SandboxRegistry } from "../sandbox-api/sandbox-registry";
import { CredentialResolver } from "../credentials/adapter";

beforeEach(() => initWorkflowDb(":memory:"));
afterEach(() => closeWorkflowDb());

function fixture(status: "QUEUED" | "RUNNING" | "PAUSED" | "SUCCEEDED" = "QUEUED") {
  const flow = createFlow();
  const version = createDraftVersion({ flowId: flow.id, displayName: "cancel regression" });
  return createFlowRun({ flowId: flow.id, flowVersionId: version.id, status });
}

async function cancel(runId: string) {
  const req = Object.assign(new Request(`http://local/api/workflow-runs/${runId}/cancel`, { method: "POST" }), { params: { runId } });
  const response = await createWorkflowRoutes()["/api/workflow-runs/:runId/cancel"]!.POST!(req);
  expect(response.status).toBe(200);
  return response.json();
}

async function deleteWorkflow(flowId: string, runId: string) {
  const req = Object.assign(new Request(`http://local/api/workflows/${flowId}`, { method: "DELETE" }), { params: { id: flowId } });
  const response = await createWorkflowRoutes()["/api/workflows/:id"]!.DELETE!(req);
  expect(response.status).toBe(200);
  expect(getFlowRun(runId)).toBeNull();
  // The foreign-key cascade removes the marker too, while daemon callbacks
  // that started before deletion may still be awaiting remote replies.
  expect(getRunCancellation(runId)).toBeNull();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

test("acknowledged cancellation prevents the next tool and preserves a completed step", async () => {
  const run = fixture();
  const job = enqueue({ jobType: "RUN_FLOW", payload: { runId: run.id }, flowRunId: run.id });
  const firstDone = deferred(), proceed = deferred();
  const registry = new ToolRegistry();
  let effects = 0;
  registry.register({ name: "effect", description: "fake effect", category: "test", parameters: {}, execute: async () => ++effects });
  const executor: FlowExecutor = { async execute() {
    const receipt = await registry.execute("effect", {});
    updateRun(run.id, { steps: { first: { output: receipt } }, stepsCount: 1 });
    firstDone.resolve();
    await proceed.promise;
    await registry.execute("effect", {});
    return { steps: {}, stepsCount: 0 };
  } };
  const logs: string[] = [];
  const worker = new Worker({ handlers: { RUN_FLOW: createRunFlowHandler({ executor }) }, log: line => logs.push(line) });
  const draining = worker.drain();
  await firstDone.promise;
  const ack = await cancel(run.id);
  proceed.resolve();
  await draining;
  expect(effects).toBe(1);
  expect(ack.accepted).toBe(true);
  expect(ack.cancellation.inFlightMayHaveCompleted).toBe(true);
  expect(getJob(job.id)?.status).toBe("CANCELED");
  expect(getFlowRun(run.id)).toMatchObject({ status: "STOPPED", steps: { first: { output: 1 } } });
  expect(logs.filter(line => /errored|requeued/.test(line))).toEqual([]);
});

test("deleting a workflow mid-run stops it without a spurious failure or retry", async () => {
  const run = fixture();
  const job = enqueue({ jobType: "RUN_FLOW", payload: { runId: run.id }, flowRunId: run.id, maxAttempts: 3 });
  const started = deferred(), proceed = deferred();
  const registry = new ToolRegistry();
  let effects = 0;
  registry.register({ name: "effect", description: "fake effect", category: "test", parameters: {}, execute: async () => ++effects });
  const executor: FlowExecutor = { async execute() {
    started.resolve();
    await proceed.promise;
    await registry.execute("effect", {});
    return { steps: {}, stepsCount: 0 };
  } };
  const logs: string[] = [];
  const draining = new Worker({ handlers: { RUN_FLOW: createRunFlowHandler({ executor }) }, log: line => logs.push(line) }).drain();
  await started.promise;
  await deleteWorkflow(run.flowId, run.id);
  proceed.resolve();
  await draining;
  expect(effects).toBe(0);
  // The queue retires the stale job instead of failing and retrying it.
  expect(getJob(job.id)?.status).toBe("SUCCEEDED");
  expect(logs.filter(line => /failed|requeued/.test(line))).toEqual([]);
});

test("late success cannot replace cancellation, but its committed output is retained", async () => {
  const run = fixture();
  const job = enqueue({ jobType: "RUN_FLOW", payload: { runId: run.id }, flowRunId: run.id });
  const started = deferred(), committed = deferred();
  const executor: FlowExecutor = { async execute() {
    started.resolve();
    await committed.promise;
    return { steps: { sent: { output: { remoteId: "receipt-1" } } }, stepsCount: 1 };
  } };
  const draining = new Worker({ handlers: { RUN_FLOW: createRunFlowHandler({ executor }) }, log: () => {} }).drain();
  await started.promise;
  await cancel(run.id);
  committed.resolve();
  await draining;
  expect(getFlowRun(run.id)).toMatchObject({ status: "STOPPED", steps: { sent: { output: { remoteId: "receipt-1" } } } });
  expect(getJob(job.id)?.status).toBe("CANCELED");
});

test("cancel stops a paused run without a job, and is idempotent", async () => {
  const run = fixture("PAUSED");
  const first = await cancel(run.id);
  const second = await cancel(run.id);
  expect(getFlowRun(run.id)?.status).toBe("STOPPED");
  expect(second.cancellation).toEqual(first.cancellation);
  expect(first.accepted).toBe(true);
});

test("a completed run keeps its outcome and its queue completion", async () => {
  const run = fixture("SUCCEEDED");
  const job = enqueue({ jobType: "RUN_FLOW", payload: { runId: run.id }, flowRunId: run.id });
  const result = await cancel(run.id);
  expect(result.accepted).toBe(false);
  expect(getFlowRun(run.id)?.status).toBe("SUCCEEDED");
  expect(getJob(job.id)?.status).toBe("QUEUED");
});

test("cancelJob cancels all jobs for the run, including legacy payload identities", () => {
  const run = fixture();
  const first = enqueue({ jobType: "RUN_FLOW", payload: { runId: run.id }, flowRunId: run.id });
  const second = enqueue({ jobType: "RUN_FLOW", payload: { runId: run.id, executionType: "RESUME" } });
  cancelJob(first.id);
  recoverOrphanedJobs();
  expect(getFlowRun(run.id)?.status).toBe("STOPPED");
  expect(getJob(second.id)?.status).toBe("CANCELED");
});

test("cancellation survives database reopen and rejects BEGIN, RESUME and new waitpoints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-cancel-"));
  closeWorkflowDb();
  try {
    const path = join(dir, "workflow.db");
    initWorkflowDb(path);
    const run = fixture("PAUSED");
    const ack = await cancel(run.id);
    closeWorkflowDb();
    initWorkflowDb(path);
    recoverOrphanedJobs();
    expect(getRunCancellation(run.id)).toEqual(ack.cancellation);
    expect(getFlowRun(run.id)?.status).toBe("STOPPED");
    for (const executionType of ["BEGIN", "RESUME"]) {
      expect(() => enqueue({ jobType: "RUN_FLOW", payload: { runId: run.id, executionType } })).toThrow("canceled");
    }
    expect(() => createWaitpoint({ flowRunId: run.id, projectId: run.projectId, stepName: "wait", type: "MANUAL" })).toThrow("canceled");
    updateRun(run.id, { status: "SUCCEEDED", steps: { first: { output: "late receipt" } } });
    expect(getFlowRun(run.id)).toMatchObject({ status: "STOPPED", steps: { first: { output: "late receipt" } } });
  } finally {
    closeWorkflowDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the handler propagates an abort signal to the active executor", async () => {
  const run = fixture();
  const job = enqueue({ jobType: "RUN_FLOW", payload: { runId: run.id } });
  const started = deferred();
  let aborted = false;
  const executor: FlowExecutor = { async execute(ctx) {
    const stopped = new Promise<void>(resolve => ctx.signal!.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    started.resolve();
    await stopped;
    ctx.signal!.throwIfAborted();
    return { steps: {}, stepsCount: 0 };
  } };
  const draining = new Worker({ handlers: { RUN_FLOW: createRunFlowHandler({ executor }) }, log: () => {} }).drain();
  await started.promise;
  cancelJob(job.id);
  expect(aborted).toBe(true);
  await draining;
  expect(getFlowRun(run.id)?.status).toBe("STOPPED");
});

test.each([false, true])("notification fanout preserves cancellation and delivery report (delete after cancel: %s)", async (deleteAfterCancel) => {
  const run = fixture("RUNNING");
  const entered = deferred(), delivered = deferred();
  const sends: string[] = [];
  const notifier = new JarvisNotifierAdapter({
    broadcastToDashboard: () => { sends.push("dashboard"); },
    broadcastToChannels: (channels, text) => routePerChannel(channels, text, {
      getLastRecipient: () => "recipient",
      getAdapter: name => ({ name, isConnected: () => true, async sendMessage() {
        sends.push(name); entered.resolve(); await delivered.promise;
      } }) as never,
    }),
    sendDesktop: async () => { sends.push("desktop"); },
  });
  const notification = withRunCancellation(run.id, () => notifier.notify({ message: "test", channels: ["telegram", "discord", "desktop"] }));
  await entered.promise;
  cancelFlowRun(run.id);
  if (deleteAfterCancel) await deleteWorkflow(run.flowId, run.id);
  delivered.resolve();
  const result = await notification;
  expect(sends).toEqual(["telegram"]);
  expect(result.delivered).toEqual(["telegram"]);
  expect(result.failed.map(f => f.channel)).toEqual(["discord", "desktop"]);
  expect(result.failed.every(f => /canceled/.test(f.error))).toBe(true);
});

test("canceling one workflow does not block another workflow or ordinary chat tools", async () => {
  const canceled = fixture("RUNNING"), other = fixture("RUNNING");
  const tools = new ToolRegistry();
  let calls = 0;
  tools.register({ name: "effect", description: "synthetic", category: "test", parameters: {}, execute: async () => ++calls });
  cancelFlowRun(canceled.id);
  await expect(withRunCancellation(canceled.id, () => tools.execute("effect", {}))).rejects.toThrow("canceled");
  await withRunCancellation(other.id, () => tools.execute("effect", {}));
  await tools.execute("effect", {});
  expect(calls).toBe(2);
});

test("startup recovers legacy canceled jobs without choking on unrelated corrupt payloads", () => {
  const run = fixture("RUNNING");
  const canceled = enqueue({ jobType: "RUN_FLOW", payload: { runId: run.id } });
  const malformed = enqueue({ jobType: "RUN_FLOW", payload: {} });
  getWorkflowDb().run("UPDATE workflow_job SET payload = '{', status = 'CANCELED' WHERE id = ?", [malformed.id]);
  getWorkflowDb().run("UPDATE workflow_job SET status = 'CANCELED' WHERE id = ?", [canceled.id]);
  recoverOrphanedJobs();
  expect(getFlowRun(run.id)?.status).toBe("STOPPED");
  expect(getRunCancellation(run.id)?.inFlightMayHaveCompleted).toBe(true);
});

test("cancellation during webhook body parsing wins over resume", async () => {
  const run = fixture("PAUSED");
  const wp = createWaitpoint({ flowRunId: run.id, projectId: run.projectId, stepName: "wait", type: "WEBHOOK" });
  const entered = deferred(), body = deferred();
  // The route reads the body as text so it can cap the raw size before
  // parsing; json() delegates to the same stall so this stays a body-read
  // hold whichever one the handler reaches for.
  const stalledBody = async () => { entered.resolve(); await body.promise; return "{}"; };
  const req = Object.assign(new Request("http://local/resume", { method: "POST" }), { params: { id: wp.id },
    text: stalledBody, json: async () => JSON.parse(await stalledBody()) });
  const response = createWorkflowRoutes()["/api/webhooks/waitpoints/:id"]!.POST!(req);
  await entered.promise;
  cancelFlowRun(run.id); body.resolve();
  expect((await response).status).toBe(409);
  expect(getFlowRun(run.id)?.status).toBe("STOPPED");
  expect(getWorkflowDb().query("SELECT id FROM workflow_job WHERE flow_run_id = ?").all(run.id)).toEqual([]);
});

test.each([false, true])("a delegated agent stops between tool calls and retains the first result (delete after cancel: %s)", async (deleteAfterCancel) => {
  const run = fixture("RUNNING");
  const entered = deferred(), finish = deferred();
  const registry = new ToolRegistry();
  let effects = 0, llmCalls = 0;
  registry.register({ name: "effect", description: "synthetic", category: "test", parameters: {}, execute: async () => {
    effects++; entered.resolve(); await finish.promise; return "committed-receipt";
  } });
  const result = withRunCancellation(run.id, () => runSubAgent({
    task: "synthetic", context: "", toolRegistry: registry, maxIterations: 1,
    agent: { id: "test", agent: { role: { name: "test", description: "test", responsibilities: [] } },
      activate() {}, idle() {}, setTask() {}, addMessage() {}, getMessages: () => [] },
    llmManager: { async chatTier() { llmCalls++; return {
      usage: { input_tokens: 0, output_tokens: 0 }, content: "", finish_reason: "tool_use",
      tool_calls: [{ id: "one", name: "effect", arguments: {} }, { id: "two", name: "effect", arguments: {} }],
    }; } },
  } as unknown as RunSubAgentOptions));
  await entered.promise;
  cancelFlowRun(run.id);
  if (deleteAfterCancel) await deleteWorkflow(run.flowId, run.id);
  finish.resolve();
  const final = await result;
  expect(effects).toBe(1);
  expect(llmCalls).toBe(1);
  expect(final.success).toBe(false);
  expect(final.response).toContain("canceled");
  expect(JSON.stringify(final.messages)).toContain("committed-receipt");
});

test.each([false, true])("authenticated sandbox routes reject work after acknowledgement (delete after cancel: %s)", async (deleteAfterCancel) => {
  const run = fixture("RUNNING");
  let dispatches = 0;
  const api = new SandboxApi({ services: {
    credentialResolver: new CredentialResolver(),
    toolsInvoke: async req => { dispatches++; return { toolName: req.toolName, result: "unexpected" }; },
    notify: async () => { dispatches++; return { delivered: [], failed: [] }; },
    agentDelegate: async () => { dispatches++; return { finalMessage: "", toolCalls: [], status: "completed" }; },
    workflowsStart: async () => { dispatches++; return { runId: "unexpected" }; },
    llmChat: async () => { dispatches++; return { text: "unexpected" }; },
  } });
  await api.start({ port: 0 });
  const identity = { sandboxId: SandboxRegistry.newSandboxId(), runId: run.id, projectId: run.projectId };
  const { token, expiresAt } = await api.signer.mint(identity);
  api.registry.register({ ...identity, engineToken: token, expiresAt, terminatedAt: null });
  try {
    cancelFlowRun(run.id);
    if (deleteAfterCancel) await deleteWorkflow(run.flowId, run.id);
    for (const [path, body] of [
      ["tools/invoke", { toolName: "test", params: {} }], ["notify", { message: "test" }],
      ["agent/delegate", { goal: "test" }], ["workflows/start", { flowId: "test" }], ["llm/chat", { prompt: "test" }],
    ] as const) {
      const response = await fetch(`${api.baseUrl}/v1/jarvis/${path}`, { method: "POST", headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      }, body: JSON.stringify(body) });
      expect(response.status).toBe(409);
    }
    expect(dispatches).toBe(0);
  } finally { await api.stop(); }
});
