/**
 * Bundle each Jarvis-authored piece (under `packages/pieces/jarvis/*`) into
 * the on-disk layout the engine's piece-loader expects:
 *
 *   .../piece-dir/dist/package.json     (with the canonical `name` + `version`)
 *   .../piece-dir/dist/src/index.js     (single CJS bundle)
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
 * The build is content-addressed by the synthesized `package.json` plus the
 * piece source mtime, but since piece source changes infrequently we just
 * rebuild on every call. Tests can pass `force: false` to skip if dist exists.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, basename } from "node:path";
import { ENGINE_BUILD_PATHS } from "./build";

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
}

interface PiecePackageJson {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

async function ensureStagingInstalled(): Promise<void> {
  // We rely on the engine bundle's staging install for esbuild. If it's
  // missing the caller should have run `bun run scripts/build-engine.ts`
  // first. We could install on demand here too but that doubles the cold-
  // start cost; defer to the existing build script.
  if (!existsSync(resolve(STAGING_NODE_MODULES, "esbuild"))) {
    throw new Error(
      `engine-build staging is missing esbuild; run scripts/build-engine.ts first`,
    );
  }
}

export async function buildPiece(pieceDir: string): Promise<BuildPieceResult> {
  await ensureStagingInstalled();

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
  mkdirSync(resolve(distDir, "src"), { recursive: true });
  const bundlePath = resolve(distDir, "src", "index.js");
  const packageJsonPath = resolve(distDir, "package.json");

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

  return {
    pieceDir,
    bundlePath,
    packageJsonPath,
    packageName: pkg.name,
    pieceVersion: pkg.version,
  };
}

/**
 * Build every piece directly under `packages/pieces/jarvis/`. Returns the
 * artifacts in the order discovered (alphabetical by piece dir name).
 */
export async function buildAllJarvisPieces(): Promise<BuildPieceResult[]> {
  const root = resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis");
  if (!existsSync(root)) return [];
  const out: BuildPieceResult[] = [];
  for (const name of readdirSync(root).sort()) {
    const pieceDir = resolve(root, name);
    if (!statSync(pieceDir).isDirectory()) continue;
    if (!existsSync(resolve(pieceDir, "package.json"))) continue;
    out.push(await buildPiece(pieceDir));
  }
  return out;
}

export const PIECE_BUILD_PATHS = {
  jarvisPiecesRoot: resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis"),
} as const;

void basename; // keep import shape stable across edits
