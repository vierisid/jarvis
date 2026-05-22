/**
 * Build the activepieces engine into a single CJS bundle that the daemon can
 * spawn as a child process. Mirrors upstream's `engine/esbuild.config.mjs` so
 * the bundle layout matches what the engine expects when it boots.
 *
 * Why our own builder script (instead of just calling `bun run build` in the
 * vendored engine dir): upstream's config writes to `dist/packages/engine/`
 * relative to the activepieces monorepo root, and it relies on `workspace:*`
 * deps being installed by the upstream pnpm workspace. We don't have that
 * workspace; instead, we synthesize a small staging directory containing only
 * the engine's third-party deps, install them with `bun install`, then run
 * esbuild with explicit aliases pointing the workspace deps at the vendored
 * source we already shipped in `src/workflows/activepieces/`.
 *
 * Staging lives outside the repo (under `~/.jarvis/cache/engine-build`) so
 * `node_modules` from the engine build never pollutes the project tree.
 *
 * Bundle output is content-addressed: hash of the synthesized package.json +
 * UPSTREAM.md (which pins the activepieces commit). Re-running with the same
 * inputs short-circuits to the cached bundle.
 */

import { spawn } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { UPSTREAM_PIN_SHA, UPSTREAM_PIN_TAG } from "../../activepieces/upstream-pin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, "../../../..");
const VENDOR_PACKAGES = resolve(REPO_ROOT, "src/workflows/activepieces/packages");
const ENGINE_DIR = resolve(VENDOR_PACKAGES, "server/engine");

const CACHE_ROOT = resolve(homedir(), ".jarvis/cache");
const STAGING_DIR = resolve(CACHE_ROOT, "engine-build");
const BUNDLE_ROOT = resolve(CACHE_ROOT, "engine");

/** esbuild version pinned to match what activepieces uses upstream. */
const ESBUILD_VERSION = "0.24.0";

export interface EngineBundle {
  bundlePath: string;
  hash: string;
  /** Absolute path to the directory containing the bundle (useful as cwd for the spawned engine). */
  bundleDir: string;
}

/**
 * Workspace package.json files whose third-party deps the engine bundle
 * pulls in transitively. Their `workspace:*` references are resolved by
 * esbuild aliases (see `buildEngineBundle` below) so we only collect their
 * non-workspace dependencies.
 */
const WORKSPACE_PKG_RELS = [
  "server/engine/package.json",
  "shared/package.json",
  "pieces/framework/package.json",
  "pieces/common/package.json",
] as const;

/**
 * Synthesize the staging-dir package.json: union of every non-workspace dep
 * across the four workspace packages the engine bundle imports, plus esbuild.
 * On version conflict, the latest entry wins -- we'd flag in CI if this ever
 * matters, but in practice the workspace pkgs all share pinned versions.
 */
function buildStagingPackageJson(): string {
  const deps: Record<string, string> = {};
  for (const rel of WORKSPACE_PKG_RELS) {
    const pkg = JSON.parse(
      readFileSync(resolve(VENDOR_PACKAGES, rel), "utf8"),
    ) as { dependencies?: Record<string, string> };
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (!String(version).startsWith("workspace:")) {
        deps[name] = version;
      }
    }
  }
  deps["esbuild"] = ESBUILD_VERSION;

  return JSON.stringify(
    {
      name: "jarvis-engine-build-staging",
      private: true,
      type: "commonjs",
      dependencies: deps,
    },
    null,
    2,
  );
}

/**
 * Vendored engine source files we patch directly in this fork. Their content
 * MUST flow into the bundle hash, otherwise a patch (e.g., the piece-loader
 * shared-`node_modules` discovery branch) would be served stale from cached
 * bundles. Listed explicitly -- relative to VENDOR_PACKAGES -- so adding a
 * new patch is a one-line cache-invalidation registration.
 */
const PATCHED_VENDOR_SOURCES = [
  "server/engine/src/lib/helper/piece-loader.ts",
  // Jarvis-only `outputSample` extension on actions + the matching
  // ActionBase change. Hand-edits to these files (or a sync that
  // re-applies the patch in a different shape) must invalidate the
  // engine bundle and, transitively, every piece's compiled output --
  // otherwise the cached bundle keeps shipping the OLD framework even
  // though the source on disk has changed.
  "pieces/framework/src/lib/action/action.ts",
  "pieces/framework/src/lib/piece-metadata.ts",
  // Jarvis-only BranchOperator additions (TEXT_MATCHES_REGEX +
  // negation) and the matching router-executor cases. Hand-edits or
  // sync re-applications change the bundle hash so the cached engine
  // doesn't ship the OLD operator list / executor.
  "shared/src/lib/automation/flows/actions/action.ts",
  "server/engine/src/lib/handler/router-executor.ts",
] as const;

/**
 * Cache key combines the synthesized package.json (which captures dep versions),
 * the vendored upstream pin (tag + SHA shipped as a generated TS constant
 * by `sync-activepieces.ts`), and the content of any vendored source files
 * we've patched. The pin replaces a runtime `readFileSync(UPSTREAM.md)`
 * that crashed on npm-installed daemons -- markdown files get filtered
 * out by `.npmignore`, but a TS constant ships as code.
 */
export function bundleHash(): string {
  const pkg = buildStagingPackageJson();
  const hasher = createHash("sha256")
    .update(pkg)
    .update("\0")
    .update(UPSTREAM_PIN_TAG)
    .update("\0")
    .update(UPSTREAM_PIN_SHA);
  for (const rel of PATCHED_VENDOR_SOURCES) {
    const content = readFileSync(resolve(VENDOR_PACKAGES, rel), "utf8");
    hasher.update("\0").update(rel).update("\0").update(content);
  }
  return hasher.digest("hex").slice(0, 16);
}

// Memoized install promise: every caller awaits the SAME pending
// `bun install` and we never spawn two concurrent installs against the
// same staging dir. Cleared on rejection so a transient failure can be
// retried by the next caller.
let stagingInstallInFlight: Promise<void> | null = null;

export function ensureStagingInstalled(): Promise<void> {
  if (stagingInstallInFlight) return stagingInstallInFlight;
  stagingInstallInFlight = (async (): Promise<void> => {
    mkdirSync(STAGING_DIR, { recursive: true });
    const pkgPath = resolve(STAGING_DIR, "package.json");
    const desired = buildStagingPackageJson();
    const existing = existsSync(pkgPath) ? readFileSync(pkgPath, "utf8") : null;
    const haveNodeModules = existsSync(resolve(STAGING_DIR, "node_modules"));
    if (existing === desired && haveNodeModules) return;

    writeFileSync(pkgPath, desired);

    await new Promise<void>((res, rej) => {
      const child = spawn("bun", ["install", "--silent"], {
        cwd: STAGING_DIR,
        stdio: "inherit",
      });
      child.on("close", (code) => {
        if (code === 0) res();
        else rej(new Error(`bun install (engine staging) exited with code ${code}`));
      });
      child.on("error", rej);
    });
  })().catch((e) => {
    stagingInstallInFlight = null;
    throw e;
  });
  return stagingInstallInFlight;
}

export async function buildEngineBundle(opts?: { force?: boolean }): Promise<EngineBundle> {
  await ensureStagingInstalled();

  const hash = bundleHash();
  const bundleDir = resolve(BUNDLE_ROOT, hash);
  const bundlePath = resolve(bundleDir, "main.js");

  if (!opts?.force && existsSync(bundlePath)) {
    return { bundlePath, hash, bundleDir };
  }

  mkdirSync(bundleDir, { recursive: true });

  const esbuildEntry = resolve(STAGING_DIR, "node_modules/esbuild/lib/main.js");
  if (!existsSync(esbuildEntry)) {
    throw new Error(
      `esbuild not found at ${esbuildEntry}. Did the staging install fail?`,
    );
  }
  // esbuild lives only in the staging dir's node_modules, so we don't take a
  // direct dep on it at the project level. Declared locally with the surface
  // we actually use rather than pulling in @types/esbuild.
  const esbuild = (await import(esbuildEntry)) as {
    build(options: Record<string, unknown>): Promise<{ metafile: unknown }>;
  };

  const result = await esbuild.build({
    entryPoints: [resolve(ENGINE_DIR, "src/main.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    outfile: bundlePath,
    format: "cjs",
    sourcemap: true,
    minifySyntax: true,
    minifyWhitespace: true,
    metafile: true,
    alias: {
      "@activepieces/shared": resolve(VENDOR_PACKAGES, "shared/src"),
      "@activepieces/pieces-framework": resolve(VENDOR_PACKAGES, "pieces/framework/src"),
      "@activepieces/pieces-common": resolve(VENDOR_PACKAGES, "pieces/common/src"),
    },
    // isolated-vm intentionally excluded -- we only run SANDBOX_PROCESS mode
    // (see SPIKE-SANDBOXING.md). utf-8-validate / bufferutil are optional ws deps.
    external: ["isolated-vm", "utf-8-validate", "bufferutil"],
    nodePaths: [resolve(STAGING_DIR, "node_modules")],
    logLevel: "warning",
  });

  writeFileSync(bundlePath + ".meta.json", JSON.stringify(result.metafile));

  return { bundlePath, hash, bundleDir };
}

export const ENGINE_BUILD_PATHS = {
  REPO_ROOT,
  VENDOR_PACKAGES,
  ENGINE_DIR,
  CACHE_ROOT,
  STAGING_DIR,
  BUNDLE_ROOT,
} as const;

/**
 * Locate an already-built engine bundle for the current source state.
 * Returns null if no matching bundle is on disk -- callers can either
 * `buildEngineBundle()` (slow on cold start) or skip the work entirely.
 */
export function findCachedBundle(): { bundlePath: string; hash: string } | null {
  // Recompute the hash from current sources; if the staging dir doesn't
  // exist yet, we have no cached bundle to find.
  if (!existsSync(resolve(STAGING_DIR, "package.json"))) return null;
  const hash = bundleHash();
  const bundlePath = resolve(BUNDLE_ROOT, hash, "main.js");
  return existsSync(bundlePath) ? { bundlePath, hash } : null;
}
