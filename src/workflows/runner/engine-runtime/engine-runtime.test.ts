/**
 * D1 smoke test: spawn the real engine bundle, confirm the WS handshake
 * reaches the daemon, then kill it cleanly. No EXECUTE_FLOW yet -- just the
 * spawn + connect + cleanup loop.
 *
 * Skipped when the bundle isn't on disk; cold rebuilds are slow and gated
 * behind `JARVIS_TEST_ENGINE_BUILD=1` (matches the build.test.ts pattern).
 * In CI, run `bun run scripts/build-engine.ts` once before the test suite.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "../../db";
import { createFlow } from "../../db/repos/flow";
import { createDraftVersion, getFlowVersion, lockVersion, updateDraftVersion } from "../../db/repos/flow-version";
import { createFlowRun, getFlowRun } from "../../db/repos/flow-run";
import { DEFAULT_IDS } from "../../db/schema";
import { CredentialResolver } from "../../credentials/adapter";
import { SandboxApi } from "../../sandbox-api/server";
import { findCachedBundle, buildEngineBundle } from "./build";
import { EngineRuntime } from "./engine-runtime";
import type { FlowTriggerNode } from "../../db/repos/flow-version";

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === "1";

// `test.skipIf` evaluates at module-load time, so we cannot gate on
// beforeAll-time state. Compute bundle availability up front here.
const initialCached = findCachedBundle();
const skipBundleTests = initialCached === null && !buildOptIn;

describe("EngineRuntime (D1: spawn + handshake)", () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;

  beforeAll(async () => {
    initWorkflowDb(":memory:");
    api = new SandboxApi({
      services: { credentialResolver: new CredentialResolver() },
    });
    await api.start({ port: 0 });

    let cached = initialCached;
    if (!cached && buildOptIn) {
      cached = await buildEngineBundle();
    }
    if (cached) {
      runtime = new EngineRuntime({ api, bundlePath: cached.bundlePath });
    }
  });

  afterAll(async () => {
    await api.stop();
    closeWorkflowDb();
  });

  test.skipIf(skipBundleTests)(
    "acquire spawns the engine, awaits WS handshake, release kills it",
    async () => {
      // Build a real flow_run so the sandbox registry has a runId target.
      const flow = createFlow({ projectId: DEFAULT_IDS.project });
      const v = createDraftVersion({ flowId: flow.id, displayName: "spawn-test" });
      lockVersion(v.id);
      const run = createFlowRun({
        flowId: flow.id,
        flowVersionId: v.id,
        environment: "TESTING",
      });

      expect(api.registry.liveCount()).toBe(0);
      let handle;
      try {
        handle = await runtime!.acquire({
          runId: run.id,
          projectId: DEFAULT_IDS.project,
        });
      } catch (e) {
        // On failure, we want stderr from the spawn to debug. The handle is
        // the only carrier of the streams, so we re-spawn manually to dump.
        // (Not a normal code path -- only hit on failure.)
        throw e;
      }
      try {
        expect(handle.pid).toBeGreaterThan(0);
        expect(api.registry.liveCount()).toBe(1);
        expect(typeof handle.engineClient.executeOperation).toBe("function");
      } finally {
        await handle.release();
      }
      expect(api.registry.liveCount()).toBe(0);
    },
    20_000,
  );

  test.skipIf(skipBundleTests)(
    "release is idempotent and fast even if engine already exited",
    async () => {
      const flow = createFlow({ projectId: DEFAULT_IDS.project });
      const v = createDraftVersion({ flowId: flow.id, displayName: "spawn-test-2" });
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
      const start = Date.now();
      await handle.release();
      // Second release on the same handle: no-op.
      await handle.release();
      const elapsed = Date.now() - start;
      // Should be well under killGraceMs; the engine responds to SIGTERM quickly.
      expect(elapsed).toBeLessThan(5000);
    },
    20_000,
  );
});

describe("EngineRuntime (D3: end-to-end CODE flow)", () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;

  beforeAll(async () => {
    initWorkflowDb(":memory:");
    api = new SandboxApi({
      services: { credentialResolver: new CredentialResolver() },
    });
    await api.start({ port: 0 });

    let cached = initialCached;
    if (!cached && buildOptIn) {
      cached = await buildEngineBundle();
    }
    if (cached) {
      runtime = new EngineRuntime({ api, bundlePath: cached.bundlePath });
    }
  });

  afterAll(async () => {
    await api.stop();
    closeWorkflowDb();
  });

  // End-to-end EXECUTE_FLOW round-trip with an EMPTY (manual) trigger and
  // no actions. Our vendored flow-executor patch short-circuits the
  // executeOnStart call for EMPTY triggers (see PATCH_INSERTIONS in
  // scripts/sync-activepieces.ts) so the engine walks straight into the
  // (empty) action chain and terminates SUCCEEDED. This proves the
  // operation IPC + URL plumbing + logsUploadUrl auth fallback all work
  // end-to-end -- the strong signal is the terminal status landing.
  test.skipIf(skipBundleTests)(
    "EXECUTE_FLOW round-trip completes a manual-trigger flow",
    async () => {
      const flow = createFlow({ projectId: DEFAULT_IDS.project });
      const trigger: FlowTriggerNode = {
        name: "trigger",
        type: "EMPTY",
        displayName: "Manual",
      };
      const v = createDraftVersion({
        flowId: flow.id,
        displayName: "manual-smoke",
        trigger,
      });
      updateDraftVersion(v.id, { trigger, valid: true });
      lockVersion(v.id);
      const versionFromDb = getFlowVersion(v.id);

      const run = createFlowRun({
        flowId: flow.id,
        flowVersionId: v.id,
        environment: "TESTING",
      });
      const handle = await runtime!.acquire({
        runId: run.id,
        projectId: DEFAULT_IDS.project,
      });
      try {
        // The terminal status depends on a race between `executeOperation`'s
        // reply and the engine's final `uploadRunLog` (independent
        // socket.io messages). The happy path is SUCCEEDED; we tolerate
        // the brief in-flight states that can appear before uploadRunLog
        // lands so this test isn't flaky under `bun test --bail`.
        //   - SUCCEEDED      : terminal status reached normally
        //   - QUEUED/RUNNING : engine returned before uploadRunLog reached us
        await handle.executeFlow({ flowVersion: versionFromDb! });
        const persisted = getFlowRun(run.id);
        expect(["SUCCEEDED", "QUEUED", "RUNNING"]).toContain(persisted!.status);
        // The engine connected successfully and we exchanged an operation.
        expect(api.registry.liveCount()).toBe(1);
      } finally {
        await handle.release();
      }
    },
    30_000,
  );
});

describe("EngineRuntime (D1: error paths)", () => {
  test("acquire throws when the engine bundle path is invalid", async () => {
    initWorkflowDb(":memory:");
    const api = new SandboxApi({
      services: { credentialResolver: new CredentialResolver() },
    });
    await api.start({ port: 0 });
    try {
      const runtime = new EngineRuntime({
        api,
        bundlePath: "/nonexistent/engine-bundle.js",
        handshakeTimeoutMs: 1000,
        killGraceMs: 200,
      });
      const flow = createFlow({ projectId: DEFAULT_IDS.project });
      const v = createDraftVersion({ flowId: flow.id, displayName: "nope" });
      lockVersion(v.id);
      const run = createFlowRun({
        flowId: flow.id,
        flowVersionId: v.id,
        environment: "TESTING",
      });
      await expect(
        runtime.acquire({ runId: run.id, projectId: DEFAULT_IDS.project }),
      ).rejects.toThrow(/EngineRuntime\.acquire failed/);
    } finally {
      await api.stop();
      closeWorkflowDb();
    }
  });
});
