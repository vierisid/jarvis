#!/usr/bin/env bun
/**
 * Guard: every file a DOWNSTREAM CONSUMER reads out of the published tarball
 * is actually in the published tarball.
 *
 * `package.json`'s `files` allowlist is the ONLY thing in this repo that
 * decides what npm ships. (`.npmignore` is inert while `files` exists -- both
 * packers ignore it, which is why 196 `*.test.ts` files currently ship.) It is
 * invisible from the code that depends on it, so a module can be imported,
 * tested and merged here while being absent from every install of the package.
 * When the consumer is another repo, the gap is invisible on both sides.
 *
 * That is not hypothetical. `scripts/build-shared-runtime.ts` shipped as the
 * builder for the hosting fleet's shared runtime artifacts, but `files` never
 * named it. The host's `install-version` gates the whole artifact phase on the
 * file existing:
 *
 *     local builder="$dest/scripts/build-shared-runtime.ts"
 *     [[ -f "$builder" ]] || return 0
 *
 * The gate is deliberately silent (older brain versions predate the builder
 * and must still install), so every hosted instance ran with no shared engine
 * bundle, no shared pieces catalog and no prebuilt metadata cache for an
 * entire release line, and the config that points at those paths made the
 * brain report its pieces as host-managed anyway.
 *
 * Fails (exit 1) when a REQUIRED path is not in the tarball. The list is the
 * cross-repo contract, so add to it whenever something outside this repo
 * starts reading a shipped file by path.
 *
 * Run via:
 *   - `bun run check:package`
 *   - the pre-commit hook (.githooks/pre-commit)
 *   - CI (.github/workflows/test.yml)
 *   - the release, right before `npm publish` (.github/workflows/release-exec.yml)
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface Requirement {
  /** Path as it appears inside the tarball, relative to the package root. */
  path: string;
  /** Who reads it, and what breaks when it is missing. */
  why: string;
}

/**
 * Files an out-of-repo consumer resolves BY PATH out of an installed package.
 *
 * Deliberately not here: the vendored pieces' `dist/src/index.js`. Those are
 * gitignored build outputs produced by `prepublishOnly` (`build:workflows`),
 * so a fresh checkout legitimately has none and this check would fail for a
 * reason that has nothing to do with packaging. Their absence is also LOUD --
 * `install-version` refuses the install with an actionable message -- which is
 * exactly the property this guard exists to provide for everything else.
 */
export const REQUIRED: Requirement[] = [
  {
    path: "bin/jarvis.ts",
    why: "the hosting fleet's install-version refuses a tarball without it, and the jarvis@ unit's ExecStart runs it",
  },
  {
    path: "scripts/build-shared-runtime.ts",
    why: "the hosting fleet's install-version SILENTLY skips building the shared engine/pieces/metadata artifacts when it is absent",
  },
];

/**
 * Parse the file list out of `bun pm pack --dry-run` output.
 *
 * Lines look like `packed 21.45KB bin/jarvis.ts`; the summary footer
 * ("Total files:", "Unpacked size:") and blank lines are ignored. The path is
 * everything after the second field, so a path containing a space survives.
 */
export function parseBunPack(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    const m = /^packed\s+\S+\s+(.+)$/.exec(line.trim());
    if (m) paths.push(m[1]!.trim());
  }
  return paths;
}

/**
 * Parse the file list out of `npm pack --dry-run --json`.
 *
 * The envelope is NOT stable across npm majors: npm 11 emits an array of pack
 * entries, npm 12 an object keyed by package name. Both wrap the same
 * `{ files: [{ path }] }`, so normalize to "all entry objects" and read the
 * paths out of whichever arrived. The release job installs `npm@latest`, so
 * the shape can change under this repo without anything here being edited --
 * hence tolerating both rather than pinning to the one seen today.
 */
export function parseNpmPack(output: string): string[] {
  // npm may prepend notices to the stream; start at the first JSON delimiter
  // rather than assuming the whole thing parses.
  const start = output.search(/[[{]/);
  if (start < 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed);
  const paths: string[] = [];
  for (const entry of entries) {
    const files = (entry as { files?: unknown } | null)?.files;
    if (!Array.isArray(files)) continue;
    for (const f of files) {
      const path = (f as { path?: unknown } | null)?.path;
      if (typeof path === "string") paths.push(path);
    }
  }
  return paths;
}

/** Requirements not satisfied by `packed`. */
export function missingFrom(packed: string[], required = REQUIRED): Requirement[] {
  const have = new Set(packed);
  return required.filter((r) => !have.has(r.path));
}

/**
 * The real tarball contents, via a real packer -- NOT a re-implementation of
 * `files` semantics. A guard that models the rules instead of running them can
 * agree with itself while disagreeing with the packer.
 *
 * npm is preferred because npm is what actually publishes (release-exec.yml),
 * so on the release path this asserts against the true artifact; bun is the
 * fallback for checkouts and hooks where npm is not installed. Today the two
 * agree file-for-file, and a future divergence is precisely the thing worth
 * catching at the point of publish.
 *
 * `--ignore-scripts` keeps `prepublishOnly` out of a read-only check. It does
 * not change which paths are eligible, only whether build outputs happen to
 * exist on disk (see the REQUIRED note about piece `dist/`).
 */
function packedPaths(): { packer: string; paths: string[] } {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const haveNpm = spawnSync("npm", ["--version"], { encoding: "utf8" }).status === 0;
  const [cmd, args, parse] = haveNpm
    ? (["npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], parseNpmPack] as const)
    : (["bun", ["pm", "pack", "--dry-run", "--ignore-scripts"], parseBunPack] as const);

  const res = spawnSync(cmd, [...args], { cwd, encoding: "utf8" });
  if (res.error) throw new Error(`${cmd} pack failed to run: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`${cmd} pack exited ${res.status}: ${(res.stderr || res.stdout || "").trim()}`);
  }
  // bun writes the listing to stderr and npm to stdout; feed the parser both
  // rather than encoding which stream each one happens to use.
  return { packer: cmd, paths: parse(`${res.stdout ?? ""}\n${res.stderr ?? ""}`) };
}

function main(): void {
  const { packer, paths } = packedPaths();
  // An empty list means the parse broke (an output format change), not a
  // package with no files. Failing here beats reporting every requirement as
  // missing and sending someone to edit `files` for no reason.
  if (paths.length === 0) {
    console.error(`[check-package-files] FAILED -- could not read any packed path from ${packer}.`);
    console.error("Has its output format changed? Update the parser.");
    process.exit(1);
  }

  const missing = missingFrom(paths);
  if (missing.length === 0) {
    console.log(
      `[check-package-files] OK -- all ${REQUIRED.length} required path(s) present in the ${packer} tarball (${paths.length} files).`,
    );
    process.exit(0);
  }

  console.error("[check-package-files] FAILED -- the published tarball is missing:\n");
  for (const r of missing) {
    console.error(`  ${r.path}`);
    console.error(`           needed by: ${r.why}`);
  }
  console.error("\nAdd the path to the `files` allowlist in package.json.");
  console.error("npm versions are immutable: a release that ships without it can only be fixed forward.");
  process.exit(1);
}

if (import.meta.main) main();
