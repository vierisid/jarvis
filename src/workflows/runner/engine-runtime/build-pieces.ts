/**
 * Bundle each Jarvis-authored piece (under `packages/pieces/jarvis/*`) into
 * the on-disk layout the engine's piece-loader expects:
 *
 *   .../piece-dir/dist/package.json     (with the canonical `name` + `version`)
 *   .../piece-dir/dist/src/index.js     (single CJS bundle)
 *   .../piece-dir/dist/.source-hash     (content marker for cache skip)
 *
 * The engine's `findInDistFolder` (helper/piece-loader.ts) walks
 * `packages/pieces/**` from its CWD looking for `dist/package.json` whose
 * `name` matches the requested pieceName. It then imports `dist/src/index.js`.
 *
 * Bundling rules:
 *   - Format: CommonJS, target node20 -- matches the engine bundle.
 *   - Resolution: `@activepieces/{shared,pieces-framework,pieces-common}` are
 *     ALIASED to vendored source so the piece bundle is self-contained and
 *     doesn't rely on any sibling node_modules at engine runtime.
 *   - External: nothing additional. Built-in node modules are external by
 *     default for node target.
 *
 * Cache:
 *   - `pieceHash(pieceDir)` mixes every src/**\/*.ts file's content with the
 *     piece's package.json AND the engine bundle hash. The engine bundle
 *     hash carries the framework / shared / common identity, so a sync of
 *     the vendored tree (which bumps the upstream SHA) invalidates every
 *     piece cache automatically. A piece-only edit also invalidates only
 *     that piece's cache.
 *   - The hash is written to `dist/.source-hash`. On rebuild request, if
 *     the marker matches AND the compiled bundle still exists, we return
 *     the cached result without invoking esbuild.
 *   - Pass `force: true` to bypass the cache (typically from a CLI flag).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, basename } from "node:path";
import {
  ENGINE_BUILD_PATHS,
  bundleHash,
  ensureStagingInstalled as ensureEngineStagingInstalled,
} from "./build";

const STAGING_NODE_MODULES = resolve(
  ENGINE_BUILD_PATHS.STAGING_DIR,
  "node_modules",
);

export interface BuildPieceResult {
  pieceDir: string;
  bundlePath: string;
  packageJsonPath: string;
  packageName: string;
  pieceVersion: string;
  /** True when the build was skipped because the cache was fresh. */
  cached: boolean;
}

export interface BuildPieceOptions {
  /**
   * Bypass the per-piece content-hash cache and rebuild unconditionally.
   * Useful when an upstream change (e.g. a CSS-level edit to the
   * framework that isn't in PATCHED_VENDOR_SOURCES) needs to flow
   * through to piece bundles. Default false.
   */
  force?: boolean;
}

/**
 * Content-hash a piece's source tree + its package.json + the current
 * engine bundle hash. Any of the three changing invalidates the cache:
 *   - piece source: the most common case (author edits an action)
 *   - piece package.json: dep bump or version pin
 *   - engine bundle hash: the framework / vendored tree changed (the
 *     bundle inlines pieces-framework + shared via aliasing, so a
 *     framework edit must invalidate every piece too)
 */
function pieceHash(pieceDir: string): string {
  const hasher = createHash("sha256");
  hasher.update(bundleHash()).update("\0");
  const pkgPath = resolve(pieceDir, "package.json");
  if (existsSync(pkgPath)) {
    hasher.update(readFileSync(pkgPath)).update("\0");
  }
  const srcDir = resolve(pieceDir, "src");
  if (existsSync(srcDir)) {
    // Walk the src tree breadth-first, sort children alphabetically so the
    // hash is stable across filesystems. Only `.ts` / `.tsx` / `.js` /
    // `.json` files contribute -- compiled artifacts and lockfiles are
    // not piece source.
    const stack: string[] = [srcDir];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      const children = readdirSync(dir).sort();
      for (const name of children) {
        const full = resolve(dir, name);
        const s = statSync(full);
        if (s.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!/\.(ts|tsx|js|json)$/.test(name)) continue;
        hasher.update(full.slice(pieceDir.length)).update("\0");
        hasher.update(readFileSync(full)).update("\0");
      }
    }
  }
  return hasher.digest("hex").slice(0, 16);
}

interface PiecePackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

async function ensureStagingInstalled(): Promise<void> {
  // Delegate to the engine bundle's install path. It synthesizes the
  // staging package.json + runs `bun install` if needed; it's a no-op
  // when the staging tree is already fresh. Wiring through this avoids
  // the previous race: bootstrap kicks off `buildEngineBundle()` and
  // `buildAllJarvisPieces()` in parallel, and if pieces won the race
  // they used to throw on missing esbuild. Now both paths share the
  // same install promise (bun install dedupes naturally; consecutive
  // calls return without re-running once the tree is in place).
  if (existsSync(resolve(STAGING_NODE_MODULES, "esbuild"))) return;
  await ensureEngineStagingInstalled();
}

export async function buildPiece(
  pieceDir: string,
  opts: BuildPieceOptions = {},
): Promise<BuildPieceResult> {
  const pkgPath = resolve(pieceDir, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`piece ${pieceDir} is missing package.json`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PiecePackageJson;
  if (!pkg.name || !pkg.version) {
    throw new Error(`piece ${pieceDir} package.json is missing name/version`);
  }
  const entry = resolve(pieceDir, "src/index.ts");
  if (!existsSync(entry)) {
    throw new Error(`piece ${pieceDir} is missing src/index.ts`);
  }

  const distDir = resolve(pieceDir, "dist");
  const bundlePath = resolve(distDir, "src", "index.js");
  const packageJsonPath = resolve(distDir, "package.json");
  const hashMarker = resolve(distDir, ".source-hash");

  // Cache fast-path: skip esbuild when the hash marker matches the
  // current source + bundle hash AND the compiled bundle still exists.
  // The marker is the only artifact we read to decide; the bundle is
  // the only artifact we re-use. If either is missing, treat as miss.
  const wantHash = pieceHash(pieceDir);
  if (!opts.force && existsSync(bundlePath) && existsSync(hashMarker)) {
    const have = readFileSync(hashMarker, "utf8").trim();
    if (have === wantHash) {
      return {
        pieceDir,
        bundlePath,
        packageJsonPath,
        packageName: pkg.name,
        pieceVersion: pkg.version,
        cached: true,
      };
    }
  }

  // Miss path: stage check first (esbuild presence is required for the
  // actual build below; the cached path above never reaches it).
  await ensureStagingInstalled();
  mkdirSync(resolve(distDir, "src"), { recursive: true });

  const esbuild = (await import(
    resolve(STAGING_NODE_MODULES, "esbuild/lib/main.js")
  )) as {
    build(options: Record<string, unknown>): Promise<unknown>;
  };

  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node20",
    outfile: bundlePath,
    format: "cjs",
    sourcemap: false,
    minifySyntax: false,
    minifyWhitespace: false,
    alias: {
      "@activepieces/shared": resolve(
        ENGINE_BUILD_PATHS.VENDOR_PACKAGES,
        "shared/src",
      ),
      "@activepieces/pieces-framework": resolve(
        ENGINE_BUILD_PATHS.VENDOR_PACKAGES,
        "pieces/framework/src",
      ),
      "@activepieces/pieces-common": resolve(
        ENGINE_BUILD_PATHS.VENDOR_PACKAGES,
        "pieces/common/src",
      ),
    },
    external: ["isolated-vm", "utf-8-validate", "bufferutil"],
    nodePaths: [STAGING_NODE_MODULES],
    logLevel: "warning",
  });

  // Write a slimmed-down package.json into dist/. We preserve `name` and
  // `version` (the engine reads these); everything else is dropped because
  // the piece bundle is self-contained and the loader doesn't read any
  // other field at runtime.
  writeFileSync(
    packageJsonPath,
    JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        main: "./src/index.js",
        types: "./src/index.d.ts",
      },
      null,
      2,
    ) + "\n",
  );

  // Stamp the cache marker LAST: the bundle + package.json are now on
  // disk in their final shape, so a future cache hit reads consistent
  // artifacts. Writing the marker first would leave a window where a
  // crash mid-build looks like a fresh cache on the next attempt.
  writeFileSync(hashMarker, wantHash + "\n");

  return {
    pieceDir,
    bundlePath,
    packageJsonPath,
    packageName: pkg.name,
    pieceVersion: pkg.version,
    cached: false,
  };
}

/**
 * Build every piece directly under `packages/pieces/jarvis/`. Returns the
 * artifacts in the order discovered (alphabetical by piece dir name).
 * Each piece skips work when its content-hash marker is fresh; pass
 * `force: true` to rebuild every piece unconditionally.
 */
export async function buildAllJarvisPieces(
  opts: BuildPieceOptions = {},
): Promise<BuildPieceResult[]> {
  const root = resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis");
  if (!existsSync(root)) return [];
  const out: BuildPieceResult[] = [];
  for (const name of readdirSync(root).sort()) {
    const pieceDir = resolve(root, name);
    if (!statSync(pieceDir).isDirectory()) continue;
    if (!existsSync(resolve(pieceDir, "package.json"))) continue;
    out.push(await buildPiece(pieceDir, opts));
  }
  return out;
}

export const PIECE_BUILD_PATHS = {
  jarvisPiecesRoot: resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis"),
} as const;

void basename; // keep import shape stable across edits
