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
 * The envelope is NOT stable across npm majors: npm 10 and 11 emit an array of
 * pack entries, npm 12 an object keyed by package name. Both wrap the same
 * `{ files: [{ path }] }`, so normalize to "all entry objects" and read the
 * paths out of whichever arrived. The release job installs `npm@latest`, so
 * the shape can change under this repo without anything here being edited --
 * hence tolerating both rather than pinning to the one seen today.
 *
 * npm also prefixes warnings, and a warning can itself contain a bracket, so
 * every candidate start offset is tried rather than just the first. Returning
 * [] is a normal outcome, not an error: the caller falls back to another
 * packer rather than failing the build over an output quirk.
 */
export function parseNpmPack(output: string): string[] {
  for (const m of output.matchAll(/[[{]/g)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(output.slice(m.index));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
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
    if (paths.length > 0) return paths;
  }
  return [];
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
 * npm is tried first because npm is what actually publishes (release-exec.yml),
 * so on the release path this asserts against the true artifact. bun is the
 * fallback, and it is a FALLBACK rather than an alternative: this guard exists
 * to fail when a shipped-by-path file goes missing, and failing instead because
 * some npm build printed something the parser did not expect would be a check
 * that cries wolf -- which is how a guard gets deleted. It only gives up when
 * NO packer produced a file list, which really is a broken check.
 *
 * `--ignore-scripts` keeps `prepublishOnly` out of a read-only check. It does
 * not change which paths are eligible, only whether build outputs happen to
 * exist on disk (see the REQUIRED note about piece `dist/`).
 */
function packedPaths(): { packer: string; paths: string[]; notes: string[] } {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const haveNpm = spawnSync("npm", ["--version"], { encoding: "utf8" }).status === 0;
  const attempts: Array<{ cmd: string; args: string[]; parse: (out: string) => string[] }> = [
    ...(haveNpm
      ? [
          {
            cmd: "npm",
            args: ["pack", "--dry-run", "--json", "--ignore-scripts"],
            parse: parseNpmPack,
          },
        ]
      : []),
    { cmd: "bun", args: ["pm", "pack", "--dry-run", "--ignore-scripts"], parse: parseBunPack },
  ];

  const notes: string[] = [];
  for (const a of attempts) {
    const res = spawnSync(a.cmd, a.args, { cwd, encoding: "utf8" });
    if (res.error) {
      notes.push(`${a.cmd}: could not run (${res.error.message})`);
      continue;
    }
    if (res.status !== 0) {
      notes.push(`${a.cmd}: exited ${res.status} (${(res.stderr || res.stdout || "").trim().slice(0, 200)})`);
      continue;
    }
    // npm writes its JSON to stdout and bun writes its listing to stderr, so
    // feed each parser both rather than encoding which stream one happens to
    // use today.
    const paths = a.parse(`${res.stdout ?? ""}\n${res.stderr ?? ""}`);
    if (paths.length > 0) return { packer: a.cmd, paths, notes };
    notes.push(`${a.cmd}: ran cleanly but produced no parseable file list`);
  }
  return { packer: "none", paths: [], notes };
}

function main(): void {
  const { packer, paths, notes } = packedPaths();
  // No packer produced a list at all: the CHECK is broken, not the package.
  // Failing here beats reporting every requirement as missing and sending
  // someone to edit `files` for no reason.
  if (paths.length === 0) {
    console.error("[check-package-files] FAILED -- no packer produced a file list:");
    for (const n of notes) console.error(`  ${n}`);
    console.error("\nThis is a broken check, not a broken package. Fix the parser.");
    process.exit(1);
  }
  // Say which packer answered, and why any earlier one did not. A silent
  // fallback would hide npm breaking on the very path that publishes.
  for (const n of notes) console.warn(`[check-package-files] note: ${n}`);

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
