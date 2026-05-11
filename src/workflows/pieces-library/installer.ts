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
 * uninstall calls. The API route layer holds an in-process mutex; we don't
 * defend against concurrent processes touching the same on-disk dir.
 */

import { promises as fs, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { catalogById, type CatalogEntry } from "./catalog";

const ROOT_ENV = "JARVIS_PIECES_DIR";

/** Default `~/.jarvis/pieces`. Override with `JARVIS_PIECES_DIR` for tests. */
export function piecesBaseDir(): string {
  const override = process.env[ROOT_ENV];
  if (override) return resolve(override);
  return resolve(homedir(), ".jarvis", "pieces");
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
  runBunInstall?: (cwd: string) => Promise<void>;
}

export interface InstallResult {
  manifest: InstalledManifest;
  piece: InstalledPiece;
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
  const entry = catalogById().get(id);
  if (!entry) {
    throw new Error(`unknown piece id "${id}" -- not in the catalog`);
  }

  // 1. Manifest add/update (range from catalog, resolved filled in after).
  const manifest = await readManifest(base);
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
  const installer = opts.runBunInstall ?? runBunInstall;
  await installer(base);

  // 3. Read back the resolved version from node_modules.
  const resolved = await readResolvedVersion(base, entry);
  if (!resolved) {
    throw new Error(
      `bun install completed but ${entry.npmPackage} is missing from node_modules`,
    );
  }
  placeholder.resolvedVersion = resolved;
  const finalManifest: InstalledManifest = {
    version: 1,
    pieces: nextManifest.pieces.map((p) => (p.id === id ? placeholder : p)),
  };
  await writeManifest(finalManifest, base);
  return { manifest: finalManifest, piece: placeholder };
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
  // Run bun install so dropped deps are pruned from node_modules.
  const installer = opts.runBunInstall ?? runBunInstall;
  await installer(base);
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

function runBunInstall(cwd: string): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn("bun", ["install", "--silent"], {
      cwd,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code === 0) res();
      else rej(new Error(`bun install (pieces) exited with code ${code}`));
    });
    child.on("error", rej);
  });
}
