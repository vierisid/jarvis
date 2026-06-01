/**
 * Phase F end-to-end smoke: spawn the engine, load Jarvis pieces from disk,
 * run a real flow with a manual trigger + echo action, assert SUCCEEDED.
 *
 * This is the gate the proposal called out -- if this works, porting the rest
 * of the Jarvis pieces is mechanical. Skipped when the engine bundle isn't on
 * disk; when run, builds the pieces (idempotent) before spawning.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { closeWorkflowDb, initWorkflowDb } from "../../db";
import { createFlow } from "../../db/repos/flow";
import {
  createDraftVersion,
  getFlowVersion,
  lockVersion,
  updateDraftVersion,
} from "../../db/repos/flow-version";
import type { FlowTriggerNode } from "../../db/repos/flow-version";
import { createFlowRun, getFlowRun } from "../../db/repos/flow-run";
import { DEFAULT_IDS } from "../../db/schema";
import { CredentialResolver } from "../../credentials/adapter";
import { SandboxApi } from "../../sandbox-api/server";
import type { LlmChatFn } from "../../sandbox-api/routes/jarvis-llm";
import type { ToolsInvokeFn } from "../../sandbox-api/routes/jarvis-tools";
import type { NotifyFn } from "../../sandbox-api/routes/jarvis-notify";
import type { JarvisContextProvider } from "../../sandbox-api/routes/jarvis-context";
import type { AgentDelegateFn } from "../../sandbox-api/routes/jarvis-agent";
import type { WorkflowsStartFn } from "../../sandbox-api/routes/jarvis-workflows";
import { findCachedBundle, buildEngineBundle, ENGINE_BUILD_PATHS } from "./build";
import { buildAllJarvisPieces } from "./build-pieces";
import { EngineRuntime } from "./engine-runtime";

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const initialCached = findCachedBundle();
const skipBundleTests = initialCached === null && !buildOptIn;
const piecesAlreadyBuilt = existsSync(
  resolve(
    ENGINE_BUILD_PATHS.VENDOR_PACKAGES,
    "pieces/jarvis/test/dist/src/index.js",
  ),
);
const skipE2eTests = skipBundleTests || (!piecesAlreadyBuilt && !buildOptIn);

const PIECE_TEST_NAME = "@jarvispieces/piece-jarvis-test";
const PIECE_ASK_NAME = "@jarvispieces/piece-jarvis-ask";
const PIECE_TOOL_NAME = "@jarvispieces/piece-jarvis-tool";
const PIECE_NOTIFY_NAME = "@jarvispieces/piece-jarvis-notify";
const PIECE_CONTEXT_NAME = "@jarvispieces/piece-jarvis-context";
const PIECE_AGENT_NAME = "@jarvispieces/piece-jarvis-agent";
const PIECE_TRIGGER_NAME = "@jarvispieces/piece-jarvis-trigger";
const PIECE_VERSION = "0.0.1";

describe("Engine end-to-end (F gate)", () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;
  let llmCalls: Array<{ prompt: string; system?: string; parseJson?: boolean }> = [];

  const llmChat: LlmChatFn = async (req) => {
    llmCalls.push(req);
    return { text: `(stubbed reply to: ${req.prompt})` };
  };

  beforeAll(async () => {
    initWorkflowDb(":memory:");
    api = new SandboxApi({
      services: { credentialResolver: new CredentialResolver(), llmChat },
    });
    await api.start({ port: 0 });

    let cached = initialCached;
    if (!cached && buildOptIn) {
      cached = await buildEngineBundle();
    }
    if (!cached) return;
    if (buildOptIn) {
      await buildAllJarvisPieces();
    }
    runtime = new EngineRuntime({ api, bundlePath: cached.bundlePath });
  });

  afterAll(async () => {
    await api.stop();
    closeWorkflowDb();
  });

  test.skipIf(skipE2eTests)(
    "manual trigger + echo action runs to SUCCEEDED",
    async () => {
      const flow = createFlow({ projectId: DEFAULT_IDS.project });
      const trigger: FlowTriggerNode = {
        name: "trigger",
        type: "PIECE_TRIGGER",
        displayName: "Manual",
        settings: {
          pieceName: PIECE_TEST_NAME,
          pieceVersion: PIECE_VERSION,
          triggerName: "manual",
          input: { payload: { hello: "world" } },
        },
        nextAction: {
          name: "step_1",
          type: "PIECE",
          displayName: "Echo",
          settings: {
            pieceName: PIECE_TEST_NAME,
            pieceVersion: PIECE_VERSION,
            actionName: "echo",
            input: { value: { from: "test" } },
          },
        },
      };
      const v = createDraftVersion({
        flowId: flow.id,
        displayName: "manual-echo",
        trigger,
      });
      updateDraftVersion(v.id, { trigger, valid: true });
      lockVersion(v.id);

      const run = createFlowRun({
        flowId: flow.id,
        flowVersionId: v.id,
        environment: "TESTING",
      });
      const handle = await runtime!.acquire({
        runId: run.id,
        projectId: DEFAULT_IDS.project,
      });
      let stderrBuf = "";
      handle.stderr?.on("data", (d) => { stderrBuf += d.toString(); });
      try {
        const finalRun = await handle.executeFlow({
          flowVersion: getFlowVersion(v.id)!,
        });
        if (finalRun.status !== "SUCCEEDED") {
          console.error(`[engine stderr]\n${stderrBuf.slice(0, 4000)}`);
        }
        expect(finalRun.status).toBe("SUCCEEDED");
      } finally {
        await handle.release();
      }
      const persisted = getFlowRun(run.id);
      expect(persisted?.status).toBe("SUCCEEDED");
    },
    45_000,
  );

  test.skipIf(skipE2eTests)(
    "manual trigger + jarvis-ask action calls daemon's /v1/jarvis/llm/chat",
    async () => {
      llmCalls = [];
      const flow = createFlow({ projectId: DEFAULT_IDS.project });
      const trigger: FlowTriggerNode = {
        name: "trigger",
        type: "PIECE_TRIGGER",
        displayName: "Manual",
        settings: {
          pieceName: PIECE_TEST_NAME,
          pieceVersion: PIECE_VERSION,
          triggerName: "manual",
          input: { payload: {} },
        },
        nextAction: {
          name: "step_1",
          type: "PIECE",
          displayName: "Ask",
          settings: {
            pieceName: PIECE_ASK_NAME,
            pieceVersion: PIECE_VERSION,
            actionName: "ask",
            input: { prompt: "what's 2+2?" },
          },
        },
      };
      const v = createDraftVersion({
        flowId: flow.id,
        displayName: "manual-ask",
        trigger,
      });
      updateDraftVersion(v.id, { trigger, valid: true });
      lockVersion(v.id);

      const run = createFlowRun({
        flowId: flow.id,
        flowVersionId: v.id,
        environment: "TESTING",
      });
      const handle = await runtime!.acquire({
        runId: run.id,
        projectId: DEFAULT_IDS.project,
      });
      let stderrBuf = "";
      handle.stderr?.on("data", (d) => { stderrBuf += d.toString(); });
      try {
        const finalRun = await handle.executeFlow({
          flowVersion: getFlowVersion(v.id)!,
        });
        if (finalRun.status !== "SUCCEEDED") {
          console.error(`[engine stderr]\n${stderrBuf.slice(0, 4000)}`);
        }
        expect(finalRun.status).toBe("SUCCEEDED");
        expect(llmCalls.length).toBe(1);
        expect(llmCalls[0]?.prompt).toBe("what's 2+2?");
      } finally {
        await handle.release();
      }
    },
    45_000,
  );
});

describe("Engine end-to-end (G+H pieces)", () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;
  const calls: {
    tool: Array<{ toolName: string; params: Record<string, unknown> }>;
    notify: Array<{ message: string }>;
    context: Array<{ method: string }>;
    agent: Array<{ goal: string }>;
    workflows: Array<{ flowId: string }>;
  } = { tool: [], notify: [], context: [], agent: [], workflows: [] };

  const toolsInvoke: ToolsInvokeFn = async (req) => {
    calls.tool.push(req);
    return { result: { ok: true }, toolName: req.toolName };
  };
  const notify: NotifyFn = async (req) => {
    calls.notify.push({ message: req.message });
    return { delivered: ["dashboard"], failed: [] };
  };
  const contextProvider: JarvisContextProvider = {
    vaultSearch: async () => {
      calls.context.push({ method: "vaultSearch" });
      return [];
    },
    vaultGetEntity: async () => null,
    awarenessRecent: async () => [],
    commitmentsList: async () => [],
  };
  const agentDelegate: AgentDelegateFn = async (req) => {
    calls.agent.push({ goal: req.goal });
    return { finalMessage: "ok", toolCalls: [], status: "completed" };
  };
  const workflowsStart: WorkflowsStartFn = async (req) => {
    calls.workflows.push({ flowId: req.flowId });
    return { runId: "run_stub" };
  };

  beforeAll(async () => {
    initWorkflowDb(":memory:");
    api = new SandboxApi({
      services: {
        credentialResolver: new CredentialResolver(),
        toolsInvoke,
        notify,
        contextProvider,
        agentDelegate,
        workflowsStart,
      },
    });
    await api.start({ port: 0 });

    let cached = initialCached;
    if (!cached && buildOptIn) cached = await buildEngineBundle();
    if (!cached) return;
    if (buildOptIn) await buildAllJarvisPieces();
    runtime = new EngineRuntime({ api, bundlePath: cached.bundlePath });
  });

  afterAll(async () => {
    await api.stop();
    closeWorkflowDb();
  });

  test.skipIf(skipE2eTests)(
    "manual trigger -> tool -> notify -> context -> agent -> trigger.run_workflow chain hits every endpoint",
    async () => {
      // Reset trackers in case the suite is rerun.
      calls.tool.length = 0;
      calls.notify.length = 0;
      calls.context.length = 0;
      calls.agent.length = 0;
      calls.workflows.length = 0;

      const flow = createFlow({ projectId: DEFAULT_IDS.project });
      const trigger: FlowTriggerNode = {
        name: "trigger",
        type: "PIECE_TRIGGER",
        displayName: "Manual",
        settings: {
          pieceName: PIECE_TEST_NAME,
          pieceVersion: PIECE_VERSION,
          triggerName: "manual",
          input: { payload: {} },
        },
        nextAction: {
          name: "step_tool",
          type: "PIECE",
          displayName: "Tool",
          settings: {
            pieceName: PIECE_TOOL_NAME,
            pieceVersion: PIECE_VERSION,
            actionName: "invoke",
            input: { toolName: "vault_search", params: { query: "alice" } },
          },
          nextAction: {
            name: "step_notify",
            type: "PIECE",
            displayName: "Notify",
            settings: {
              pieceName: PIECE_NOTIFY_NAME,
              pieceVersion: PIECE_VERSION,
              actionName: "notify",
              input: { message: "hello", channels: ["dashboard"], priority: "normal" },
            },
            nextAction: {
              name: "step_context",
              type: "PIECE",
              displayName: "Context",
              settings: {
                pieceName: PIECE_CONTEXT_NAME,
                pieceVersion: PIECE_VERSION,
                actionName: "vault_search",
                input: { query: "alice" },
              },
              nextAction: {
                name: "step_agent",
                type: "PIECE",
                displayName: "Agent",
                settings: {
                  pieceName: PIECE_AGENT_NAME,
                  pieceVersion: PIECE_VERSION,
                  actionName: "delegate",
                  input: { goal: "say hi" },
                },
                nextAction: {
                  name: "step_runwf",
                  type: "PIECE",
                  displayName: "RunWF",
                  settings: {
                    pieceName: PIECE_TRIGGER_NAME,
                    pieceVersion: PIECE_VERSION,
                    actionName: "run_workflow",
                    input: { flow: "flow_other", payload: {} },
                  },
                },
              },
            },
          },
        },
      };
      const v = createDraftVersion({
        flowId: flow.id,
        displayName: "G-H-chain",
        trigger,
      });
      updateDraftVersion(v.id, { trigger, valid: true });
      lockVersion(v.id);

      const run = createFlowRun({
        flowId: flow.id,
        flowVersionId: v.id,
        environment: "TESTING",
      });
      const handle = await runtime!.acquire({
        runId: run.id,
        projectId: DEFAULT_IDS.project,
      });
      let stderrBuf = "";
      handle.stderr?.on("data", (d) => { stderrBuf += d.toString(); });
      try {
        const finalRun = await handle.executeFlow({
          flowVersion: getFlowVersion(v.id)!,
        });
        if (finalRun.status !== "SUCCEEDED") {
          console.error(`[engine stderr]\n${stderrBuf.slice(0, 4000)}`);
        }
        expect(finalRun.status).toBe("SUCCEEDED");
      } finally {
        await handle.release();
      }
      expect(calls.tool.length).toBe(1);
      expect(calls.tool[0]?.toolName).toBe("vault_search");
      expect(calls.notify.length).toBe(1);
      expect(calls.notify[0]?.message).toBe("hello");
      expect(calls.context.length).toBe(1);
      expect(calls.context[0]?.method).toBe("vaultSearch");
      expect(calls.agent.length).toBe(1);
      expect(calls.agent[0]?.goal).toBe("say hi");
      expect(calls.workflows.length).toBe(1);
      expect(calls.workflows[0]?.flowId).toBe("flow_other");
    },
    60_000,
  );
});
