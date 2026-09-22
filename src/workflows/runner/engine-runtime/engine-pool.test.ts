/**
 * Engine pool: when `EngineRuntime` is constructed with `pool: true`, the
 * second `acquire()` after a `release()` reuses the same subprocess + WS
 * connection instead of cold-spawning a fresh one. Same sandboxId across
 * runs; the registry is rebound to each new (runId, projectId).
 *
 * Gated on `JARVIS_TEST_ENGINE_BUILD=1` like the other engine-runtime tests.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { closeWorkflowDb, initWorkflowDb } from "../../db";
import { CredentialResolver } from "../../credentials/adapter";
import { SandboxApi } from "../../sandbox-api/server";
import { workflowLogsBase } from "../../sandbox-api/config";
import { DEFAULT_IDS } from "../../db/schema";
import { createFlow } from "../../db/repos/flow";
import {
  createDraftVersion,
  getFlowVersion,
  lockVersion,
  updateDraftVersion,
} from "../../db/repos/flow-version";
import { createFlowRun } from "../../db/repos/flow-run";
import {
  ENGINE_BUILD_PATHS,
  buildEngineBundle,
  findCachedBundle,
} from "./build";
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

describe("EngineRuntime pool", () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;

  beforeAll(async () => {
    initWorkflowDb(":memory:");
    api = new SandboxApi({
      services: { credentialResolver: new CredentialResolver() },
    });
    await api.start({ port: 0 });
    let cached = initialCached;
    if (!cached && buildOptIn) cached = await buildEngineBundle();
    if (!cached) return;
    if (buildOptIn) await buildAllJarvisPieces();
    runtime = new EngineRuntime({
      api,
      bundlePath: cached.bundlePath,
      pool: true,
    });
  });

  afterAll(async () => {
    if (runtime) await runtime.shutdown();
    await api.stop();
    closeWorkflowDb();
  });

  test.skipIf(skipE2eTests)(
    "idle TTL kills the parked engine after the configured timeout",
    async () => {
      // Separate runtime instance with an aggressive TTL so the test runs fast.
      // The shared `runtime` set up in beforeAll uses the default 5min TTL.
      let cached = findCachedBundle();
      if (!cached) cached = await buildEngineBundle();
      const ttlRuntime = new EngineRuntime({
        api,
        bundlePath: cached.bundlePath,
        pool: true,
        // 300ms TTL: long enough that a slow CI doesn't accidentally
        // expire the engine before the "still alive" assertion below
        // ran for the other test; short enough to keep the test fast.
        poolIdleTtlMs: 300,
      });
      try {
        const h = await ttlRuntime.acquire({
          runId: "run_ttl_park",
          projectId: "jrv_proj_default",
        });
        const sandbox = h.sandboxId;
        await h.release();
        // Engine should be parked right now (alive in the registry).
        expect(api.registry.get(sandbox)).not.toBeNull();
        // Wait past TTL with generous slack so the timer fires + the
        // registry.terminate settles even under CI load.
        await new Promise((r) => setTimeout(r, 800));
        expect(api.registry.get(sandbox)).toBeNull();
        // The next acquire spawns fresh (different sandboxId).
        const h2 = await ttlRuntime.acquire({
          runId: "run_ttl_postevict",
          projectId: "jrv_proj_default",
        });
        expect(h2.sandboxId).not.toBe(sandbox);
        await h2.release();
      } finally {
        await ttlRuntime.shutdown();
      }
    },
    60_000,
  );

  test.skipIf(skipE2eTests)(
    "reusing the warm engine cancels the pending eviction (TTL doesn't kill an in-use engine)",
    async () => {
      let cached = findCachedBundle();
      if (!cached) cached = await buildEngineBundle();
      const ttlRuntime = new EngineRuntime({
        api,
        bundlePath: cached.bundlePath,
        pool: true,
        poolIdleTtlMs: 300,
      });
      try {
        const h1 = await ttlRuntime.acquire({
          runId: "run_ttl_acq1",
          projectId: "jrv_proj_default",
        });
        const sandbox = h1.sandboxId;
        await h1.release();
        // Acquire well before TTL expires -- the eviction timer must be
        // cancelled.
        await new Promise((r) => setTimeout(r, 100));
        const h2 = await ttlRuntime.acquire({
          runId: "run_ttl_acq2",
          projectId: "jrv_proj_default",
        });
        expect(h2.sandboxId).toBe(sandbox); // pool reuse
        // Wait past the original TTL window with generous slack; the
        // cancelled timer must not tear down the live (in-use) engine.
        await new Promise((r) => setTimeout(r, 500));
        expect(api.registry.get(sandbox)).not.toBeNull();
        await h2.release();
      } finally {
        await ttlRuntime.shutdown();
      }
    },
    60_000,
  );

  test.skipIf(skipE2eTests)(
    "second acquire reuses the same engine process (sandboxId stays, pid stays)",
    async () => {
      const h1 = await runtime!.acquire({
        runId: "run_pool_1",
        projectId: "jrv_proj_default",
      });
      const sandbox1 = h1.sandboxId;
      const pid1 = h1.pid;
      await h1.release();

      // An assertion throwing between acquire and release used to abandon a
      // live engine that nothing would ever reclaim -- shutdown() only knew
      // about the PARKED one. Both halves are covered now, but the finally
      // still belongs here: a leaked engine should not depend on the guard.
      try {
        const h2 = await runtime!.acquire({
          runId: "run_pool_2",
          projectId: "jrv_proj_default",
        });
        try {
          // Same engine: same sandboxId, same pid.
          expect(h2.sandboxId).toBe(sandbox1);
          expect(h2.pid).toBe(pid1);
          // But rebound to the new run.
          expect(h2.runId).toBe("run_pool_2");
          // Registry agrees.
          expect(api.registry.byRunId("run_pool_2")?.sandboxId).toBe(sandbox1);
          expect(api.registry.byRunId("run_pool_1")).toBeNull();
        } finally {
          await h2.release();
        }
      } finally {
        // shutdown() reaps the warm engine.
        await runtime!.shutdown();
      }
      // After shutdown the registry record is terminated.
      expect(api.registry.get(sandbox1)).toBeNull();
    },
    60_000,
  );

  // The engine PUTs its zstd run-log backup to a URL with the engineToken
  // baked into the query string, built at EXECUTE_FLOW time. Now that the
  // sandbox API refuses a token the sandbox is no longer running under, that
  // URL has to be rebuilt on every acquire or the second and every later run
  // through a warm engine would silently lose its run log to a 401. Two real
  // flows through one pooled process, both backups on disk.
  test.skipIf(skipBundleTests)(
    "a run through the rebound warm engine still uploads its run log",
    async () => {
      // Its own pooled runtime: the shared one is shut down by the test
      // above, and this test needs a live warm slot across two acquires.
      let cached = findCachedBundle();
      if (!cached) cached = await buildEngineBundle();
      const pooled = new EngineRuntime({ api, bundlePath: cached.bundlePath, pool: true });
      const trigger = { name: "trigger", type: "EMPTY" as const, settings: {} };
      const runIds: string[] = [];
      let sandbox: string | null = null;
      try {
        for (const label of ["warm-logs-1", "warm-logs-2"]) {
          const flow = createFlow({ projectId: DEFAULT_IDS.project });
          const v = createDraftVersion({ flowId: flow.id, displayName: label, trigger });
          updateDraftVersion(v.id, { trigger, valid: true });
          lockVersion(v.id);
          const run = createFlowRun({
            flowId: flow.id,
            flowVersionId: v.id,
            environment: "TESTING",
          });
          runIds.push(run.id);
          const handle = await pooled.acquire({
            runId: run.id,
            projectId: DEFAULT_IDS.project,
          });
          // Same warm process across both runs -- otherwise this test is not
          // exercising the rebind at all.
          if (sandbox === null) sandbox = handle.sandboxId;
          else expect(handle.sandboxId).toBe(sandbox);
          try {
            await handle.executeFlow({ flowVersion: getFlowVersion(v.id)! });
          } finally {
            await handle.release();
          }
        }
        for (const runId of runIds) {
          const backup = resolve(workflowLogsBase(), `${runId}.bin`);
          expect(existsSync(backup)).toBe(true);
          expect(readFileSync(backup).byteLength).toBeGreaterThan(0);
        }
      } finally {
        await pooled.shutdown();
        for (const runId of runIds) {
          rmSync(resolve(workflowLogsBase(), `${runId}.bin`), { force: true });
        }
      }
    },
    120_000,
  );
});
