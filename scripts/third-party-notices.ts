#!/usr/bin/env bun
/**
 * Generate, or check, the notices for the third-party code compiled into the
 * UI bundle and the engine/piece bundles (#1166). See
 * src/workflows/pieces-library/bundle-notices.ts for what each covers.
 *
 *   bun run scripts/third-party-notices.ts                 # write both
 *   bun run scripts/third-party-notices.ts ui              # write one
 *   bun run scripts/third-party-notices.ts --check         # exit 1 when either is stale
 *   bun run scripts/third-party-notices.ts engine --staging <dir>
 *
 * The engine notices need the engine staging install, which `bun install`s
 * from the registry; `--staging` names an existing or scratch staging dir
 * (default: the per-user build cache, as the engine build uses).
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  ENGINE_NOTICES_FILE,
  UI_ENTRYPOINTS,
  UI_NOTICES_FILE,
  engineBundleNotices,
  uiBundleNotices,
  type BundleNotices,
} from "../src/workflows/pieces-library/bundle-notices";
import { ENGINE_BUILD_PATHS, ensureStagingInstalled } from "../src/workflows/runner/engine-runtime/build";

const ROOT = resolve(import.meta.dir, "..");

/**
 * Every module `bun run build:ui` compiles in, relative to `repoRoot`: the
 * same `bun build` command, into a throwaway directory, with a metafile.
 * A subprocess rather than Bun.build: called inside `bun test`, the first
 * Bun.build of the HTML entry points failed to resolve their own
 * `./src/main.tsx` (bun 1.3.8, reproduced), and the CLI is what ships anyway.
 */
export function uiBuildInputs(repoRoot: string): string[] {
  const root = realpathSync(repoRoot);
  const out = mkdtempSync(join(tmpdir(), "jarvis-ui-notices-"));
  try {
    const meta = join(out, "meta.json");
    const r = Bun.spawnSync([process.execPath, "build", ...UI_ENTRYPOINTS, "--outdir", join(out, "dist"), `--metafile=${meta}`], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) throw new Error(`the UI build failed (exit ${r.exitCode}): ${r.stderr.toString().slice(-2000)}`);
    const inputs = (JSON.parse(readFileSync(meta, "utf8")) as { inputs?: Record<string, unknown> }).inputs;
    if (!inputs) throw new Error("the UI build wrote no metafile inputs");
    // The CLI names inputs relative to its working directory, the root.
    return Object.keys(inputs).map((k) => relative(root, resolve(root, k))).sort();
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const s = args.indexOf("--staging");
  const staging = s >= 0 ? resolve(args[s + 1] ?? ".") : ENGINE_BUILD_PATHS.STAGING_DIR;
  const which = args.filter((a, i) => (a === "ui" || a === "engine") && args[i - 1] !== "--staging");
  const targets = which.length > 0 ? which : ["ui", "engine"];

  let failed = false;
  for (const target of targets) {
    let notices: BundleNotices;
    if (target === "ui") {
      notices = uiBundleNotices(ROOT, uiBuildInputs(ROOT));
    } else {
      await ensureStagingInstalled(staging);
      notices = engineBundleNotices(staging);
    }
    const file = resolve(ROOT, target === "ui" ? UI_NOTICES_FILE : ENGINE_NOTICES_FILE);
    if (notices.problems.length > 0) {
      failed = true;
      console.error(`${target}: the notices cannot be generated:`);
      for (const p of notices.problems) console.error(`  ${p}`);
      continue;
    }
    if (check) {
      let current = "";
      try { current = readFileSync(file, "utf8"); } catch {}
      if (current !== notices.text) {
        failed = true;
        console.error(`${target}: ${file} is out of date; run bun run scripts/third-party-notices.ts ${target}`);
      } else {
        console.log(`${target}: ${notices.packages.length} package(s), up to date`);
      }
    } else {
      writeFileSync(file, notices.text);
      console.log(`${target}: wrote ${notices.packages.length} package(s) to ${file}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
