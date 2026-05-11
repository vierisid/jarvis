/**
 * Gated end-to-end: install a community piece from npm into a real pieces
 * dir, boot the engine subprocess pointed at it, run EXTRACT_PIECE_METADATA
 * for that piece, and assert the returned shape matches what the engine
 * sees in production.
 *
 * Closes the gap between the pieces-library `integration.test.ts` (which
 * stops at "bundle is requireable") and the real production path. Catches
 * regressions in:
 *   - The vendored piece-loader patch (shared node_modules layout) -- if
 *     the patch is wrong, the engine can't find the piece and the extract
 *     fails with PieceNotFoundError.
 *   - The published piece's `package.json` shape -- if upstream changes
 *     `main` to point at something else, the engine fails to load.
 *   - The piece-roots wiring in `engine-bootstrap.ts` -- if the bootstrap
 *     forgets to include the user pieces dir, no community piece gets
 *     metadata extracted.
 *
 * Run with:
 *   JARVIS_TEST_ENGINE_EXTRACT_PIECE=1 bun test src/workflows/pieces-library/engine-extract.test.ts
 *
 * The double gate (`JARVIS_TEST_ENGINE_BUILD` for the engine bundle +
 * `JARVIS_TEST_ENGINE_EXTRACT_PIECE` for this test) keeps the regular
 * suite fast: this test does a real bun-install + spawns a real engine,
 * which costs ~10-15s.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { closeWorkflowDb, initWorkflowDb } from "../db";
import { CredentialResolver } from "../credentials/adapter";
import { SandboxApi } from "../sandbox-api/server";
import { findCachedBundle, buildEngineBundle } from "../runner/engine-runtime/build";
import { EngineRuntime } from "../runner/engine-runtime/engine-runtime";
import { buildPieceCatalog } from "../runtime/piece-catalog";
import { DEFAULT_IDS } from "../db/schema";
import { CATALOG } from "./catalog";

const EXTRACT_GATE = process.env.JARVIS_TEST_ENGINE_EXTRACT_PIECE === "1";
const BUILD_GATE = process.env.JARVIS_TEST_ENGINE_BUILD === "1";

// Gmail is the canary. It's the heaviest dep tree (165MB through
// googleapis), so if anything regresses around shared-node_modules
// resolution or native bindings under Bun, it surfaces here first.
const CANARY_ID = "gmail";

describe("engine extracts metadata for an npm-installed piece (gated)", () => {
  let api: SandboxApi;
  let runtime: EngineRuntime | null = null;
  let piecesDir: string;

  beforeAll(async () => {
    if (!EXTRACT_GATE) return;
    initWorkflowDb(":memory:");
    api = new SandboxApi({ services: { credentialResolver: new CredentialResolver() } });
    await api.start({ port: 0 });

    let cached = findCachedBundle();
    if (!cached && BUILD_GATE) cached = await buildEngineBundle();
    if (!cached) {
      throw new Error(
        "Engine bundle not cached. Pass JARVIS_TEST_ENGINE_BUILD=1 alongside this gate to build one.",
      );
    }

    // Set up a real pieces dir with one piece installed. Same shape as the
    // production `~/.jarvis/pieces/` -- package.json + bun install ->
    // node_modules/@activepieces/piece-<id>/...
    piecesDir = mkdtempSync(join(tmpdir(), "jarvis-engine-extract-"));
    const entry = CATALOG.find((e) => e.id === CANARY_ID);
    if (!entry) throw new Error(`catalog missing canary entry "${CANARY_ID}"`);
    writeFileSync(
      resolve(piecesDir, "package.json"),
      JSON.stringify(
        {
          name: "engine-extract-probe",
          private: true,
          dependencies: { [entry.npmPackage]: entry.versionRange },
        },
        null,
        2,
      ) + "\n",
    );
    const installRes = spawnSync("bun", ["install", "--silent"], {
      cwd: piecesDir,
      stdio: "pipe",
      encoding: "utf8",
    });
    if (installRes.status !== 0) {
      throw new Error(
        `bun install for ${entry.npmPackage} failed in ${piecesDir}:\n${installRes.stderr}`,
      );
    }

    // Build the runtime pointing at the temp pieces dir. customPiecesPaths
    // drives the engine subprocess's piece-loader (so it finds the piece
    // at runtime); pieceRoots drives the catalog builder (so we discover
    // what to extract).
    runtime = new EngineRuntime({
      api,
      bundlePath: cached.bundlePath,
      customPiecesPaths: [piecesDir],
    });
  });

  afterAll(async () => {
    if (runtime) await runtime.shutdown();
    if (api) await api.stop();
    closeWorkflowDb();
    if (piecesDir) rmSync(piecesDir, { recursive: true, force: true });
  });

  test.skipIf(!EXTRACT_GATE)(
    "engine produces metadata for gmail with actions + triggers + name",
    async () => {
      // Use the same buildPieceCatalog code path the daemon's bootstrap
      // calls -- if it works here, it works at startup. The piece-roots
      // we pass match what `engine-bootstrap.ts` constructs for the
      // user-pieces dir.
      const pieceRoots = [resolve(piecesDir, "node_modules", "@activepieces")];
      const { catalog, failures } = await buildPieceCatalog({
        runtime: runtime!,
        pieceRoots,
        projectId: DEFAULT_IDS.project,
        pieceTimeoutMs: 30_000,
        overallTimeoutMs: 45_000,
      });

      if (failures.length > 0) {
        const detail = failures
          .map((f) => `  - ${f.pieceName}@${f.pieceVersion}: ${f.reason}`)
          .join("\n");
        throw new Error(`piece extraction failed:\n${detail}`);
      }

      const entry = CATALOG.find((e) => e.id === CANARY_ID)!;
      const real = catalog.get(entry.npmPackage);
      expect(real).not.toBeNull();
      expect(real!.name).toBe(entry.npmPackage);
      // Gmail ships ~7 actions + ~4 triggers. We don't pin exact counts
      // (drift with upstream releases) but assert both surfaces exist and
      // contain at least one entry each -- regression for "extract
      // returned empty piece shell" which would let a broken loader sneak
      // through with a hollow success.
      const actionNames = Object.keys(real!.actions);
      expect(actionNames.length).toBeGreaterThan(0);
      const triggerNames = Object.keys(real!.triggers ?? {});
      expect(triggerNames.length).toBeGreaterThan(0);
      // Stable, version-resilient assertions: send_email is the canonical
      // gmail action; new email triggers always include
      // gmail_new_email_received. If upstream renames these, the test
      // surfaces the drift loudly.
      expect(real!.actions["send_email"]).toBeDefined();
      expect(real!.triggers!["gmail_new_email_received"]).toBeDefined();
    },
    120_000,
  );
});
