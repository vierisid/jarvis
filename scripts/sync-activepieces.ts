#!/usr/bin/env bun
/**
 * Sync vendored Activepieces source from upstream at a pinned commit.
 *
 * Usage:
 *   bun run scripts/sync-activepieces.ts             # sync to pinned SHA
 *   bun run scripts/sync-activepieces.ts --check     # verify without writing
 *
 * What it does:
 *   1. Shallow-clones https://github.com/activepieces/activepieces at PINNED_TAG into a temp dir.
 *   2. Verifies HEAD SHA matches PINNED_SHA.
 *   3. Copies the curated subset of MIT-licensed paths into src/workflows/activepieces/.
 *   4. Refuses any source path containing an `/ee/` segment (defense in depth).
 *   5. Writes LICENSE.activepieces alongside UPSTREAM.md.
 *
 * What it does NOT do:
 *   - Touch UPSTREAM.md (preserved).
 *   - Pull in packages/server/api (NestJS, replaced in Phase 2).
 *   - Pull in packages/ee/** or any /ee/ path (Activepieces Enterprise License).
 *   - Pull in packages we don't yet need (cli, web, tests-e2e, custom pieces).
 *
 * After running, re-run `bun run check:no-ee` for sanity.
 */

import { existsSync, mkdirSync, readdirSync, statSync, rmSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const PINNED_TAG = "0.82.1";
const PINNED_SHA = "d04e6807c485ecd788a72af0d04abffba78563c7";
const REMOTE = "https://github.com/activepieces/activepieces.git";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const VENDOR_DIR = join(REPO_ROOT, "src/workflows/activepieces");

/** Paths relative to upstream repo root, copied verbatim into VENDOR_DIR. */
const VENDOR_PATHS: string[] = [
  // Engine + supporting packages
  "packages/server/engine",
  "packages/shared",
  // Piece SDK and shared utils
  "packages/pieces/framework",
  "packages/pieces/common",
  // Built-in primitives (live under packages/pieces/core in upstream)
  "packages/pieces/core/approval",
  "packages/pieces/core/delay",
  "packages/pieces/core/file-helper",
  "packages/pieces/core/http",
  "packages/pieces/core/schedule",
  "packages/pieces/core/store",
  "packages/pieces/core/webhook",
  // Curated community pieces (Phase 1 set; expand later by editing this list)
  "packages/pieces/community/claude",
  "packages/pieces/community/discord",
  "packages/pieces/community/github",
  "packages/pieces/community/gmail",
  "packages/pieces/community/google-calendar",
  "packages/pieces/community/google-drive",
  "packages/pieces/community/notion",
  "packages/pieces/community/openai",
  "packages/pieces/community/slack",
  "packages/pieces/community/telegram-bot",
  // React UI for the visual builder (Vite app) + locale assets
  "packages/web",
  "packages/react-ui",
];

const EE_SEGMENT = /(^|\/)ee(\/|$)/;
const checkOnly = process.argv.includes("--check");

function run(cmd: string, args: string[], cwd?: string): { stdout: string; stderr: string; code: number } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1 };
}

function fail(msg: string): never {
  console.error(`[sync-activepieces] FAILED: ${msg}`);
  process.exit(1);
}

function info(msg: string): void {
  console.log(`[sync-activepieces] ${msg}`);
}

function assertNoEePaths(root: string): void {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const p = stack.pop()!;
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      for (const name of readdirSync(p)) stack.push(join(p, name));
    } else {
      const rel = relative(root, p);
      if (EE_SEGMENT.test(rel)) {
        fail(`copied path contains an /ee/ segment: ${rel} -- this is Enterprise-licensed and forbidden`);
      }
    }
  }
}

info(`Syncing Activepieces ${PINNED_TAG} (${PINNED_SHA.slice(0, 12)}) ${checkOnly ? "[check only]" : ""}`);

// 1. Shallow clone into a temp dir
const work = join(tmpdir(), `activepieces-sync-${PINNED_SHA.slice(0, 12)}`);
if (existsSync(work)) {
  info(`Removing stale temp dir ${work}`);
  rmSync(work, { recursive: true, force: true });
}
info(`Cloning ${REMOTE} (depth=1, branch=${PINNED_TAG}) into ${work}`);
const clone = run("git", ["clone", "--depth=1", "--branch", PINNED_TAG, REMOTE, work]);
if (clone.code !== 0) fail(`git clone failed:\n${clone.stderr}`);

// 2. Verify HEAD SHA
const sha = run("git", ["rev-parse", "HEAD"], work).stdout.trim();
if (sha !== PINNED_SHA) {
  fail(`HEAD SHA mismatch: expected ${PINNED_SHA}, got ${sha}. Tag may have been re-pointed upstream.`);
}
info(`HEAD SHA verified: ${sha}`);

// 3. Pre-flight: validate every requested vendor path exists upstream, and refuse if any contain /ee/
for (const p of VENDOR_PATHS) {
  if (EE_SEGMENT.test(p)) fail(`vendor path list contains an /ee/ segment: ${p}`);
  const abs = join(work, p);
  if (!existsSync(abs)) fail(`upstream path missing: ${p}`);
}

// 4. Copy LICENSE (top-level upstream LICENSE is MIT)
const upstreamLicense = join(work, "LICENSE");
if (!existsSync(upstreamLicense)) fail(`upstream LICENSE not found at ${upstreamLicense}`);
const upstreamLicenseText = readFileSync(upstreamLicense, "utf8");

if (checkOnly) {
  info("--check mode: no files written. Pre-flight passed.");
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
}

// 5. Wipe vendor tree except Jarvis-authored docs
mkdirSync(VENDOR_DIR, { recursive: true });
const PRESERVE = new Set(["UPSTREAM.md", "SPIKE-SANDBOXING.md", "LICENSE.activepieces"]);
for (const name of readdirSync(VENDOR_DIR)) {
  if (PRESERVE.has(name)) continue;
  rmSync(join(VENDOR_DIR, name), { recursive: true, force: true });
}

// 6. Copy each vendor path
let totalFiles = 0;
const TEST_DIR_NAMES = new Set(["test", "tests", "__tests__"]);
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;

/**
 * Files we overwrite with a Jarvis-specific stub after copy. The original
 * file's import path is preserved so vendored loaders that conditionally
 * import these paths still resolve, but the stub yells loudly if reached.
 *
 * Why we stub `v8-isolate-code-sandbox.ts`: the file is the only place in the
 * engine that reaches for `isolated-vm` (a Node N-API native addon). We run
 * the engine in `SANDBOX_PROCESS` mode (see SPIKE-SANDBOXING.md) which never
 * imports this file. Stubbing it removes our transitive dependency on the
 * native addon while keeping the import path resolvable.
 */
const STUB_FILES: Record<string, string> = {
  "packages/server/engine/src/lib/core/code/v8-isolate-code-sandbox.ts": `// THIS FILE IS A JARVIS STUB.
// The upstream activepieces engine uses \`isolated-vm\` (a Node N-API native
// addon) to run user code in a V8 isolate. Jarvis runs the engine exclusively
// in SANDBOX_PROCESS mode (see src/workflows/activepieces/SPIKE-SANDBOXING.md),
// which never reaches this file. The original implementation has been removed
// to drop the transitive native-addon dependency.
//
// If this stub is ever reached, AP_EXECUTION_MODE is set to SANDBOX_CODE_ONLY
// or SANDBOX_CODE_AND_PROCESS -- neither of which Jarvis supports. Reset
// AP_EXECUTION_MODE to SANDBOX_PROCESS.

import type { CodeSandbox } from '../../core/code/code-sandbox-common'

const message = 'v8-isolate-code-sandbox is not available in Jarvis. Use AP_EXECUTION_MODE=SANDBOX_PROCESS.'

export const v8IsolateCodeSandbox: CodeSandbox = {
    async runCodeModule() {
        throw new Error(message)
    },
    async runScript() {
        throw new Error(message)
    },
}
`,
};

/**
 * Dependencies to remove from vendored `package.json` files post-copy. The
 * file is rewritten in place; the rest of the package.json is preserved.
 */
const SCRUB_DEPS: Record<string, string[]> = {
  "packages/server/engine/package.json": ["isolated-vm"],
};

/**
 * Strip dangling `export * from '<path>'` lines from barrel files where the
 * referenced path was filtered out by the EE / test-dir filters above. Without
 * this pass the engine bundle build fails to resolve the missing modules.
 *
 * Each entry is a regex of full lines to remove. Anchored to start-of-line and
 * tolerant of leading whitespace. The barrel file must remain valid TS after
 * removal (i.e., other exports must still be present).
 */
const STRIP_EXPORT_LINES: Record<string, RegExp[]> = {
  // EE re-exports of paths we never copy.
  "packages/shared/src/index.ts": [/^\s*export \* from ['"]\.\/lib\/ee\//],
  // Test-only re-exports of dirs filtered by TEST_DIR_NAMES.
  "packages/pieces/framework/src/lib/index.ts": [/^\s*export \* from ['"]\.\/test['"];?\s*$/],
};

/**
 * Recursive copy that skips:
 *   1. Any path whose relative segment matches `/ee/` (Activepieces Enterprise-licensed,
 *      or any MIT subdirectory named `ee` that we don't vendor on principle).
 *   2. Upstream test directories and `*.test.ts` / `*.spec.ts` files. We don't run
 *      their tests against our project's tsconfig/runtime; the sync script always
 *      pulls fresh from a known SHA, so upstream tests are never load-bearing here.
 */
function copyFiltered(src: string, dst: string, base: string): number {
  const relFromBase = relative(base, src);
  if (relFromBase && EE_SEGMENT.test(relFromBase)) return 0;
  const s = statSync(src);
  const baseName = src.split("/").pop() ?? "";
  if (s.isDirectory()) {
    if (TEST_DIR_NAMES.has(baseName)) return 0;
    mkdirSync(dst, { recursive: true });
    let n = 0;
    for (const name of readdirSync(src)) {
      n += copyFiltered(join(src, name), join(dst, name), base);
    }
    return n;
  }
  if (TEST_FILE_RE.test(baseName)) return 0;
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  return 1;
}

for (const p of VENDOR_PATHS) {
  const src = join(work, p);
  const dst = join(VENDOR_DIR, p);
  const n = copyFiltered(src, dst, src);
  totalFiles += n;
  info(`copied ${p} (${n} files)`);
}

// 7. Apply Jarvis-specific stubs and dependency scrubs.
for (const [relPath, contents] of Object.entries(STUB_FILES)) {
  const dst = join(VENDOR_DIR, relPath);
  if (!existsSync(dst)) {
    fail(`stub target missing: ${relPath} -- did upstream rename or move it?`);
  }
  writeFileSync(dst, contents);
  info(`stubbed ${relPath}`);
}
for (const [relPath, depNames] of Object.entries(SCRUB_DEPS)) {
  const dst = join(VENDOR_DIR, relPath);
  if (!existsSync(dst)) {
    fail(`scrub target missing: ${relPath}`);
  }
  const pkg = JSON.parse(readFileSync(dst, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  let removed = 0;
  if (pkg.dependencies) {
    for (const dep of depNames) {
      if (dep in pkg.dependencies) {
        delete pkg.dependencies[dep];
        removed++;
      }
    }
  }
  writeFileSync(dst, JSON.stringify(pkg, null, 2) + "\n");
  info(`scrubbed ${removed} dep(s) from ${relPath}: [${depNames.join(", ")}]`);
}
for (const [relPath, patterns] of Object.entries(STRIP_EXPORT_LINES)) {
  const dst = join(VENDOR_DIR, relPath);
  if (!existsSync(dst)) {
    fail(`strip-exports target missing: ${relPath}`);
  }
  const original = readFileSync(dst, "utf8");
  const lines = original.split("\n");
  const kept = lines.filter((line) => !patterns.some((re) => re.test(line)));
  const removed = lines.length - kept.length;
  if (removed === 0) {
    fail(`strip-exports matched 0 lines in ${relPath} -- did upstream restructure the barrel?`);
  }
  writeFileSync(dst, kept.join("\n"));
  info(`stripped ${removed} export line(s) from ${relPath}`);
}

// 8. Defense-in-depth: walk the vendor tree and abort if any /ee/ path slipped through
assertNoEePaths(VENDOR_DIR);

// 9. Write the LICENSE alongside UPSTREAM.md
const licensePath = join(VENDOR_DIR, "LICENSE.activepieces");
writeFileSync(licensePath, upstreamLicenseText);
info(`wrote ${relative(REPO_ROOT, licensePath)}`);

// 10. Cleanup temp dir
rmSync(work, { recursive: true, force: true });

info(`Done. Vendored ${totalFiles} files into ${relative(REPO_ROOT, VENDOR_DIR)}/.`);
info("Next: run `bun run check:no-ee` to confirm the EE guard is still green.");
