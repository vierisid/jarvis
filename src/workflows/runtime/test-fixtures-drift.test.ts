/**
 * Drift detection between the hardcoded `sampleCatalog` test fixture and
 * the real Jarvis pieces. Gated on `JARVIS_TEST_ENGINE_BUILD=1` because
 * we need to spawn the engine to extract metadata.
 *
 * The fixture is structural -- composer/manage-workflow tests bind to its
 * action + field names. When the real piece grows a new required field or
 * an action gets renamed, tests against the fixture continue to pass while
 * production fails. This test compares action + trigger + field names
 * between the fixture and the real metadata and surfaces any divergence
 * with a clear "update test-fixtures.ts" message.
 *
 * What this test DOES check (drift that breaks tests):
 *   - Each piece in the fixture exists in the real catalog.
 *   - Each action / trigger name in the fixture exists in the real piece.
 *   - Each field name in the fixture's inputSchema exists in the real
 *     piece's metadata.
 *
 * What it doesn't check:
 *   - Field types (string vs long_text) -- a documentation drift, not a
 *     structural break.
 *   - Default values -- fixture defaults are test-scoped, can intentionally
 *     differ.
 *   - Real piece adding NEW fields / actions -- additive changes don't
 *     break fixture-bound tests; only removals + renames do.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { closeWorkflowDb, initWorkflowDb } from "../db";
import { CredentialResolver } from "../credentials/adapter";
import { SandboxApi } from "../sandbox-api/server";
import { findCachedBundle, buildEngineBundle, ENGINE_BUILD_PATHS } from "../runner/engine-runtime/build";
import { buildAllJarvisPieces } from "../runner/engine-runtime/build-pieces";
import { EngineRuntime } from "../runner/engine-runtime/engine-runtime";
import { sampleCatalog } from "./test-fixtures";
import { buildPieceCatalog } from "./piece-catalog";

const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const initialCached = findCachedBundle();
const skipBundleTests = initialCached === null && !buildOptIn;
const piecesAlreadyBuilt = existsSync(
  resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis/ask/dist/src/index.js"),
);
const skipE2eTests = skipBundleTests || (!piecesAlreadyBuilt && !buildOptIn);

// Map the fixture's bare-name keys to the real npm-style package names the
// engine extracts. These are the three pieces the fixture mirrors today.
const FIXTURE_TO_REAL: Record<string, string> = {
  "jarvis-ask": "@jarvispieces/piece-jarvis-ask",
  "jarvis-notify": "@jarvispieces/piece-jarvis-notify",
  "jarvis-trigger": "@jarvispieces/piece-jarvis-trigger",
};

describe("sampleCatalog drift vs real piece metadata", () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;

  beforeAll(async () => {
    initWorkflowDb(":memory:");
    api = new SandboxApi({ services: { credentialResolver: new CredentialResolver() } });
    await api.start({ port: 0 });

    let cached = initialCached;
    if (!cached && buildOptIn) cached = await buildEngineBundle();
    if (!cached) return;
    if (buildOptIn) await buildAllJarvisPieces();
    runtime = new EngineRuntime({ api, bundlePath: cached.bundlePath });
  });

  afterAll(async () => {
    if (runtime) await runtime.shutdown();
    await api.stop();
    closeWorkflowDb();
  });

  test.skipIf(skipE2eTests)(
    "fixture action + trigger + field names exist in the real piece metadata",
    async () => {
      const pieceRoots = [resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis")];
      const { catalog, failures } = await buildPieceCatalog({
        runtime: runtime!,
        pieceRoots,
      });
      expect(failures).toHaveLength(0);

      const fixture = sampleCatalog();
      const driftMessages: string[] = [];

      for (const fixtureEntry of fixture.list()) {
        const realName = FIXTURE_TO_REAL[fixtureEntry.name];
        if (!realName) {
          driftMessages.push(
            `fixture has "${fixtureEntry.name}" but no mapping to a real piece -- update FIXTURE_TO_REAL in this test`,
          );
          continue;
        }
        const real = catalog.get(realName);
        if (!real) {
          driftMessages.push(
            `fixture references "${fixtureEntry.name}" (real: "${realName}") but the engine didn't extract it`,
          );
          continue;
        }
        // Compare action names.
        for (const actionName of Object.keys(fixtureEntry.actions)) {
          if (!real.actions[actionName]) {
            driftMessages.push(
              `fixture's "${fixtureEntry.name}.actions.${actionName}" missing from real piece (renamed or removed?)`,
            );
            continue;
          }
          const fixtureFields = fixtureEntry.actions[actionName]!.inputSchema?.fields ?? [];
          const realFields = real.actions[actionName]!.inputSchema?.fields ?? [];
          const realFieldNames = new Set(realFields.map((f) => f.name));
          for (const ff of fixtureFields) {
            if (!realFieldNames.has(ff.name)) {
              driftMessages.push(
                `fixture's "${fixtureEntry.name}.actions.${actionName}" expects field "${ff.name}" but real piece doesn't have it`,
              );
            }
          }
        }
        // Same for triggers.
        const fixtureTriggers = fixtureEntry.triggers ?? {};
        for (const triggerName of Object.keys(fixtureTriggers)) {
          if (!real.triggers?.[triggerName]) {
            driftMessages.push(
              `fixture's "${fixtureEntry.name}.triggers.${triggerName}" missing from real piece`,
            );
            continue;
          }
          const fixtureFields = fixtureTriggers[triggerName]!.inputSchema?.fields ?? [];
          const realFields = real.triggers[triggerName]!.inputSchema?.fields ?? [];
          const realFieldNames = new Set(realFields.map((f) => f.name));
          for (const ff of fixtureFields) {
            if (!realFieldNames.has(ff.name)) {
              driftMessages.push(
                `fixture's "${fixtureEntry.name}.triggers.${triggerName}" expects field "${ff.name}" but real piece doesn't have it`,
              );
            }
          }
        }
      }

      if (driftMessages.length > 0) {
        const banner = [
          "sampleCatalog has drifted from the real piece metadata.",
          "Update src/workflows/runtime/test-fixtures.ts to match the current pieces, then re-run.",
          "",
          ...driftMessages.map((m) => `  - ${m}`),
        ].join("\n");
        throw new Error(banner);
      }
    },
    60_000,
  );
});
