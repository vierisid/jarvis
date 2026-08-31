/**
 * Read-only SHARED pieces catalog (multi-tenant hosting): a root-owned tree
 * the host builds once per installed version and exposes via
 * `workflows.pieces_dir` / `JARVIS_SHARED_PIECES_DIR`. It holds the WHOLE
 * catalog, and every instance pointed at it can use all of it with no
 * installation.
 *
 * Configuring it hands the catalog to the HOST: `piecesManagedByHost` is the
 * switch, and the Library then offers every piece as simply available — no
 * install state, no per-piece detail — while install and uninstall answer
 * 403. There is no in-between where a shared baseline is topped up with user
 * installs; a deployment either owns the catalog or the user does. (This
 * module used to also enumerate the tree's npmPackage -> version map, for a
 * Library that merged shared pieces and user installs into one list. That
 * hybrid is gone, and so is the enumeration — nothing needs to read the tree
 * to decide what is available any more, because the answer is "all of it".)
 *
 * What the shared tree does NOT do is take the tenant's own directory away.
 * `~/.jarvis/pieces` stays writable and still SHADOWS the shared copy
 * (engine-bootstrap orders the roots user-first), which is precisely why the
 * refusal has to live in the API rather than in the UI.
 */

import { resolve } from "node:path";

export function sharedPiecesDir(): string | null {
  const dir = process.env.JARVIS_SHARED_PIECES_DIR?.trim();
  return dir ? resolve(dir) : null;
}

/**
 * True when a HOST manages this install's pieces: a shared catalog dir is
 * configured, so the whole catalog is already installed and read-only.
 *
 * This is the gate for the managed Library — no install, no uninstall, no
 * per-piece version/size detail — and it keys off the shared dir rather than
 * a generic "am I hosted" flag on purpose. The question the Library asks is
 * "does something other than this user decide which pieces exist here?", and
 * a configured `workflows.pieces_dir` IS that declaration, whoever wrote it.
 * Keying off hostedness signals like the `usejarvis_ai` block would be both
 * too narrow (a managed instance provisioned without the hosted LLM has no
 * such block) and too broad (it says nothing about pieces).
 *
 * Configured-but-missing still counts as managed: an empty or absent shared
 * tree is a broken host to repair, not an invitation for every tenant to
 * install the catalog into their own quota.
 *
 * Argument convention: `undefined` = consult the env var, `null` = definitely
 * none. Callers that resolved config already pass `string | null`, so the env
 * branch serves callers that have no config to hand.
 */
export function piecesManagedByHost(dirArg?: string | null): boolean {
  if (dirArg !== undefined) return dirArg !== null && dirArg.trim() !== "";
  return sharedPiecesDir() !== null;
}
