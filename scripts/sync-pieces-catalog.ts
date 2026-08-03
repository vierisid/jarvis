#!/usr/bin/env bun
/**
 * Regenerate `src/workflows/pieces-library/catalog-generated.ts` by walking
 * the activepieces monorepo at the pinned SHA + cross-checking npm for
 * the latest published version of each piece.
 *
 * Run locally:
 *   bun run scripts/sync-pieces-catalog.ts
 *   bun run scripts/sync-pieces-catalog.ts --report /tmp/pr-body.md  # preview the PR analysis
 *
 * Run in CI (weekly):
 *   .github/workflows/sync-pieces-catalog.yml
 *
 * What the script does:
 *   1. Sparse-clone activepieces at PINNED_SHA into a temp dir
 *      (sparse = packages/pieces/community only -- ~50MB vs full ~1GB).
 *   2. List every directory under packages/pieces/community/.
 *   3. For each piece, read its package.json (name, description, license).
 *   4. Query the npm registry for the latest published version.
 *      Pieces npm answers 404 for are skipped (still in development, or
 *      genuinely unpublished). Transient failures (429 / 5xx / network) that
 *      survive the retry budget do NOT drop the piece: its previously
 *      committed latestVersion is carried forward (metadata still comes from
 *      the pinned SHA), so a rate-limited CI run can never masquerade as a
 *      mass unpublish. If more than MAX_TRANSIENT_FRACTION of pieces fail
 *      transiently the whole run aborts instead of shipping a mostly-stale
 *      catalog. Retry / cooldown / classification logic lives in
 *      scripts/lib/npm-latest.ts (unit-tested).
 *   5. Build a sorted entry list and write catalog-generated.ts.
 *   6. With --report <path> (or env CATALOG_REPORT_PATH): diff against the
 *      previously-committed catalog and write a markdown PR body that calls out
 *      "safe to merge" (version bumps only) vs "manual review required" (pieces
 *      added/removed, license or SHA changes). See scripts/lib/catalog-diff.ts.
 *
 * What the script does NOT do:
 *   - Probe install size (slow, flaky in CI). Sizes come from the
 *     SIZE_OVERRIDE map in catalog-overrides.ts.
 *   - Parse piece source code for action/trigger counts (would require the
 *     TS compiler; current shape doesn't need them).
 *   - Modify the override layer. EXCLUDED / VERIFIED / pins are hand-edited.
 *
 * Network requirements: GitHub clone + ~300 npm registry GETs. Both are
 * unauthenticated-rate-limit safe. Set GITHUB_TOKEN to raise the API limit
 * if running in CI alongside other GH actions.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  diffCatalogs,
  renderReport,
  hasChanges,
  type GeneratedEntryLike,
} from "./lib/catalog-diff";
import { createNpmClient, resolveVersion } from "./lib/npm-latest";

/**
 * Activepieces commit walked when generating the list. Keep this in sync
 * with `scripts/sync-activepieces.ts` -- a mismatched SHA means the engine
 * vendored code and the catalog metadata describe different versions.
 *
 * Bumping this is intentional: review the diff in catalog-generated.ts
 * carefully (pieces may have been renamed / removed upstream).
 */
const PINNED_SHA = "d04e6807c485ecd788a72af0d04abffba78563c7";

const REPO_URL = "https://github.com/activepieces/activepieces.git";
const WORK_DIR = join(tmpdir(), `jarvis-pieces-sync-${PINNED_SHA.slice(0, 12)}`);
const OUT_FILE = resolve(import.meta.dir, "../src/workflows/pieces-library/catalog-generated.ts");

interface PieceMetadata {
  id: string;
  npmPackage: string;
  displayName: string;
  description: string;
  licenseSpdx: string;
  latestVersion: string;
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
  const reportPath = resolveReportPath();

  info(`Pinned SHA: ${PINNED_SHA}`);
  info(`Output:     ${OUT_FILE}`);
  info(`Mode:       ${checkOnly ? "check-only (no write)" : "write"}`);
  if (reportPath) info(`PR report:  ${reportPath}`);

  // Previous generation, loaded before anything can overwrite the file. Used
  // both to carry entries forward across transient npm failures and (with
  // --report) to diff for the PR body.
  const previous = await readPreviousGeneration();
  const previousById = new Map((previous?.entries ?? []).map((e) => [e.id, e]));

  // 1. Sparse-clone packages/pieces/community.
  ensureWorkdir();
  sparseClone(verbose);

  // 2. List piece directories.
  const communityDir = join(WORK_DIR, "packages/pieces/community");
  if (!existsSync(communityDir)) {
    fatal(`expected ${communityDir} to exist after sparse-clone`);
  }
  const pieceDirs = readdirSync(communityDir)
    .map((name) => join(communityDir, name))
    .filter((path) => statSync(path).isDirectory());
  info(`Found ${pieceDirs.length} piece folders under packages/pieces/community/`);

  // 3+4. Read package.json + cross-check npm in parallel.
  const found: PieceMetadata[] = [];
  const carriedForward: Array<{ id: string; version: string }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  let transientFailures = 0;
  const npmConcurrency = 8;
  for (let i = 0; i < pieceDirs.length; i += npmConcurrency) {
    const batch = pieceDirs.slice(i, i + npmConcurrency);
    const results = await Promise.all(
      batch.map((dir) => extractPiece(dir, verbose, previousById)),
    );
    for (const r of results) {
      if (r.kind === "ok") {
        found.push(r.entry);
      } else if (r.kind === "carried-forward") {
        found.push(r.entry);
        carriedForward.push({ id: r.entry.id, version: r.entry.latestVersion });
        transientFailures++;
      } else {
        skipped.push({ id: r.id, reason: r.reason });
        if (r.transient) transientFailures++;
      }
    }
    // If npm fails transiently for a large slice of the catalog the registry
    // is down or hard-throttling us. Carrying that many entries forward would
    // ship a mostly-stale catalog while looking like a routine refresh --
    // abort (checked per batch so a dead registry fails in minutes, not after
    // grinding through every remaining retry) and let the next scheduled run
    // try again instead.
    if (transientFailures > pieceDirs.length * MAX_TRANSIENT_FRACTION) {
      fatal(
        `npm failed transiently for ${transientFailures} of ${pieceDirs.length} pieces ` +
          `(> ${MAX_TRANSIENT_FRACTION * 100}%) -- registry down or rate-limited, aborting`,
      );
    }
  }

  // Sort alphabetically by id for stable diffs.
  found.sort((a, b) => a.id.localeCompare(b.id));

  info(`Pieces resolved on npm: ${found.length}`);
  if (carriedForward.length > 0) {
    info(`  of which carried forward on transient npm failure: ${carriedForward.length}`);
  }
  info(`Pieces skipped:         ${skipped.length}`);
  if (verbose && skipped.length > 0) {
    for (const s of skipped) console.log(`  - ${s.id}: ${s.reason}`);
  }

  // 5. Render + (optionally) analyse the diff for the auto-PR body.
  const rendered = renderCatalogFile(found);
  if (reportPath) {
    await writePrReport(reportPath, previous, found, rendered, carriedForward);
  }

  if (checkOnly) {
    const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, "utf8") : "";
    if (current === rendered) {
      info("catalog-generated.ts is up to date.");
      process.exit(0);
    }
    console.error("catalog-generated.ts is out of date.");
    console.error("Run `bun run scripts/sync-pieces-catalog.ts` and commit.");
    process.exit(1);
  }

  writeFileSync(OUT_FILE, rendered);
  info(`Wrote ${OUT_FILE} (${found.length} entries)`);

  // Don't auto-clean WORK_DIR so subsequent local runs reuse the clone.
  // CI containers are ephemeral; nothing to leak.
}

function ensureWorkdir(): void {
  if (existsSync(WORK_DIR)) {
    // Reuse an existing clone if it's at the right SHA, otherwise wipe.
    const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: WORK_DIR, encoding: "utf8" });
    if (sha.status === 0 && sha.stdout.trim() === PINNED_SHA) {
      info(`Reusing existing clone at ${WORK_DIR}`);
      return;
    }
    info(`Wiping stale clone at ${WORK_DIR}`);
    rmSync(WORK_DIR, { recursive: true, force: true });
  }
  mkdirSync(WORK_DIR, { recursive: true });
}

function sparseClone(verbose: boolean): void {
  if (existsSync(join(WORK_DIR, ".git"))) return; // already cloned by ensureWorkdir's reuse path
  info(`Cloning ${REPO_URL} (sparse, blobless)...`);
  run("git", ["clone", "--filter=blob:none", "--sparse", REPO_URL, WORK_DIR], verbose);
  run("git", ["sparse-checkout", "set", "packages/pieces/community"], verbose, WORK_DIR);
  run("git", ["checkout", PINNED_SHA], verbose, WORK_DIR);
}

type ExtractResult =
  | { kind: "ok"; entry: PieceMetadata }
  /** npm was unreachable; the previously committed latestVersion is reused. */
  | { kind: "carried-forward"; entry: PieceMetadata }
  | { kind: "skip"; id: string; reason: string; transient?: boolean };

async function extractPiece(
  dir: string,
  verbose: boolean,
  previousById: Map<string, GeneratedEntryLike>,
): Promise<ExtractResult> {
  const dirName = dir.split("/").pop()!;
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) {
    return { kind: "skip", id: dirName, reason: "no package.json" };
  }
  let pkg: {
    name?: string;
    description?: string;
    displayName?: string;
    license?: string | { type?: string };
    version?: string;
  };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (e) {
    return { kind: "skip", id: dirName, reason: `package.json parse: ${(e as Error).message}` };
  }
  if (!pkg.name || !pkg.name.startsWith("@activepieces/piece-")) {
    return { kind: "skip", id: dirName, reason: `not an activepieces piece (name=${pkg.name})` };
  }
  const id = pkg.name.slice("@activepieces/piece-".length);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    return { kind: "skip", id, reason: "id fails [a-z][a-z0-9-]* regex" };
  }
  const license = typeof pkg.license === "string"
    ? pkg.license
    : (pkg.license?.type ?? "");
  // Some pieces don't set `displayName`; fall back to a capitalised id.
  const displayName = pkg.displayName ?? humanise(id);
  const meta = (latestVersion: string): PieceMetadata => ({
    id,
    npmPackage: pkg.name!,
    displayName,
    description: pkg.description ?? "",
    licenseSpdx: license,
    latestVersion,
  });

  // Cross-check npm. Pieces in the monorepo but not on npm are still
  // under development and we don't want to ship a catalog entry that
  // would 404 on install.
  const latest = await npm.fetchLatest(pkg.name);
  const resolution = resolveVersion(latest, previousById.get(id)?.latestVersion ?? null);
  switch (resolution.action) {
    case "use":
      if (verbose) console.log(`  ✓ ${id} (${resolution.version})`);
      return { kind: "ok", entry: meta(resolution.version) };
    case "carry-forward":
      // npm wouldn't answer. That says nothing about the piece itself, so keep
      // the version the last successful sync knew; it catches up next run.
      console.warn(
        `[warn] carrying forward ${id} at ${resolution.version} (npm unreachable: ${
          latest.kind === "transient" ? latest.error : "unknown"
        })`,
      );
      return { kind: "carried-forward", entry: meta(resolution.version) };
    case "skip":
      return { kind: "skip", id, reason: resolution.reason, transient: resolution.transient };
  }
}

/**
 * Abort the run when more than this fraction of pieces fail transiently --
 * at that point the registry is down (or throttling so hard the results are
 * meaningless) and a catalog refresh would be mostly carried-forward noise.
 */
const MAX_TRANSIENT_FRACTION = 0.1;

/**
 * Shared npm client: retry with backoff, fleet-wide 429 cooldown, tri-state
 * result. Lives in scripts/lib/npm-latest.ts so it stays unit-tested.
 */
const npm = createNpmClient();

function humanise(id: string): string {
  return id
    .split("-")
    .map((s) => (s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s))
    .join(" ");
}

function renderCatalogFile(entries: PieceMetadata[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push("/**");
  lines.push(" * AUTO-GENERATED -- DO NOT EDIT BY HAND.");
  lines.push(" *");
  lines.push(" * Regenerated by `scripts/sync-pieces-catalog.ts`. The sync script walks");
  lines.push(" * the activepieces monorepo at the pinned SHA, picks every piece whose");
  lines.push(" * `package.json` is also published to npm, and writes an entry below.");
  lines.push(" *");
  lines.push(" * To regenerate locally:   bun run scripts/sync-pieces-catalog.ts");
  lines.push(" * To regenerate in CI:     run the `sync-pieces-catalog` GitHub Action.");
  lines.push(" *");
  lines.push(" * Hand-tuning (verified status, exclusions, version pins, sizes,");
  lines.push(" * descriptions) lives in `catalog-overrides.ts` -- that file IS hand-edited");
  lines.push(" * and the two get merged in `catalog.ts`.");
  lines.push(" */");
  lines.push("");
  lines.push("export interface GeneratedCatalogEntry {");
  lines.push("  /** Stable Jarvis-side id. NEVER rename once shipped. */");
  lines.push("  id: string;");
  lines.push("  /** Full npm package name. */");
  lines.push("  npmPackage: string;");
  lines.push("  /** Default semver range using `^` against `latestVersion`. */");
  lines.push("  versionRange: string;");
  lines.push("  /** Exact latest version found on npm at generation time. */");
  lines.push("  latestVersion: string;");
  lines.push("  /** Upstream package.json `displayName` field, falls back to the id. */");
  lines.push("  displayName: string;");
  lines.push("  /** Upstream package.json `description` field; may be empty. */");
  lines.push("  description: string;");
  lines.push("  /** GitHub URL to the piece's source folder at the pinned SHA. */");
  lines.push("  sourceUrl: string;");
  lines.push("  /** SPDX identifier per upstream package.json `license`; empty when missing. */");
  lines.push("  licenseSpdx: string;");
  lines.push("}");
  lines.push("");
  lines.push("/** Timestamp of the last generation pass (ISO date). */");
  lines.push(`export const GENERATED_AT = ${JSON.stringify(today)};`);
  lines.push("");
  lines.push("/** Activepieces commit the script walked when generating this list. */");
  lines.push(`export const GENERATED_FROM_SHA = ${JSON.stringify(PINNED_SHA)};`);
  lines.push("");
  lines.push("export const GENERATED: GeneratedCatalogEntry[] = [");
  for (const e of entries) {
    const versionRange = `^${e.latestVersion}`;
    const sourceUrl = sourceUrlFor(e.id);
    lines.push("  {");
    lines.push(`    id: ${JSON.stringify(e.id)},`);
    lines.push(`    npmPackage: ${JSON.stringify(e.npmPackage)},`);
    lines.push(`    versionRange: ${JSON.stringify(versionRange)},`);
    lines.push(`    latestVersion: ${JSON.stringify(e.latestVersion)},`);
    lines.push(`    displayName: ${JSON.stringify(e.displayName)},`);
    lines.push(`    description: ${JSON.stringify(e.description)},`);
    lines.push(`    sourceUrl: ${JSON.stringify(sourceUrl)},`);
    lines.push(`    licenseSpdx: ${JSON.stringify(e.licenseSpdx)},`);
    lines.push("  },");
  }
  lines.push("];");
  lines.push("");
  return lines.join("\n");
}

/** GitHub source URL for a piece folder at the pinned SHA. */
function sourceUrlFor(id: string): string {
  return `https://github.com/activepieces/activepieces/tree/${PINNED_SHA}/packages/pieces/community/${id}`;
}

// ─── PR diff report ────────────────────────────────────────────────────────
//
// When `--report <path>` (or env CATALOG_REPORT_PATH) is set, the script diffs
// the freshly generated catalog against the previously-committed one and writes
// a markdown PR body to that path. The sync workflow feeds it to
// peter-evans/create-pull-request via `body-path`, so reviewers get an
// up-front "safe to merge" vs "manual review required" verdict instead of a
// raw diff. See scripts/lib/catalog-diff.ts for the analysis itself.

/** Where to write the PR-body markdown, or null when reporting is off. */
function resolveReportPath(): string | null {
  const idx = process.argv.indexOf("--report");
  const next = idx !== -1 ? process.argv[idx + 1] : undefined;
  // Ignore a missing value or an accidental following flag (`--report --verbose`).
  const fromFlag = next && !next.startsWith("--") ? next : undefined;
  const raw = fromFlag ?? process.env.CATALOG_REPORT_PATH;
  return raw ? resolve(raw) : null;
}

interface PreviousGeneration {
  entries: GeneratedEntryLike[];
  sha: string;
}

/**
 * Load the previously-committed catalog for diffing. Imports the on-disk
 * generated module (so we get the structured entries, not a regex parse).
 * MUST be called before the file is overwritten. Returns null on first run or
 * if the old file can't be read -- the diff then treats everything as added.
 */
async function readPreviousGeneration(): Promise<PreviousGeneration | null> {
  if (!existsSync(OUT_FILE)) return null;
  try {
    const mod = (await import(pathToFileURL(OUT_FILE).href)) as {
      GENERATED?: GeneratedEntryLike[];
      GENERATED_FROM_SHA?: string;
    };
    return { entries: mod.GENERATED ?? [], sha: mod.GENERATED_FROM_SHA ?? "" };
  } catch (e) {
    console.warn(`[warn] could not read previous catalog for diff: ${(e as Error).message}`);
    return null;
  }
}

/** Map each id to its 1-based line in the rendered file (for `path:Lnn` refs). */
function buildLineIndex(rendered: string): Map<string, number> {
  const index = new Map<string, number>();
  const lines = rendered.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^    id: "(.+)",$/.exec(lines[i]!);
    if (m) index.set(m[1]!, i + 1);
  }
  return index;
}

/** Build the new catalog in the diff's shape (versionRange + sourceUrl derived). */
function toGeneratedEntries(found: PieceMetadata[]): GeneratedEntryLike[] {
  return found.map((e) => ({
    id: e.id,
    npmPackage: e.npmPackage,
    versionRange: `^${e.latestVersion}`,
    latestVersion: e.latestVersion,
    displayName: e.displayName,
    description: e.description,
    sourceUrl: sourceUrlFor(e.id),
    licenseSpdx: e.licenseSpdx,
  }));
}

/** Render the PR body, write it to `reportPath`, and surface the verdict. */
async function writePrReport(
  reportPath: string,
  previous: PreviousGeneration | null,
  found: PieceMetadata[],
  rendered: string,
  carriedForward: Array<{ id: string; version: string }>,
): Promise<void> {
  const diff = diffCatalogs(previous?.entries ?? [], toGeneratedEntries(found), {
    oldSha: previous?.sha ?? "",
    newSha: PINNED_SHA,
  });
  const lineIndex = buildLineIndex(rendered);
  const { verdict, markdown } = renderReport(diff, {
    shortSha: PINNED_SHA.slice(0, 7),
    generatedAt: new Date().toISOString().slice(0, 10),
    fileLabel: "src/workflows/pieces-library/catalog-generated.ts",
    lineOf: (id) => lineIndex.get(id) ?? null,
    carriedForward,
  });

  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, markdown);
  const changed = hasChanges(diff);
  info(`Wrote PR report to ${reportPath} (verdict: ${verdict}, changes: ${changed})`);
  if (!changed) {
    info("No catalog updates beyond the timestamp -- the workflow will skip the PR.");
  }

  // When running under GitHub Actions, expose the verdict + whether anything
  // material changed as step outputs. The workflow titles the PR from `verdict`
  // and gates PR creation on `has_changes`. Harmless no-op locally.
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    try {
      appendFileSync(githubOutput, `verdict=${verdict}\nhas_changes=${changed}\n`);
    } catch (e) {
      console.warn(`[warn] could not write GITHUB_OUTPUT: ${(e as Error).message}`);
    }
  }
}

function run(cmd: string, args: string[], verbose: boolean, cwd?: string): void {
  const opts: { encoding: "utf8"; cwd?: string; stdio?: "inherit" | "pipe" } = {
    encoding: "utf8",
    stdio: verbose ? "inherit" : "pipe",
  };
  if (cwd !== undefined) opts.cwd = cwd;
  const r = spawnSync(cmd, args, opts);
  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").toString().trim();
    fatal(`${cmd} ${args.join(" ")} failed: ${stderr}`);
  }
}

function info(msg: string): void {
  console.log(`[sync-pieces-catalog] ${msg}`);
}

function fatal(msg: string): never {
  console.error(`[sync-pieces-catalog] FATAL: ${msg}`);
  process.exit(1);
}

await main();
