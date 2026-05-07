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
    if (!piecesAlreadyBuilt && buildOptIn) {
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
