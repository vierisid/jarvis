/**
 * Read-only SHARED pieces catalog (multi-tenant hosting): a root-owned tree
 * the host builds once per installed version and exposes via
 * `JARVIS_SHARED_PIECES_DIR`. Pieces present there are usable by every
 * instance without installation — the Library shows them as included, and a
 * user install of the same piece shadows the shared copy (engine-bootstrap
 * orders the roots user-first).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function sharedPiecesDir(): string | null {
  const dir = process.env.JARVIS_SHARED_PIECES_DIR?.trim();
  return dir ? resolve(dir) : null;
}

const memo = new Map<string, Map<string, string>>();

/**
 * npmPackage -> version for every piece in the shared tree. `dirArg`
 * overrides discovery (the daemon passes the config-resolved dir; `null` =
 * definitely none; `undefined` = fall back to the env var). Memoized per dir
 * for the process lifetime: the tree is immutable per installed version, and
 * version changes restart the daemon.
 */
export function sharedPieceVersions(dirArg?: string | null): Map<string, string> {
  const dir = dirArg !== undefined ? (dirArg ? resolve(dirArg) : null) : sharedPiecesDir();
  const key = dir ?? "";
  const hit = memo.get(key);
  if (hit) return hit;
  const out = new Map<string, string>();
  if (dir) {
    const scoped = join(dir, "node_modules", "@activepieces");
    if (existsSync(scoped)) {
      for (const ent of readdirSync(scoped, { withFileTypes: true })) {
        if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
        const pkgPath = join(scoped, ent.name, "package.json");
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
            name?: unknown;
            version?: unknown;
          };
          if (typeof pkg.name !== "string" || typeof pkg.version !== "string") continue;
          // Same convention as discoverPieces: real pieces only.
          if (!/(^|\/)piece-[a-z0-9][a-z0-9-]*$/.test(pkg.name)) continue;
          out.set(pkg.name, pkg.version);
        } catch {
          // Missing/unreadable package.json: not a piece.
        }
      }
    }
  }
  memo.set(key, out);
  return out;
}

/** Test seam: drop the memo (the env/dir changed under the test). */
export function resetSharedPiecesCache(): void {
  memo.clear();
}
