/**
 * License check for the pieces a self-managed install fetches into
 * `~/.jarvis/pieces` (#971, owner decision 2026-11-05): the same policy as the
 * hosted shared tree (`license-policy.ts`), applied per piece.
 *
 * The engine finds pieces by walking `node_modules/@activepieces`, not by
 * reading the manifest, and bun neither prunes a piece dropped from
 * package.json nor leaves a removed one removed (measured, bun 1.3.8). So
 * every `bun install` in the pieces dir (install, rollback, uninstall, boot)
 * is followed by `enforcePiecesTree`, which takes off disk every piece
 * directory the manifest does not list and every listed piece that fails.
 *
 *   - Install (`installPiece`): a piece that fails is refused and the install
 *     rolled back (manifest, package.json, bun.lock, then bun again).
 *   - Boot (`reconcilePiecesLibrary`): an installed piece that fails is logged
 *     and held: off disk, kept in the manifest, checked again next boot.
 *
 * A piece fails for a denied package its tree reaches (`reachedFrom`), for a
 * package in its tree the scan could not decide (`errorReachedFrom`), and for
 * a problem with the tree as a whole (no bun.lock). A package under its own
 * name the lock does not list (an old nested copy bun left) is judged on what
 * it declares. A package nothing in the manifest reaches (what an uninstall or
 * update leaves) fails no piece.
 */

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { CATALOG } from "./catalog";
import { describeViolations, scanInstalledTree, type LicenseScan } from "./license-scan";

/** An install refused because the license policy denies the piece or a package it pulls in. */
export class PieceLicenseError extends Error {
  readonly code = "PIECE_LICENSE_DENIED" as const;
  constructor(
    readonly pieceId: string,
    readonly problems: readonly string[],
    /** Set when restoring the previous install did not finish; the piece may still be on disk. */
    readonly rollbackError?: string,
  ) {
    super(
      `piece "${pieceId}" was not installed: the license policy denies what it would install -- ` +
        problems.join("; ") +
        (rollbackError ? ` (restoring the previous install failed: ${rollbackError})` : ""),
    );
    this.name = "PieceLicenseError";
  }
}

export interface PiecesLicenseCheck {
  /**
   * Per npm package: each denied package its tree reaches, each package in
   * its tree the scan could not decide, and every problem with the tree as a
   * whole (no bun.lock, ...), which no piece can be cleared of. Empty: allowed.
   */
  byPiece: Map<string, string[]>;
  /** Problems with packages nothing in the manifest reaches: leftovers of an uninstall or update, reported but charged to no piece. */
  leftovers: string[];
  /**
   * For each package directory (relative to the pieces dir, `/`-separated),
   * the listed pieces whose tree reaches it: a piece directory another piece
   * depends on is not a stray, as long as that piece passes.
   */
  reachedBy: Map<string, string[]>;
}

/**
 * Scan the pieces dir and decide `npmPackages`. Catalog pieces, and the
 * `@activepieces/piece-*` packages the manifest names, take upstream's MIT
 * when published without a license field, as on the hosted tree; the scan
 * grants that only to a package bun installed under that name and resolved
 * to it in bun.lock (a tree with no bun.lock fails every piece).
 */
export function checkInstalledPieceLicenses(base: string, npmPackages: readonly string[]): PiecesLicenseCheck {
  const upstream = new Set(CATALOG.map((e) => e.npmPackage));
  for (const name of npmPackages) if (/^@activepieces\/piece-[a-z0-9-]+$/u.test(name)) upstream.add(name);
  // bun leaves old nested copies the current lock no longer lists: judged on
  // what they declare, not refused for the lock alone (measured on a real install).
  const scan = scanInstalledTree(base, { catalogPackages: upstream, lockfile: "required", unvouched: "declared" });
  return decide(scan, npmPackages);
}

function decide(scan: LicenseScan, npmPackages: readonly string[]): PiecesLicenseCheck {
  const byPiece = new Map<string, string[]>(npmPackages.map((name) => [name, []]));
  const leftovers: string[] = [];
  const charge = (roots: readonly string[], line: string) => {
    let charged = false;
    for (const root of roots) {
      const list = byPiece.get(root);
      if (!list) continue;
      charged = true;
      // The line names one shortest chain; say when it runs through another piece.
      list.push(line.includes(` via ${root}@`) ? line : `${line} (reached from ${root})`);
    }
    if (!charged) leftovers.push(line);
  };
  const lines = describeViolations({ ...scan, errors: [] });
  scan.violations.forEach((violation, i) => charge(violation.reachedFrom, lines[i]!));
  for (const error of scan.errors) {
    const roots = scan.errorReachedFrom.get(error);
    if (roots) charge(roots, error);
    // About the tree as a whole: nothing in it can be vouched for.
    else for (const list of byPiece.values()) list.push(error);
  }
  // A piece the scan did not find at the top of the tree cannot be vouched for.
  const top = new Set(scan.packages.filter((p) => p.chain.length === 1).map((p) => p.name));
  for (const name of npmPackages) {
    if (!top.has(name)) byPiece.get(name)!.push(`${name} is not installed where the license scan can decide it`);
  }
  const reachedBy = new Map(scan.packages.filter((p) => p.reachedFrom.length > 0).map((p) => [p.path.split(sep).join("/"), p.reachedFrom]));
  return { byPiece, leftovers, reachedBy };
}

/** The `@activepieces/piece-*` directories under `node_modules`: what the engine's loader walks. */
export function installedPieceDirs(base: string): string[] {
  const scope = join(base, "node_modules", "@activepieces");
  try {
    if (!lstatSync(scope).isDirectory()) return [];
    return readdirSync(scope).filter((n) => n.startsWith("piece-")).map((n) => `@activepieces/${n}`).sort();
  } catch {
    return [];
  }
}

export interface EnforceResult {
  /** Pieces the manifest lists whose check failed, taken off disk (`removed` false when that was not possible). */
  held: Array<{ npmPackage: string; problems: string[]; removed: boolean }>;
  /** Piece directories no manifest entry lists, taken off disk: a refused or uninstalled piece bun did not prune. */
  strays: string[];
  leftovers: string[];
}

/**
 * Run after every `bun install` in the pieces dir (#971): bun neither prunes a
 * piece dropped from package.json nor leaves a removed one removed, so the
 * tree is put right here each time. Every piece directory the manifest does
 * not list is removed, then every listed piece is checked and a failing one
 * is removed, so nothing denied stays where the engine's loader looks.
 */
export function enforcePiecesTree(
  base: string,
  npmPackages: readonly string[],
  opts: {
    check?: (base: string, npmPackages: readonly string[]) => PiecesLicenseCheck;
    remove: (base: string, npmPackage: string) => boolean;
  },
): EnforceResult {
  const listed = new Set(npmPackages);
  const present = npmPackages.filter((name) => existsSync(join(base, "node_modules", name, "package.json")));
  let check: PiecesLicenseCheck;
  try {
    check = (opts.check ?? checkInstalledPieceLicenses)(base, present);
  } catch (e) {
    // A check that cannot finish vouches for nothing.
    const problem = `the license check failed: ${(e as Error).message}`;
    check = { byPiece: new Map(present.map((name) => [name, [problem]])), leftovers: [], reachedBy: new Map() };
  }
  // Unlisted, and no listed piece that passes depends on that very directory:
  // what a refused or uninstalled piece leaves. One a failing piece reaches
  // goes too, since that piece is held and its tree is denied.
  const passing = new Set(present.filter((name) => (check.byPiece.get(name) ?? []).length === 0));
  const strays = installedPieceDirs(base).filter((name) => !listed.has(name)
    && !(check.reachedBy.get(`node_modules/${name}`) ?? []).some((root) => passing.has(root)));
  for (const name of strays) opts.remove(base, name);
  const held: EnforceResult["held"] = [];
  for (const name of present) {
    const problems = check.byPiece.get(name) ?? [];
    if (problems.length === 0) continue;
    held.push({ npmPackage: name, problems, removed: opts.remove(base, name) });
  }
  return { held, strays, leftovers: check.leftovers };
}
