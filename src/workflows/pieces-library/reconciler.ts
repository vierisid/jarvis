/**
 * Startup pass that reconciles `~/.jarvis/pieces/installed.json` with the
 * on-disk `node_modules/`. Two scenarios this exists for:
 *
 *   1. Fresh container start (Docker volume restored from backup, fresh dev
 *      machine cloning a profile). The manifest survives; node_modules
 *      doesn't. We run `bun install` to re-materialize the install set.
 *
 *   2. Hand-edited manifest. A user (or migration script) added an entry by
 *      hand without going through the API. The reconciler picks it up.
 *
 * The reconciler returns a structured result so the daemon can log a
 * summary line (and the bootstrap can decide whether to extract metadata
 * for any newly-materialized pieces).
 *
 * No-op when the manifest is empty.
 */

import { existsSync, mkdirSync, promises as fs } from "node:fs";
import { resolve, join } from "node:path";
import {
  piecesBaseDir,
  readManifest,
  synthesizePackageJson,
  type InstalledManifest,
  type InstalledPiece,
} from "./installer";

export interface ReconcileResult {
  /** True when the manifest had at least one piece (otherwise we skipped install). */
  ranInstall: boolean;
  /** Total pieces declared in the manifest (post-reconcile). */
  declared: number;
  /** Pieces present in node_modules after reconcile. */
  materialized: InstalledPiece[];
  /** Pieces declared but missing from node_modules even after install. Surfaced as warnings. */
  missing: InstalledPiece[];
  /** Pieces in the manifest whose resolved version differs from on-disk now. */
  drifted: Array<{ piece: InstalledPiece; onDiskVersion: string }>;
}

export interface ReconcileOptions {
  base?: string;
  runBunInstall?: (cwd: string) => Promise<void>;
  log?: (line: string) => void;
}

export async function reconcilePiecesLibrary(
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const base = opts.base ?? piecesBaseDir();
  const log = opts.log ?? ((m) => console.log(`[pieces-library] ${m}`));

  if (!existsSync(base)) {
    return { ranInstall: false, declared: 0, materialized: [], missing: [], drifted: [] };
  }

  const manifest = await readManifest(base);
  if (manifest.pieces.length === 0) {
    return { ranInstall: false, declared: 0, materialized: [], missing: [], drifted: [] };
  }

  // Always rewrite package.json so it matches the manifest (defensive: if
  // someone edited package.json by hand, the manifest still wins).
  mkdirSync(base, { recursive: true });
  await fs.writeFile(join(base, "package.json"), synthesizePackageJson(manifest), "utf8");

  const installer = opts.runBunInstall ?? defaultRunBunInstall;
  const t0 = Date.now();
  await installer(base);
  log(`reconcile: bun install for ${manifest.pieces.length} piece(s) took ${Date.now() - t0}ms`);

  // Walk each declared piece, verify it landed, capture any drift.
  const materialized: InstalledPiece[] = [];
  const missing: InstalledPiece[] = [];
  const drifted: Array<{ piece: InstalledPiece; onDiskVersion: string }> = [];
  for (const piece of manifest.pieces) {
    const pkgPath = join(base, "node_modules", piece.npmPackage, "package.json");
    if (!existsSync(pkgPath)) {
      missing.push(piece);
      log(`reconcile: WARNING ${piece.id} (${piece.npmPackage}) declared but missing from node_modules`);
      continue;
    }
    materialized.push(piece);
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version !== piece.resolvedVersion) {
        drifted.push({ piece, onDiskVersion: pkg.version });
      }
    } catch {
      // Couldn't read the package.json; treat as drift but don't fail the reconcile.
    }
  }
  if (drifted.length > 0) {
    log(
      `reconcile: ${drifted.length} piece(s) resolved to a different version than the manifest records (re-run install or update manifest)`,
    );
  }

  return {
    ranInstall: true,
    declared: manifest.pieces.length,
    materialized,
    missing,
    drifted,
  };
}

function defaultRunBunInstall(cwd: string): Promise<void> {
  return new Promise((res, rej) => {
    // Import lazily so tests that don't run installs aren't penalized.
    import("node:child_process").then(({ spawn }) => {
      const child = spawn("bun", ["install", "--silent"], { cwd, stdio: "inherit" });
      child.on("close", (code) => {
        if (code === 0) res();
        else rej(new Error(`bun install (pieces reconcile) exited with code ${code}`));
      });
      child.on("error", rej);
    });
  });
}

/**
 * Path the engine subprocess scans for installed pieces. Falls back to the
 * pieces base dir even when it doesn't exist yet -- the caller (bootstrap)
 * just adds this to `pieceRoots` and the loader handles missing dirs.
 */
export function piecesNodeModulesDir(base: string = piecesBaseDir()): string {
  return resolve(base, "node_modules");
}

/**
 * Convenience guard for tests / scripts -- predicate for "this library has
 * something the engine needs to know about." False when the manifest is
 * empty or the dir doesn't exist yet.
 */
export async function hasInstalledPieces(
  base: string = piecesBaseDir(),
): Promise<boolean> {
  if (!existsSync(base)) return false;
  try {
    const manifest: InstalledManifest = await readManifest(base);
    return manifest.pieces.length > 0;
  } catch {
    return false;
  }
}
