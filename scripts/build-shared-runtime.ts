#!/usr/bin/env bun
/**
 * CLI: build EVERY per-version shared runtime artifact for multi-tenant
 * hosting, in one pass (the VPS's install-version wrapper calls this from the
 * freshly installed tree, with HOME pointed at a scratch dir):
 *
 *   <out>/engine/<hash>/main.js(+.map,.meta.json)   read-only shared bundle
 *                                                   (JARVIS_ENGINE_CACHE_ROOT)
 *   <out>/pieces/{package.json,bun.lock,node_modules/}
 *                                                   full community catalog
 *                                                   (JARVIS_SHARED_PIECES_DIR)
 *   <out>/piece-metadata.json                       prebuilt per-entry cache
 *                                                   (JARVIS_PIECE_METADATA_CACHE)
 *
 * The caller controls delta-efficiency via the environment: a persistent
 * BUN_INSTALL_CACHE_DIR makes unchanged packages hardlink instead of
 * download, and seeding <out>/pieces/bun.lock from the PREVIOUS version
 * (--seed-lock) keeps unchanged catalog ranges pinned so only genuinely
 * changed pieces resolve anew. Setting BUN_RUNTIME_TRANSPILER_CACHE_PATH
 * while this runs warms the transpiler cache for every piece SDK the
 * metadata extraction imports.
 *
 * Usage:
 *   bun run scripts/build-shared-runtime.ts --out /tmp/shared-runtime
 *     [--pieces N]           only the first N catalog entries (dev/CI smoke)
 *     [--seed-lock PATH]     previous version's pieces bun.lock
 *
 * Exit 0 with a JSON summary on stdout (including per-piece extraction
 * failures — the CALLER decides how many failures are acceptable); exit 1
 * only when the build itself cannot complete.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildEngineBundle, ENGINE_BUILD_PATHS } from "../src/workflows/runner/engine-runtime/build";
import { buildAllJarvisPieces } from "../src/workflows/runner/engine-runtime/build-pieces";
import { EngineRuntime } from "../src/workflows/runner/engine-runtime/engine-runtime";
import { SandboxApi } from "../src/workflows/sandbox-api/server";
import { CredentialResolver } from "../src/workflows/credentials/adapter";
import { CATALOG } from "../src/workflows/pieces-library/catalog";
import {
  buildPieceCatalog,
  computeCatalogCacheKey,
} from "../src/workflows/runtime/piece-catalog";

function flagValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const outArg = flagValue("--out");
if (!outArg) {
  console.error("usage: build-shared-runtime --out <dir> [--pieces N] [--seed-lock PATH]");
  process.exit(1);
}
const out = resolve(outArg);
const piecesLimit = flagValue("--pieces") ? Number(flagValue("--pieces")) : null;
if (piecesLimit !== null && (!Number.isInteger(piecesLimit) || piecesLimit < 0)) {
  console.error(`invalid --pieces: ${flagValue("--pieces")}`);
  process.exit(1);
}
const seedLock = flagValue("--seed-lock");
// --summary: the machine-readable contract. Builder stdout is NOT JSON-clean
// (engine children's stdout is forwarded with a prefix), so callers that need
// the summary read the file, never the stream.
const summaryPath = flagValue("--summary");

// Refuse a dirty output dir: stale artifacts from a previous run (a different
// catalog subset, an older engine hash) would be swept into the shared tree.
if (existsSync(out) && readdirSync(out).length > 0) {
  console.error(`--out ${out} exists and is not empty — pass a fresh directory`);
  process.exit(1);
}

const t0 = Date.now();
const log = (m: string) => console.error(`[shared-runtime] ${m}`);

// 1. Vendored jarvis pieces must be compiled before metadata extraction (they
// normally ship prebuilt; on a source checkout this builds them).
await buildAllJarvisPieces();

// 2. Engine bundle -> <out>/engine/<hash>/ (the whole content-addressed dir,
// so instances resolve it by the same hash they compute from the install).
// force: a build must always BE a build — without it a stray
// JARVIS_ENGINE_CACHE_ROOT in the builder's env would turn this into a copy
// of a pre-existing, unverified bundle.
const bundle = await buildEngineBundle({ force: true });
const engineOutDir = resolve(out, "engine", bundle.hash);
mkdirSync(engineOutDir, { recursive: true });
cpSync(bundle.bundleDir, engineOutDir, { recursive: true });
// Content manifest: the dir NAME is a hash of build INPUTS, not of main.js —
// consumers verify the sha256 of the bytes they are about to execute.
const mainBytes = readFileSync(resolve(engineOutDir, "main.js"));
writeFileSync(
  resolve(engineOutDir, "main.js.sha256"),
  createHash("sha256").update(mainBytes).digest("hex") + "\n",
);
log(`engine bundle ${bundle.hash} -> ${engineOutDir}`);

// 3. Full pieces catalog install. The synthesized package.json is the SAME
// shape the per-user installer writes, just spanning the whole catalog; the
// versionRange already carries any VERSION_PIN override.
const catalog = piecesLimit !== null ? CATALOG.slice(0, piecesLimit) : CATALOG;
const piecesDir = resolve(out, "pieces");
mkdirSync(piecesDir, { recursive: true });
const deps: Record<string, string> = {};
for (const entry of catalog) deps[entry.npmPackage] = entry.versionRange;
writeFileSync(
  resolve(piecesDir, "package.json"),
  JSON.stringify(
    {
      name: "jarvis-shared-pieces",
      private: true,
      description: "Shared community-pieces catalog (generated by build-shared-runtime)",
      dependencies: deps,
    },
    null,
    2,
  ) + "\n",
);
if (seedLock && existsSync(seedLock)) {
  copyFileSync(seedLock, resolve(piecesDir, "bun.lock"));
  log(`seeded bun.lock from ${seedLock}`);
}
log(`installing ${catalog.length} pieces (bun cache: ${process.env.BUN_INSTALL_CACHE_DIR ?? "default"})`);
// --ignore-scripts: bun's DEFAULT-trusted list (~370 names incl. esbuild,
// sharp, better-sqlite3) would otherwise run lifecycle scripts from whatever
// npm serves — the exact npm-account-controlled-code threat install-version
// refuses for the brain package itself. A piece whose native dep genuinely
// needs a build step fails extraction VISIBLY (failures[]) instead.
// process.execPath: never resolve the interpreter via PATH in a build.
const install = spawnSync(process.execPath, ["install", "--silent", "--ignore-scripts"], {
  cwd: piecesDir,
  stdio: ["ignore", "inherit", "inherit"],
});
if (install.status !== 0) {
  console.error(`bun install failed (exit ${install.status})`);
  process.exit(1);
}

// 4. Metadata extraction for the WHOLE tree (vendored + shared catalog),
// written as the per-entry cache instances mount read-only. No overall
// deadline: this is a build machine, not a tenant boot — completeness wins.
const api = new SandboxApi({ services: { credentialResolver: new CredentialResolver() } });
await api.start({ host: "127.0.0.1", port: 0 });
// customPiecesPaths mirrors engine-bootstrap: the ENGINE resolves piece
// modules through these roots (each root's node_modules), independent of the
// discovery walk below — without the pieces dir here every community piece
// extraction dies with INTERNAL_ERROR.
const runtime = new EngineRuntime({
  api,
  bundlePath: bundle.bundlePath,
  pool: false,
  customPiecesPaths: [resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces"), piecesDir],
});
const pieceRoots = [
  resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis"),
  resolve(piecesDir, "node_modules/@activepieces"),
];
const cacheFile = resolve(out, "piece-metadata.json");
const { catalog: built, failures } = await buildPieceCatalog({
  runtime,
  pieceRoots,
  cacheFile,
  cacheKey: computeCatalogCacheKey({ bundlePath: bundle.bundlePath }),
  pieceTimeoutMs: 30_000,
  overallTimeoutMs: 6 * 60 * 60 * 1000,
  reporter: (m) => log(m),
});
await runtime.shutdown();
await api.stop();

// 5. Machine-readable summary — written to --summary when given (stdout is
// best-effort only; engine-child passthrough can interleave with it).
const summary =
  JSON.stringify({
    out,
    engineHash: bundle.hash,
    pieces: catalog.length,
    extracted: built.list().length,
    failures: failures.map((f) => ({ piece: `${f.pieceName}@${f.pieceVersion}`, reason: f.reason })),
    cacheFile,
    elapsedMs: Date.now() - t0,
  });
if (summaryPath) writeFileSync(resolve(summaryPath), summary + "\n");
console.log(summary);
