/**
 * Pieces installer + manifest. Manages `~/.jarvis/pieces/`:
 *
 *   installed.json   -- source of truth for what should be installed
 *   package.json     -- synthesized from installed.json, fed to bun install
 *   node_modules/    -- bun's resolution output (one shared tree across pieces)
 *
 * Operations:
 *   - `installPiece(id)`   add an entry to the manifest, sync to disk
 *   - `uninstallPiece(id)` remove an entry, sync
 *   - `readManifest()` /  `writeManifest(m)` JSON I/O
 *
 * Single-writer semantics: callers must serialize concurrent install /
 * uninstall calls. UI and composer callers share withLibraryLock; we don't
 * defend against concurrent processes touching the same on-disk dir.
 */

import { promises as fs, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { homeJarvisDir } from "../../util/jarvis-dirs";
import { catalogById, excludedReason, PieceExcludedError, type CatalogEntry } from "./catalog";
import { sanitizedEnv } from "../../util/subprocess-env";
import { BUN_INSTALL_ARGS, SANITIZED_INSTALL_HINT } from "../../util/sanitized-install";
import { enforcePiecesTree, PieceLicenseError, type PiecesLicenseCheck } from "./install-licenses";

const ROOT_ENV = "JARVIS_PIECES_DIR";

/** Default `~/.jarvis/pieces`. Override with `JARVIS_PIECES_DIR` for tests. */
export function piecesBaseDir(): string {
  const override = process.env[ROOT_ENV];
  if (override) return resolve(override);
  return homeJarvisDir("pieces");
}

export interface InstalledPiece {
  /** Jarvis-side id; matches the catalog entry's `id`. */
  id: string;
  /** npm package name. Stored so uninstall doesn't need the catalog. */
  npmPackage: string;
  /** Semver range bun resolved against. Stored for diagnostics. */
  versionRange: string;
  /** Concrete version bun resolved to at install time. */
  resolvedVersion: string;
  /** Epoch ms of the most recent install / reinstall for this id. */
  installedAt: number;
}

export interface InstalledManifest {
  /** Manifest schema version, in case we need to migrate later. */
  version: 1;
  pieces: InstalledPiece[];
}

const EMPTY_MANIFEST: InstalledManifest = { version: 1, pieces: [] };

function manifestPath(base: string = piecesBaseDir()): string {
  return join(base, "installed.json");
}

function pkgJsonPath(base: string = piecesBaseDir()): string {
  return join(base, "package.json");
}

/**
 * Read the manifest. Returns an empty one if the file is missing -- a fresh
 * install has no pieces. Throws on JSON parse failure (file exists but is
 * unreadable) so the caller surfaces a clear error rather than silently
 * resetting.
 */
export async function readManifest(
  base: string = piecesBaseDir(),
): Promise<InstalledManifest> {
  const path = manifestPath(base);
  if (!existsSync(path)) return { ...EMPTY_MANIFEST };
  const raw = await fs.readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`pieces manifest at ${path} is unreadable: ${(e as Error).message}`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { pieces?: unknown }).pieces)
  ) {
    throw new Error(`pieces manifest at ${path} has unexpected shape`);
  }
  // Trust array shape but normalize entries -- callers may have hand-edited.
  const pieces = ((parsed as { pieces: unknown[] }).pieces)
    .filter((p): p is InstalledPiece => isInstalledPiece(p));
  return { version: 1, pieces };
}

function isInstalledPiece(v: unknown): v is InstalledPiece {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p["id"] === "string" &&
    typeof p["npmPackage"] === "string" &&
    typeof p["versionRange"] === "string" &&
    typeof p["resolvedVersion"] === "string" &&
    typeof p["installedAt"] === "number"
  );
}

export async function writeManifest(
  manifest: InstalledManifest,
  base: string = piecesBaseDir(),
): Promise<void> {
  mkdirSync(base, { recursive: true });
  await fs.writeFile(
    manifestPath(base),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Synthesize the `package.json` bun uses to drive its install. One dep entry
 * per installed piece, with the *range* (not the resolved version). Bun
 * re-resolves on every install, so a `bun install` call after a manifest
 * change picks up newer versions within the range.
 *
 * Marked `private: true` so a stray `bun publish` from this directory
 * can't accidentally upload the user's piece-set as a package.
 */
export function synthesizePackageJson(manifest: InstalledManifest): string {
  const deps: Record<string, string> = {};
  for (const piece of manifest.pieces) {
    deps[piece.npmPackage] = piece.versionRange;
  }
  return (
    JSON.stringify(
      {
        name: "jarvis-pieces",
        private: true,
        type: "commonjs",
        dependencies: deps,
      },
      null,
      2,
    ) + "\n"
  );
}

async function writeSynthesizedPackageJson(
  manifest: InstalledManifest,
  base: string,
): Promise<void> {
  mkdirSync(base, { recursive: true });
  await fs.writeFile(pkgJsonPath(base), synthesizePackageJson(manifest), "utf8");
}

export interface InstallOptions {
  base?: string;
  /**
   * Optional override for the `bun install` invocation. Tests inject a stub
   * to avoid the real network call. Production omits this.
   */
  runBunInstall?: (cwd: string, signal?: AbortSignal) => Promise<void>;
  /** Aborting stops the install: the bun install child is killed. */
  signal?: AbortSignal;
  /** Test seam for the license check (#971); production uses `checkInstalledPieceLicenses`. */
  checkLicenses?: (base: string, npmPackages: readonly string[]) => PiecesLicenseCheck;
}

export interface InstallResult {
  manifest: InstalledManifest;
  piece: InstalledPiece;
  /**
   * Other installed pieces the license check took off disk after this install
   * (#971): the install brought back one held at boot, or another piece now
   * fails. Neither the engine nor the next boot loads them; the editor's
   * in-memory catalog keeps listing them until the daemon restarts.
   */
  alsoHeld: Array<{ npmPackage: string; problems: string[] }>;
}

/**
 * Add (or update) a piece in the manifest, then run `bun install` to make
 * the on-disk `node_modules` match. Resolved version is read from
 * `node_modules/<pkg>/package.json` after install -- that's bun's
 * authoritative answer. Throws if the install command fails OR if the
 * resolved package is missing afterward.
 */
export async function installPiece(
  id: string,
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const base = opts.base ?? piecesBaseDir();
  // Before the manifest is touched: an excluded piece is refused for a fresh
  // install and for an update of one installed before the exclusion alike.
  const excluded = excludedReason(id);
  if (excluded !== null) throw new PieceExcludedError(id, excluded);
  const entry = catalogById().get(id);
  if (!entry) {
    throw new Error(`unknown piece id "${id}" -- not in the catalog`);
  }

  // 1. Manifest add/update (range from catalog, resolved filled in after).
  const manifest = await readManifest(base);
  // What the install looked like before, so a refused piece can be rolled
  // back to it, versions included (#971): bun.lock holds them.
  const before = await snapshotInstall(base);
  const existing = manifest.pieces.find((p) => p.id === id);
  const placeholder: InstalledPiece = {
    id,
    npmPackage: entry.npmPackage,
    versionRange: entry.versionRange,
    resolvedVersion: existing?.resolvedVersion ?? "",
    // Preserve the original install timestamp on reinstall / update --
    // "installedAt" is the first-install date, useful for diagnostics
    // ("when did the user first opt into this piece?"). For brand-new
    // installs we set it to now.
    installedAt: existing?.installedAt ?? Date.now(),
  };
  const nextManifest: InstalledManifest = {
    version: 1,
    pieces: existing
      ? manifest.pieces.map((p) => (p.id === id ? placeholder : p))
      : [...manifest.pieces, placeholder],
  };
  await writeManifest(nextManifest, base);
  await writeSynthesizedPackageJson(nextManifest, base);

  // 2. bun install (idempotent; resolves the full manifest each call).
  opts.signal?.throwIfAborted();
  const installer = opts.runBunInstall ?? runBunInstall;
  const enforce = (pieces: readonly InstalledPiece[]) =>
    enforcePiecesTree(base, pieces.map((p) => p.npmPackage), { check: opts.checkLicenses, remove: removePackageDir });
  let resolved: string | null;
  let enforced: ReturnType<typeof enforce>;
  try {
    await installer(base, opts.signal);
    // 3. Read back the resolved version from node_modules.
    resolved = await readResolvedVersion(base, entry);
    if (!resolved) {
      throw new Error(
        `bun install completed but ${entry.npmPackage} is missing from node_modules`,
      );
    }
    // 4. License check (#971) over the whole tree: the release bun resolved
    // and every package it pulls in, and every other piece the install may
    // have brought back (bun re-creates a piece held at boot).
    enforced = enforce(nextManifest.pieces);
  } catch (e) {
    // A failed, aborted or half-finished install may still have put packages
    // on disk: whatever it left is checked, so nothing denied stays loadable.
    try { enforce(nextManifest.pieces); } catch { /* the original error is the one to report */ }
    throw e;
  }
  const refused = enforced.held.find((h) => h.npmPackage === entry.npmPackage);
  if (refused) {
    // Put the previous install back: manifest, package.json and bun.lock, then
    // bun again, so an update returns to the version it had. bun does not
    // prune, so the tree is enforced against the restored manifest after,
    // which takes a refused fresh install off disk.
    let rollbackError: string | undefined;
    try {
      await restoreInstall(base, before);
      await installer(base);
    } catch (e) {
      rollbackError = (e as Error).message;
    }
    try {
      enforce((await readManifest(base)).pieces);
    } catch (e) {
      rollbackError ??= (e as Error).message;
    }
    // Whatever the rollback managed, a refused fresh install is not left on disk.
    if (!existing) removePackageDir(base, entry.npmPackage);
    throw new PieceLicenseError(id, refused.problems, rollbackError);
  }
  placeholder.resolvedVersion = resolved;
  const finalManifest: InstalledManifest = {
    version: 1,
    pieces: nextManifest.pieces.map((p) => (p.id === id ? placeholder : p)),
  };
  await writeManifest(finalManifest, base);
  const alsoHeld = enforced.held.filter((h) => h.removed).map(({ npmPackage, problems }) => ({ npmPackage, problems }));
  return { manifest: finalManifest, piece: placeholder, alsoHeld };
}

/** The files that decide an install: the manifest, the package.json bun reads, and bun's lockfile. */
const INSTALL_STATE_FILES = ["installed.json", "package.json", "bun.lock"] as const;
type InstallSnapshot = Record<(typeof INSTALL_STATE_FILES)[number], string | null>;

async function snapshotInstall(base: string): Promise<InstallSnapshot> {
  const out = {} as InstallSnapshot;
  for (const name of INSTALL_STATE_FILES) {
    const path = join(base, name);
    out[name] = existsSync(path) ? await fs.readFile(path, "utf8") : null;
  }
  return out;
}

async function restoreInstall(base: string, snapshot: InstallSnapshot): Promise<void> {
  mkdirSync(base, { recursive: true });
  for (const name of INSTALL_STATE_FILES) {
    const path = join(base, name);
    const text = snapshot[name];
    if (text === null) rmSync(path, { force: true });
    else await fs.writeFile(path, text, "utf8");
  }
  // The previous package.json, or none: bun then prunes the refused piece.
  if (snapshot["package.json"] === null) {
    await fs.writeFile(pkgJsonPath(base), synthesizePackageJson(snapshot["installed.json"] === null
      ? EMPTY_MANIFEST : await readManifest(base)), "utf8");
  }
}

/** An npm package name, scoped or not, with no path segment that could leave `node_modules`. */
const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;

/**
 * Take one package out of the pieces dir's `node_modules`, by exact name.
 * False when the name is not a plain npm package name, when there is nothing
 * there, or when `node_modules` or the scope directory is a link (removing
 * through it would delete outside the pieces dir).
 */
export function removePackageDir(base: string, npmPackage: string): boolean {
  if (!SAFE_PACKAGE_NAME.test(npmPackage) || npmPackage === "node_modules") return false;
  const nodeModules = join(base, "node_modules");
  const dir = join(nodeModules, npmPackage);
  try {
    if (!lstatSync(nodeModules).isDirectory()) return false;
    if (npmPackage.includes("/") && !lstatSync(join(nodeModules, npmPackage.split("/")[0]!)).isDirectory()) return false;
    lstatSync(dir);
  } catch {
    return false;
  }
  // A link (bun's isolated layout) is removed itself; its target is not followed.
  // A removal the filesystem refuses (EACCES, EBUSY) reports false, so the
  // caller says the piece could not be held rather than abort the whole check.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    return false;
  }
  return !existsSync(dir);
}

export async function uninstallPiece(
  id: string,
  opts: InstallOptions = {},
): Promise<InstalledManifest> {
  const base = opts.base ?? piecesBaseDir();
  const manifest = await readManifest(base);
  if (!manifest.pieces.some((p) => p.id === id)) {
    // Already gone; idempotent.
    return manifest;
  }
  const nextManifest: InstalledManifest = {
    version: 1,
    pieces: manifest.pieces.filter((p) => p.id !== id),
  };
  await writeManifest(nextManifest, base);
  await writeSynthesizedPackageJson(nextManifest, base);
  // Run bun install for the new manifest. bun does not prune a dropped
  // piece, so the tree is enforced after (#971): the uninstalled piece leaves
  // node_modules, and a held piece bun brought back is taken off again.
  const installer = opts.runBunInstall ?? runBunInstall;
  try {
    await installer(base);
  } finally {
    // A cleanup failure never hides bun's own error.
    try {
      enforcePiecesTree(base, nextManifest.pieces.map((p) => p.npmPackage), { check: opts.checkLicenses, remove: removePackageDir });
    } catch { /* reported by the next install or boot, which enforce again */ }
  }
  return nextManifest;
}

async function readResolvedVersion(
  base: string,
  entry: CatalogEntry,
): Promise<string | null> {
  const path = join(base, "node_modules", entry.npmPackage, "package.json");
  if (!existsSync(path)) return null;
  try {
    const pkg = JSON.parse(await fs.readFile(path, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function runBunInstall(cwd: string, signal?: AbortSignal): Promise<void> {
  return runPiecesBunInstall(cwd, "pieces", signal);
}

/**
 * `bun install` in the pieces dir. The one spawn behind both the installer
 * and the startup reconciler, so the two cannot drift apart on how they run it.
 *
 * The packages are third-party npm code, so the child gets the sanitized env
 * rather than the daemon's, and lifecycle scripts do not run at all (see
 * BUN_INSTALL_ARGS for why that is safe for the catalog). `label` only names
 * the caller in the error. Run by process.execPath, the Bun running the
 * daemon, never a `bun` found on PATH (#864).
 */
export function runPiecesBunInstall(cwd: string, label: string, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) { rej(signal.reason); return; }
    const child = spawn(process.execPath, [...BUN_INSTALL_ARGS], {
      cwd,
      stdio: "inherit",
      env: sanitizedEnv(),
    });
    // Aborting kills the child and rejects at once, so a stalled install
    // cannot hold the Library lock or a composition indefinitely.
    const onAbort = () => { child.kill("SIGKILL"); rej(signal!.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) res();
      else rej(new Error(`bun install (${label}) exited with code ${code}. ${SANITIZED_INSTALL_HINT}`));
    });
    child.on("error", (error) => { signal?.removeEventListener("abort", onAbort); rej(error); });
  });
}

/**
 * In-process mutex shared by Library routes and workflow composition. Two concurrent installs would
 * race on the shared `~/.jarvis/pieces/package.json` + bun-install
 * invocation; we serialize them across both entry points. One daemon, one
 * writer.
 */
let libraryMutex: Promise<void> = Promise.resolve();
export function withLibraryLock<T>(fn: () => Promise<T>): Promise<T> {
  const release = libraryMutex.then(() => fn());
  libraryMutex = release.then(
    () => undefined,
    () => undefined,
  );
  return release;
}
