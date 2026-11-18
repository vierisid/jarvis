#!/usr/bin/env bun
/**
 * CLI: build EVERY per-version shared runtime artifact for multi-tenant
 * hosting (the VPS's install-version wrapper calls this from the freshly
 * installed tree, with HOME pointed at a scratch dir):
 *
 *   <out>/engine/<hash>/main.js(+.map,.meta.json)   read-only shared bundle
 *                                                   (JARVIS_ENGINE_CACHE_ROOT)
 *   <out>/pieces/{package.json,bun.lock,node_modules/}
 *                                                   full community catalog
 *                                                   (JARVIS_SHARED_PIECES_DIR)
 *   <out>/pieces/THIRD_PARTY_NOTICES.md             generated license notices
 *                                                   for that tree (#971)
 *   <out>/piece-metadata.json                       prebuilt per-entry cache
 *                                                   (JARVIS_PIECE_METADATA_CACHE)
 *
 * In one pass by default, or in two runs a host puts a seal between (#862):
 *
 *   --install-only   the engine bundle and the catalog install, and nothing
 *                    that runs a piece. Writes <out>/engine and <out>/pieces.
 *   --extract-only --from <dir>
 *                    the license gate and the metadata extraction, against
 *                    <dir>/engine and <dir>/pieces as an --install-only run
 *                    wrote them, which must by then be root-owned and not
 *                    writable by this process (it refuses otherwise). Writes
 *                    <out>/piece-metadata.json and <out>/THIRD_PARTY_NOTICES.md
 *                    and nothing else, so the pieces it runs, at its uid, can
 *                    change neither the engine nor each other.
 *
 * The one pass runs every catalog piece at the uid that owns everything it
 * wrote, so it pins the engine to the digest it built (handed out on
 * --digest-fd before any piece runs, and `engineDigest` in the summary) and
 * refuses if the artifact changed while they ran, but it cannot vouch for
 * anything written after, nor for the pieces tree or the metadata. See
 * docs/shared-runtime-integrity.md for what the host must check.
 *
 * The caller controls delta-efficiency via the environment: a persistent
 * BUN_INSTALL_CACHE_DIR makes unchanged packages hardlink instead of
 * download, and seeding <out>/pieces/bun.lock from the PREVIOUS version
 * (--seed-lock) keeps unchanged catalog ranges pinned so only genuinely
 * changed pieces resolve anew. The one pass warms the transpiler cache
 * BUN_RUNTIME_TRANSPILER_CACHE_PATH names, which makes every entry in it the
 * work of a process running every catalog piece: a host must not serve it.
 * --extract-only never warms it.
 *
 * Usage:
 *   bun run scripts/build-shared-runtime.ts --out /tmp/shared-runtime
 *     [--install-only | --extract-only --from DIR]
 *     [--pieces N]           only the first N catalog entries (dev/CI smoke)
 *     [--seed-lock PATH]     previous version's pieces bun.lock (not with --extract-only)
 *     [--summary PATH]       write the JSON summary there too
 *     [--digest-fd N]        write the engine sha256 to inherited fd N and
 *                            close it before any piece runs (#862; not with
 *                            --extract-only)
 *
 * Exit 0 with a JSON summary on stdout (including per-piece extraction
 * failures — the CALLER decides how many failures are acceptable); exit 1
 * when the build itself cannot complete, and when the license policy denies
 * any package the install put in the shared tree (#971): that tree is what
 * we run for every tenant, so it fails whole rather than shipping without a
 * piece nobody chose to drop. Pieces left out on purpose are EXCLUDED
 * (everywhere) or SHARED_BUILD_EXCLUDED (hosted only) in catalog-overrides.ts.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildEngineBundle, ENGINE_BUILD_PATHS, verifiedSharedBundle } from "../src/workflows/runner/engine-runtime/build";
import { buildAllVendoredPieces, loadedCorePieceDirs } from "../src/workflows/runner/engine-runtime/build-pieces";
import { EngineRuntime } from "../src/workflows/runner/engine-runtime/engine-runtime";
import { handOutDigestToFd, publishSharedEngine } from "../src/workflows/runner/engine-runtime/shared-engine-publish";
import { sealViolations, sharedBuildPhase } from "../src/workflows/runner/engine-runtime/shared-build-phases";
import { SandboxApi } from "../src/workflows/sandbox-api/server";
import { CredentialResolver } from "../src/workflows/credentials/adapter";
import { sharedBuildCatalog, sharedBuildExclusions } from "../src/workflows/pieces-library/catalog";
import type { CatalogEntry } from "../src/workflows/pieces-library/catalog";
import { checkSharedTreeLicenses, sharedPiecesPackageJson } from "../src/workflows/pieces-library/shared-build";
import {
  buildPieceCatalog,
  computeCatalogCacheKey,
} from "../src/workflows/runtime/piece-catalog";

const USAGE =
  "usage: build-shared-runtime --out <dir> [--install-only | --extract-only --from <dir>] " +
  "[--pieces N] [--seed-lock PATH] [--summary PATH] [--digest-fd N]";

function flagValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const phaseArg = sharedBuildPhase(process.argv);
if ("error" in phaseArg) {
  console.error(`${phaseArg.error}\n${USAGE}`);
  process.exit(1);
}
const phase = phaseArg.phase;
const outArg = flagValue("--out");
if (!outArg) {
  console.error(USAGE);
  process.exit(1);
}
const out = resolve(outArg);
const fromArg = flagValue("--from");
if (phase === "extract" && (!fromArg || fromArg.startsWith("--"))) {
  console.error(`--from needs a directory\n${USAGE}`);
  process.exit(1);
}
const from = fromArg ? resolve(fromArg) : null;
const piecesLimit = flagValue("--pieces") ? Number(flagValue("--pieces")) : null;
if (piecesLimit !== null && (!Number.isInteger(piecesLimit) || piecesLimit < 0)) {
  console.error(`invalid --pieces: ${flagValue("--pieces")}`);
  process.exit(1);
}
const seedLock = flagValue("--seed-lock");
// --summary: the machine-readable report. Builder stdout is NOT JSON-clean
// (engine children's stdout is forwarded with a prefix), so callers that need
// the summary read the file, never the stream. Neither is a trustworthy source
// for the engine digest: pieces run at this uid and can write both (#862).
const summaryPath = flagValue("--summary");
// --digest-fd N: an fd the caller opened (a pipe it reads), to which the engine
// digest is written and which is then CLOSED, all before any catalog piece
// runs. Once closed, no process can write to that pipe through this one, so
// what the caller reads is the build's own value (#862). This is the channel
// hosting should pin main.js to; see docs/shared-runtime-integrity.md.
const digestFdArg = flagValue("--digest-fd");
const digestFd = digestFdArg === null ? null : Number(digestFdArg);
if (digestFd !== null && (!Number.isInteger(digestFd) || digestFd < 3)) {
  console.error(`invalid --digest-fd: ${digestFdArg} (an inherited fd >= 3)`);
  process.exit(1);
}

const log = (m: string) => console.error(`[shared-runtime] ${m}`);

// --extract-only runs pieces against a tree it must not be able to change.
// Checked before anything else, the out dir included: nothing about a run
// against an unsealed tree is worth doing.
const piecesDirFrom = from ? resolve(from, "pieces") : null;
const engineRootFrom = from ? resolve(from, "engine") : null;
if (phase === "extract") {
  const unsealed = sealViolations([
    engineRootFrom!,
    piecesDirFrom!,
    resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces"),
  ]);
  if (unsealed.length > 0) {
    log("REFUSING to extract: the tree the pieces would run from is not sealed against this process (#862):");
    for (const line of unsealed) log(`  ${line}`);
    log("Seal it first: a root-owned copy nothing but root can write, then run --extract-only as an unprivileged account.");
    process.exit(1);
  }
}

// Refuse a dirty output dir: stale artifacts from a previous run (a different
// catalog subset, an older engine hash) would be swept into the shared tree.
if (existsSync(out) && readdirSync(out).length > 0) {
  console.error(`--out ${out} exists and is not empty — pass a fresh directory`);
  process.exit(1);
}

const t0 = Date.now();

// The shared build's catalog leaves out SHARED_BUILD_EXCLUDED, the pieces whose
// dependencies the license policy denies (#971); the catalog never has
// EXCLUDED pieces. The versionRange already carries any VERSION_PIN override.
function catalogForThisBuild(): CatalogEntry[] {
  const fullCatalog = sharedBuildCatalog();
  return piecesLimit !== null ? fullCatalog.slice(0, piecesLimit) : fullCatalog;
}

// 3. Full pieces catalog install. The synthesized package.json is the SAME
// shape the per-user installer writes, just spanning the whole catalog.
function installCatalog(piecesDir: string, catalog: readonly CatalogEntry[]): void {
  mkdirSync(piecesDir, { recursive: true });
  writeFileSync(resolve(piecesDir, "package.json"), sharedPiecesPackageJson(catalog));
  if (seedLock && existsSync(seedLock)) {
    copyFileSync(seedLock, resolve(piecesDir, "bun.lock"));
    log(`seeded bun.lock from ${seedLock}`);
  }
  log(`installing ${catalog.length} pieces (bun cache: ${process.env.BUN_INSTALL_CACHE_DIR ?? "default"})`);
  // --ignore-scripts: bun's DEFAULT-trusted list (~370 names incl. esbuild,
  // sharp, better-sqlite3) would otherwise run lifecycle scripts from whatever
  // npm serves -- the exact npm-account-controlled-code threat install-version
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
}

// 3b. License gate (#971), on what bun actually installed: every package in
// the tree, the piece releases the ranges resolved to and all they pulled in.
// Always before step 4, so a refused tree never has a piece run, and so the
// notices are rendered from the tree as npm delivered it: they are held in
// memory and written after step 4, not left on disk for the pieces to rewrite
// (the #862 reasoning). Under --extract-only the tree is sealed, so what the
// gate passes is what every tenant gets.
// `--pieces 0` installs nothing, and bun writes no bun.lock for that; only
// that dev smoke may run the gate without one (the gate refuses it otherwise).
function gateLicenses(piecesDir: string, catalog: readonly CatalogEntry[]) {
  const licenses = checkSharedTreeLicenses(piecesDir, catalog, { lockfile: piecesLimit === 0 ? "if-present" : "required" });
  if (!licenses.ok) {
    log(`REFUSING to build: the license check found ${licenses.problems.length} problem(s) in the shared tree (#971):`);
    for (const line of licenses.problems) log(`  ${line}`);
    log("Fix the dependency, record a reviewed license in license-policy.ts, or leave the piece out: SHARED_BUILD_EXCLUDED for the hosted tree only, EXCLUDED for everywhere.");
    process.exit(1);
  }
  log(`licenses: ${licenses.packages} package(s) allowed`);
  // Say what the hosted tree leaves out, every build, so it is never silent.
  for (const [id, why] of Object.entries(sharedBuildExclusions())) log(`licenses: left out of the shared tree: ${id} (${why})`);
  for (const k of licenses.unusedReviewed) log(`licenses: reviewed entry ${k} matched nothing in this tree`);
  return licenses;
}

// 4. Metadata extraction for the WHOLE tree (vendored + shared catalog),
// written as the per-entry cache instances mount read-only. No overall
// deadline: this is a build machine, not a tenant boot -- completeness wins.
async function extractMetadata(opts: {
  bundlePath: string;
  digest: string;
  piecesDir: string;
  cacheFile: string;
  warmTranspilerCache: boolean;
}) {
  const api = new SandboxApi({ services: { credentialResolver: new CredentialResolver() } });
  await api.start({ host: "127.0.0.1", port: 0 });
  // customPiecesPaths mirrors engine-bootstrap: the ENGINE resolves piece
  // modules through these roots (each root's node_modules), independent of the
  // discovery walk below -- without the pieces dir here every community piece
  // extraction dies with INTERNAL_ERROR.
  const runtime = new EngineRuntime({
    api,
    bundlePath: opts.bundlePath,
    expectedDigest: opts.digest,
    // The one pass warms the cache its header describes: without this a pinned
    // engine refuses a cache directory this uid can write (#835), and the
    // directory being warmed is by definition one the builder can write.
    // --extract-only never does: every entry would be the work of a process
    // running every catalog piece.
    warmTranspilerCache: opts.warmTranspilerCache,
    pool: false,
    customPiecesPaths: [resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces"), opts.piecesDir],
  });
  const pieceRoots = [
    resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis"),
    ...loadedCorePieceDirs(),
    resolve(opts.piecesDir, "node_modules/@activepieces"),
  ];
  const { catalog: built, failures } = await buildPieceCatalog({
    runtime,
    pieceRoots,
    cacheFile: opts.cacheFile,
    cacheKey: computeCatalogCacheKey({ bundlePath: opts.bundlePath }),
    // 10s, not 30. Measured on a hosted host over the real installed tree, the
    // slowest piece in the catalog's first forty extracts in 1.2s and the median
    // in about 0.3s, cold transpiler cache or warm -- so this is still eight
    // times the worst case observed. It is not a budget for slow pieces; it is
    // how long the build waits before deciding an engine has stopped answering,
    // and it is paid in FULL every time that happens. At 30s the full catalog
    // spends about fourteen minutes waiting, inside an install op that gives up
    // at thirty.
    pieceTimeoutMs: 10_000,
    overallTimeoutMs: 6 * 60 * 60 * 1000,
    reporter: (m) => log(m),
  });
  await runtime.shutdown();
  await api.stop();
  return { built, failures };
}

// Write the summary to --summary when given (stdout is best-effort only;
// engine-child passthrough can interleave with it).
function emitSummary(summary: Record<string, unknown>): void {
  const line = JSON.stringify({ ...summary, elapsedMs: Date.now() - t0 });
  if (summaryPath) writeFileSync(resolve(summaryPath), line + "\n");
  console.log(line);
}

// 6. A build that GAVE UP must not look like a build that finished.
//
// buildPieceCatalog ends early when the engine stops answering, and marks the
// pieces it never tried. Exiting 0 here would publish that partial cache under
// a cacheKey that MATCHES the daemon's, so every consumer treats it as
// complete: install-version moves it into place, the tenant-side
// "does not match this daemon's catalog key" warning never fires, and every
// instance on the host silently re-extracts the hundreds of missing pieces at
// its own boot -- the fleet-wide storm that shared cache exists to prevent.
//
// Failing is the loud option, and the summary already names every piece and
// why. Individual broken pieces stay non-fatal: a catalog is expected to carry
// some, and `failures` reports them.
function refuseIfGaveUp(failures: readonly { reason: string }[], pieces: number): void {
  const unattempted = failures.filter((f) => f.reason.startsWith("not attempted"));
  if (unattempted.length > 0) {
    log(
      `REFUSING to publish: the catalog build gave up with ${unattempted.length} of ` +
        `${pieces} piece(s) never attempted. The metadata cache would be partial ` +
        `but indistinguishable from a complete one. See failures[] in the summary.`,
    );
    process.exit(1);
  }
}

if (phase === "extract") {
  // The engine the host sealed, for THIS tree's build hash, verified against
  // the manifest root wrote beside it. Never a build: this run may not write
  // anything a tenant executes.
  const sealed = verifiedSharedBundle(engineRootFrom!);
  if (!sealed || !sealed.digest) {
    log(`REFUSING to extract: ${engineRootFrom} holds no verified engine bundle for this tree's build hash`);
    process.exit(1);
  }
  const catalog = catalogForThisBuild();
  const licenses = gateLicenses(piecesDirFrom!, catalog);
  mkdirSync(out, { recursive: true });
  const cacheFile = resolve(out, "piece-metadata.json");
  const { built, failures } = await extractMetadata({
    bundlePath: sealed.bundlePath,
    digest: sealed.digest,
    piecesDir: piecesDirFrom!,
    cacheFile,
    warmTranspilerCache: false,
  });
  // Exclusive create into this run's own dir: a file or link a piece planted
  // there fails the build instead of being written through.
  const noticesPath = resolve(out, "THIRD_PARTY_NOTICES.md");
  writeFileSync(noticesPath, licenses.notices!, { flag: "wx" });
  log(`licenses: notices for the shared tree at ${noticesPath}`);
  emitSummary({
    phase,
    out,
    from,
    engineHash: sealed.hash,
    engineDigest: sealed.digest,
    pieces: catalog.length,
    extracted: built.list().length,
    failures: failures.map((f) => ({ piece: `${f.pieceName}@${f.pieceVersion}`, reason: f.reason })),
    cacheFile,
    licenses: {
      packages: licenses.packages,
      weakCopyleft: licenses.weakCopyleft,
      reviewed: licenses.reviewed,
      excluded: sharedBuildExclusions(),
      notices: noticesPath,
    },
  });
  refuseIfGaveUp(failures, catalog.length);
  process.exit(0);
}

// 1. Vendored pieces (Jarvis's own and the loaded core pieces, #961) must be
// compiled before metadata extraction (they normally ship prebuilt; on a
// source checkout this builds them).
await buildAllVendoredPieces();

// 2. Engine bundle -> <out>/engine/<hash>/ (the whole content-addressed dir,
// so instances resolve it by the same hash they compute from the install).
// force: a build must always BE a build — without it a stray
// JARVIS_ENGINE_CACHE_ROOT in the builder's env would turn this into a copy
// of a pre-existing, unverified bundle.
const bundle = await buildEngineBundle({ force: true });
const engineOutDir = resolve(out, "engine", bundle.hash);
mkdirSync(engineOutDir, { recursive: true });
// The copy and its content manifest (main.js.sha256; the dir NAME is a hash of
// build INPUTS, not of main.js) are handled by publishSharedEngine around step
// 4, because the one pass runs every catalog piece at this uid in step 4
// (#862): the manifest is written only AFTER extraction, from the digest the
// build computed in memory, and only if nothing in the copied artifact changed
// meanwhile. --install-only runs no piece, and goes through it all the same.

const handOutDigest = (digest: string): void => {
  if (digestFd !== null) handOutDigestToFd(digestFd, digest);
};
const piecesDir = resolve(out, "pieces");
const { result: extraction, engineDigest } = await publishSharedEngine(bundle, engineOutDir, async () => {
  const catalog = catalogForThisBuild();
  installCatalog(piecesDir, catalog);
  if (phase === "install") return null;
  const licenses = gateLicenses(piecesDir, catalog);
  const cacheFile = resolve(out, "piece-metadata.json");
  const { built, failures } = await extractMetadata({
    bundlePath: bundle.bundlePath,
    digest: bundle.digest!,
    piecesDir,
    cacheFile,
    warmTranspilerCache: true,
  });
  return { catalog, cacheFile, built, failures, licenses };
}, handOutDigest);
log(`engine bundle ${bundle.hash} -> ${engineOutDir} (sha256 ${engineDigest}${phase === "all" ? ", unchanged by extraction" : ""})`);

if (extraction === null) {
  // --install-only: nothing ran that could have changed the tree; the host
  // seals it and runs --extract-only against the sealed copy.
  emitSummary({ phase, out, engineHash: bundle.hash, engineDigest, pieces: catalogForThisBuild().length });
  process.exit(0);
}

const { catalog, cacheFile, built, failures, licenses } = extraction;
const noticesPath = resolve(out, "pieces", "THIRD_PARTY_NOTICES.md");
// Exclusive create, after checking the pieces dir is still a real directory:
// the pieces ran at this uid in step 4 and could have planted a link at this
// path, to the engine's main.js for one, which a plain write would follow
// after publishSharedEngine checked it (#862). A planted file fails the build.
if (!lstatSync(resolve(out, "pieces")).isDirectory()) {
  log("REFUSING to publish: <out>/pieces is no longer a directory after extraction");
  process.exit(1);
}
writeFileSync(noticesPath, licenses.notices!, { flag: "wx" });
log(`licenses: notices for the shared tree at ${noticesPath}`);

// 5. Machine-readable summary.
emitSummary({
  phase,
  out,
  engineHash: bundle.hash,
  // The digest the build computed in memory before any piece ran (#862).
  // For the record only: this file is written after the pieces ran, at
  // their uid. Hosting pins main.js to the value from --digest-fd.
  engineDigest,
  pieces: catalog.length,
  extracted: built.list().length,
  failures: failures.map((f) => ({ piece: `${f.pieceName}@${f.pieceVersion}`, reason: f.reason })),
  cacheFile,
  // #971: what the license gate passed, and where the notices are.
  licenses: {
    packages: licenses.packages,
    weakCopyleft: licenses.weakCopyleft,
    reviewed: licenses.reviewed,
    // Pieces this hosted tree leaves out on purpose, and why (#971): the
    // ones excluded everywhere and the ones excluded from it alone.
    excluded: sharedBuildExclusions(),
    notices: noticesPath,
  },
});
refuseIfGaveUp(failures, catalog.length);
