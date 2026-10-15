/**
 * #762. The verified engine-bundle digest has to reach the daemon's runtime
 * through `bootstrapWorkflowEngine`, which is the one production path that
 * resolves a bundle and builds the long-lived `EngineRuntime` from it. The
 * type system only forces SOME `expectedDigest` to be passed; this pins that
 * it is the digest the lookup verified, by booting against a verified shared
 * root and then swapping the bytes under it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { bundleHash, findCachedBundle } from "../runner/engine-runtime/build";
import { BundleIntegrityError } from "../runner/engine-runtime/bundle-integrity";
import { closeWorkflowDb, initWorkflowDb } from "../db";
import { CredentialResolver } from "../credentials/adapter";
import { bootstrapWorkflowEngine } from "./engine-bootstrap";

// A real bundle to publish as the shared root; the same gate the end-to-end
// suites use, so this runs wherever they do.
const cached = findCachedBundle({ sharedRoot: null });

const made: string[] = [];
const savedPiecesDir = process.env.JARVIS_PIECES_DIR;
afterAll(() => {
  if (savedPiecesDir === undefined) delete process.env.JARVIS_PIECES_DIR;
  else process.env.JARVIS_PIECES_DIR = savedPiecesDir;
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(cached === null)("bootstrapWorkflowEngine carries the verified digest into its runtime (#762)", () => {
  test("bytes swapped under a verified shared root after boot are refused at the next spawn", async () => {
    const work = mkdtempSync(join(tmpdir(), "jarvis-762-boot-"));
    made.push(work);
    // The user pieces dir is reconciled at boot; point it at an empty tree so
    // the test never touches ~/.jarvis/pieces.
    process.env.JARVIS_PIECES_DIR = join(work, "pieces");
    const sharedRoot = join(work, "engine-cache");
    const bundleDir = join(sharedRoot, bundleHash());
    mkdirSync(bundleDir, { recursive: true });
    const bundlePath = join(bundleDir, "main.js");
    copyFileSync(cached!.bundlePath, bundlePath);
    writeFileSync(bundlePath + ".sha256", createHash("sha256").update(readFileSync(bundlePath)).digest("hex") + "\n");

    initWorkflowDb(":memory:");
    const boot = await bootstrapWorkflowEngine({
      services: { credentialResolver: new CredentialResolver() },
      log: () => {},
      cacheFile: join(work, "piece-metadata.json"),
      pieceRoots: [],
      engineCacheRoot: sharedRoot,
      sharedPiecesDir: null,
      sharedCacheFile: null,
      skipEngineMaintenance: true,
    });
    try {
      writeFileSync(bundlePath, "// swapped after boot\n");
      await expect(boot.runtime.acquire({ runId: "r-762-boot", projectId: "p-762" }))
        .rejects.toBeInstanceOf(BundleIntegrityError);
    } finally {
      await boot.shutdown();
      closeWorkflowDb();
    }
  }, 60_000);
});
