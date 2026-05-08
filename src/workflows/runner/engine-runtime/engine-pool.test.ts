/**
 * Engine pool: when `EngineRuntime` is constructed with `pool: true`, the
 * second `acquire()` after a `release()` reuses the same subprocess + WS
 * connection instead of cold-spawning a fresh one. Same sandboxId across
 * runs; the registry is rebound to each new (runId, projectId).
 *
 * Gated on `JARVIS_TEST_ENGINE_BUILD=1` like the other engine-runtime tests.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { closeWorkflowDb, initWorkflowDb } from "../../db";
import { CredentialResolver } from "../../credentials/adapter";
import { SandboxApi } from "../../sandbox-api/server";
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
    if (!piecesAlreadyBuilt && buildOptIn) await buildAllJarvisPieces();
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
    "second acquire reuses the same engine process (sandboxId stays, pid stays)",
    async () => {
      const h1 = await runtime!.acquire({
        runId: "run_pool_1",
        projectId: "jrv_proj_default",
      });
      const sandbox1 = h1.sandboxId;
      const pid1 = h1.pid;
      await h1.release();

      const h2 = await runtime!.acquire({
        runId: "run_pool_2",
        projectId: "jrv_proj_default",
      });
      // Same engine: same sandboxId, same pid.
      expect(h2.sandboxId).toBe(sandbox1);
      expect(h2.pid).toBe(pid1);
      // But rebound to the new run.
      expect(h2.runId).toBe("run_pool_2");
      // Registry agrees.
      expect(api.registry.byRunId("run_pool_2")?.sandboxId).toBe(sandbox1);
      expect(api.registry.byRunId("run_pool_1")).toBeNull();
      await h2.release();

      // shutdown() reaps the warm engine.
      await runtime!.shutdown();
      // After shutdown the registry record is terminated.
      expect(api.registry.get(sandbox1)).toBeNull();
    },
    60_000,
  );
});
