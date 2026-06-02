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
 * Security floor for transitive deps the staging install resolves. When a
 * vendored manifest pins a dep at a version with a known advisory reachable
 * from JARVIS (e.g. axios in pieces/common feeds the HTTP node, which webhook
 * triggers can drive with untrusted internet payloads), pin it here. The floor
 * is injected into the synthesized staging package.json as a bun `overrides`
 * entry, which wins over the manifest pin during `bun install`.
 *
 * Triage when Dependabot flags a new vendored dep:
 *
 *   1. Does the dep appear in any WORKSPACE_PKG_RELS manifest as a non-dev
 *      dependency? If no -> add to .github/dependabot.yml ignore. The dep
 *      doesn't ship via this staging install; the alert is noise.
 *
 *   2. Is the vulnerability reachable from untrusted input (webhook payloads,
 *      LLM-generated workflow params, etc.)? If no -> add to ignore with a
 *      short "not reachable" note.
 *
 *   3. If reachable: is upstream already patched in a version we can sync?
 *      If yes -> bump via upstream sync. If no -> add a SECURITY_FLOOR entry
 *      here, link the advisory.
 *
 * Entries here are FLOORS, not clamps: when upstream's pin catches up to or
 * exceeds the floor, the override is skipped and the build logs a one-line
 * notice so the dead entry can be cleaned up by hand. No silent downgrade.
 */
const SECURITY_FLOOR: Record<string, string> = {
  // pieces/common pins axios@1.15.0 exact; the HTTP node uses axios for all
  // outbound requests. Webhook-triggered workflows can drive that node with
  // untrusted payload data (URLs, headers), so SSRF/DoS classes in 1.15.x
  // are reachable in production. 1.16.1 is the first patched release.
  // GHSA-3g43-6gmg-66jw, GHSA-35jp-ww65-95wh, GHSA-pf86-5x62-jrwf.
  axios: "1.16.1",
};

/**
 * Compare two pinned/range versions for the "floor satisfied?" check.
 * Tolerantly strips ^ / ~ prefixes and compares numerically. Sufficient for
 * vendored manifests which use exact pins; if upstream ever switches to
 * caret ranges we still answer "yes, floor is satisfied" correctly because
 * we compare against the minimum of the range.
 */
function versionMeetsFloor(declared: string, floor: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const parts = v.replace(/^[\^~>=<\s]+/, "").split(".");
    return [
      parseInt(parts[0] ?? "0", 10) || 0,
      parseInt(parts[1] ?? "0", 10) || 0,
      parseInt(parts[2] ?? "0", 10) || 0,
    ];
  };
  const [da, db, dc] = parse(declared);
  const [fa, fb, fc] = parse(floor);
  if (da !== fa) return da > fa;
  if (db !== fb) return db > fb;
  return dc >= fc;
}

/**
 * Synthesize the staging-dir package.json: union of every non-workspace dep
 * across the four workspace packages the engine bundle imports, plus esbuild.
 * Applies SECURITY_FLOOR via the `overrides` block when upstream's declared
 * version sits below the floor. On dep version conflict between manifests,
 * the latest entry wins -- we'd flag in CI if this ever matters, but in
 * practice the workspace pkgs all share pinned versions.
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

  const overrides: Record<string, string> = {};
  for (const [name, floor] of Object.entries(SECURITY_FLOOR)) {
    const declared = deps[name];
    if (!declared) {
      // Dep removed upstream; the floor entry is dead and can be deleted.
      console.warn(
        `[engine-build] SECURITY_FLOOR entry '${name}' has no matching dep in vendored manifests; remove it.`,
      );
      continue;
    }
    if (versionMeetsFloor(declared, floor)) {
      console.log(
        `[engine-build] SECURITY_FLOOR '${name}@${floor}' satisfied by upstream '${declared}'; remove entry.`,
      );
      continue;
    }
    overrides[name] = floor;
  }

  return JSON.stringify(
    {
      name: "jarvis-engine-build-staging",
      private: true,
      type: "commonjs",
      dependencies: deps,
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
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
  // Jarvis: upstream sets process.env.NODE_TLS_REJECT_UNAUTHORIZED='0'
  // on every HTTP-node request, which disables TLS verification for the
  // entire Node process (not just the one request). We strip that line
  // via STRIP_LINES in sync-activepieces.ts; if a sync ever re-introduces
  // it, the file content here changes and the bundle hash invalidates so
  // the cached engine doesn't keep shipping the OLD bypass.
  "pieces/common/src/lib/http/axios/axios-http-client.ts",
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
