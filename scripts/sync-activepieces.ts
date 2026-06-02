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
const PRESERVE = new Set([
  "UPSTREAM.md",
  "SPIKE-SANDBOXING.md",
  "LICENSE.activepieces",
  // Jarvis-added stub. Vendored package tsconfigs all `extends` this file
  // relative to here; upstream's real one lives at their repo root which
  // we don't vendor. Without it, esbuild warns on every piece rebuild.
  "tsconfig.base.json",
]);
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
 * Strip specific lines from vendored files after sync. Originally introduced
 * to drop dangling `export * from '<path>'` lines in barrels where the target
 * dir was filtered out (EE / test-dir filters above); also used to remove
 * unsafe upstream code (e.g. a global TLS-verification bypass in the HTTP
 * client) so the next sync can't silently re-introduce it.
 *
 * Each entry is a regex of full lines to remove. Anchored to start-of-line and
 * tolerant of leading whitespace. The file must remain valid TS after removal.
 * Fails loudly if zero matches: that means upstream restructured and the entry
 * needs revisiting (either the issue is gone or the regex needs updating).
 */
const STRIP_LINES: Record<string, RegExp[]> = {
  // EE re-exports of paths we never copy.
  "packages/shared/src/index.ts": [/^\s*export \* from ['"]\.\/lib\/ee\//],
  // Test-only re-exports of dirs filtered by TEST_DIR_NAMES.
  "packages/pieces/framework/src/lib/index.ts": [/^\s*export \* from ['"]\.\/test['"];?\s*$/],
  // Upstream's HTTP client sets process.env.NODE_TLS_REJECT_UNAUTHORIZED='0'
  // on every request, which disables TLS verification process-wide (not just
  // for that one call). Webhook-triggered workflows make this an MITM hole
  // on every outbound HTTPS request JARVIS makes. Strip it; if a user
  // genuinely needs to talk to self-signed endpoints they can set the env
  // var at the daemon level themselves.
  "packages/pieces/common/src/lib/http/axios/axios-http-client.ts": [
    /^\s*process\.env\['NODE_TLS_REJECT_UNAUTHORIZED'\]\s*=\s*'0';\s*$/,
  ],
};

/**
 * Jarvis-specific source patches re-applied after each sync. Each entry names
 * a file in the vendor tree, an `anchor` regex that must match exactly one
 * line, and an `insert` payload spliced in immediately after the anchor line.
 *
 * Use sparingly: every patch here is a maintenance cost on upstream syncs.
 * Patches must be self-describing (the inserted block carries its own
 * `// Jarvis: ...` comment) so the rationale survives even without this
 * script in scope.
 */
const PATCH_INSERTIONS: Record<
  string,
  Array<{ anchor: RegExp; insert: string; position?: "before" | "after" }>
> = {
  // Polling triggers need `server.{token,apiUrl}` to call back into the
  // daemon's /v1/jarvis/* endpoints with the engineToken. The engine
  // runtime sets this unconditionally (trigger-helper.ts:137-141) but
  // upstream's TS type omitted it for POLLING; we add it here so trigger
  // code can call back without unsafe casts.
  "packages/pieces/framework/src/lib/context/index.ts": [
    {
      anchor: /^\s*setSchedule\(schedule: \{ cronExpression: string; timezone\?: string \}\): void;\s*$/,
      insert:
        "  // Jarvis: the engine runtime (trigger-helper.ts) sets `server` unconditionally\n" +
        "  // on every trigger context regardless of strategy. Upstream's type omitted it\n" +
        "  // for POLLING; we surface it here so polling triggers can call back to the\n" +
        "  // daemon's `/v1/jarvis/*` endpoints with the engineToken without unsafe casts.\n" +
        "  server: ServerContext;",
    },
  ],
  // Jarvis-only extension: optional `outputSample` declaration on actions.
  // Mirrors the long-standing `sampleData` on triggers; lets the visual
  // editor's variable picker offer `{{step.field}}` references without
  // first running the action. See the patch notes inside the inserted
  // blocks for rationale. Three insertions cover (1) the params type,
  // (2) the IAction constructor signature, (3) the createAction wiring.
  "packages/pieces/framework/src/lib/action/action.ts": [
    {
      anchor: /^\s*errorHandlingOptions\?: ErrorHandlingOptionsParam\s*$/,
      insert:
        "  // === JARVIS PATCH: optional outputSample declaration ===\n" +
        "  // Optional declaration of the action's output shape: the same JSON\n" +
        "  // the action would return on a successful run. The visual editor's\n" +
        "  // variable picker reads this so users can wire `{{step.field}}`\n" +
        "  // references without first running the action to capture sample data.\n" +
        "  // Mirrors `createTrigger().sampleData`. Leave undefined when output is\n" +
        "  // dynamic (HTTP request piece, SQL piece, LLM with parseJson).\n" +
        "  outputSample?: unknown\n" +
        "  // === END JARVIS PATCH ===",
    },
    {
      anchor: /^\s*public readonly errorHandlingOptions: ErrorHandlingOptionsParam,\s*$/,
      insert:
        "    // === JARVIS PATCH: outputSample (see CreateActionParams) ===\n" +
        "    public readonly outputSample: unknown,\n" +
        "    // === END JARVIS PATCH ===",
    },
    {
      anchor: /^\s*\)\s*$/,
      position: "before",
      insert:
        "    // === JARVIS PATCH: forward outputSample to the IAction instance ===\n" +
        "    params.outputSample,\n" +
        "    // === END JARVIS PATCH ===",
    },
  ],
  // Jarvis-only extension: outputSample on ActionBase metadata too, so the
  // piece catalog (which reads PieceMetadata.actions) can surface the
  // declared sample. Two insertions cover the zod schema and the TS type.
  "packages/pieces/framework/src/lib/piece-metadata.ts": [
    {
      // Anchored on the line ABOVE errorHandlingOptions: the zod
      // `errorHandlingOptions:` line is shared with TriggerBase below, so
      // we can't anchor on it directly (would match twice). `requireAuth:
      // z.boolean(),` is unique to ActionBase. Field order inside z.object
      // doesn't change the runtime schema.
      anchor: /^\s*requireAuth: z\.boolean\(\),\s*$/,
      insert:
        "  // === JARVIS PATCH: outputSample (see action.ts) ===\n" +
        "  outputSample: z.unknown().optional(),\n" +
        "  // === END JARVIS PATCH ===",
    },
    {
      anchor: /^\s*errorHandlingOptions\?: ErrorHandlingOptionsParam;\s*$/,
      insert:
        "  // === JARVIS PATCH: outputSample (see action.ts) ===\n" +
        "  outputSample?: unknown;\n" +
        "  // === END JARVIS PATCH ===",
    },
  ],
  // Jarvis-only: TEXT_MATCHES_REGEX + TEXT_DOES_NOT_MATCH_REGEX added
  // to the BranchOperator enum + the textConditions array + the zod
  // literal list. Anchored on the last upstream text operator so the
  // pair lands immediately after.
  "packages/shared/src/lib/automation/flows/actions/action.ts": [
    {
      anchor: /^\s*TEXT_DOES_NOT_END_WITH = 'TEXT_DOES_NOT_END_WITH',\s*$/,
      insert:
        "    // === JARVIS PATCH: regex condition operators ===\n" +
        "    // Inline regex test on a text value (firstValue against secondValue\n" +
        "    // as a JS pattern). Inline regex flags via `(?i)` etc.; caseSensitive\n" +
        "    // is ignored. Negation is a separate operator to mirror the rest of\n" +
        "    // the family.\n" +
        "    TEXT_MATCHES_REGEX = 'TEXT_MATCHES_REGEX',\n" +
        "    TEXT_DOES_NOT_MATCH_REGEX = 'TEXT_DOES_NOT_MATCH_REGEX',\n" +
        "    // === END JARVIS PATCH ===",
    },
    {
      anchor: /^\s*BranchOperator\.TEXT_DOES_NOT_END_WITH,\s*$/,
      insert:
        "    // === JARVIS PATCH: regex operators (see BranchOperator enum) ===\n" +
        "    BranchOperator.TEXT_MATCHES_REGEX,\n" +
        "    BranchOperator.TEXT_DOES_NOT_MATCH_REGEX,\n" +
        "    // === END JARVIS PATCH ===",
    },
    {
      anchor: /^\s*z\.literal\(BranchOperator\.TEXT_DOES_NOT_END_WITH\),\s*$/,
      insert:
        "    // === JARVIS PATCH: regex operators (see BranchOperator enum) ===\n" +
        "    z.literal(BranchOperator.TEXT_MATCHES_REGEX),\n" +
        "    z.literal(BranchOperator.TEXT_DOES_NOT_MATCH_REGEX),\n" +
        "    // === END JARVIS PATCH ===",
    },
  ],
  // Jarvis-only: case branches for the two regex operators added above.
  // Anchored on the closing brace of TEXT_DOES_NOT_END_WITH; insert
  // pushes the new cases right before LIST_CONTAINS so the family
  // stays grouped.
  "packages/server/engine/src/lib/handler/router-executor.ts": [
    {
      anchor: /^\s*case BranchOperator\.LIST_CONTAINS: \{\s*$/,
      position: "before",
      insert:
        "                // === JARVIS PATCH: regex operators ===\n" +
        "                // firstValue is the input string; secondValue is the JS\n" +
        "                // regex pattern (no slashes, no flags suffix). Use inline\n" +
        "                // (?i) for case-insensitive etc. -- the condition-level\n" +
        "                // `caseSensitive` flag is ignored for regex because the\n" +
        "                // pattern itself carries the modifiers. A malformed\n" +
        "                // pattern throws an EngineGenericError so the run fails\n" +
        "                // with a clear reason instead of silently never matching.\n" +
        "                case BranchOperator.TEXT_MATCHES_REGEX: {\n" +
        "                    let re: RegExp\n" +
        "                    try {\n" +
        "                        re = new RegExp(String(castedCondition.secondValue ?? ''))\n" +
        "                    } catch (err) {\n" +
        "                        throw new EngineGenericError('InvalidRegexError', `TEXT_MATCHES_REGEX: invalid pattern ${castedCondition.secondValue}: ${(err as Error).message}`)\n" +
        "                    }\n" +
        "                    andGroup = andGroup && re.test(String(castedCondition.firstValue ?? ''))\n" +
        "                    break\n" +
        "                }\n" +
        "                case BranchOperator.TEXT_DOES_NOT_MATCH_REGEX: {\n" +
        "                    let re: RegExp\n" +
        "                    try {\n" +
        "                        re = new RegExp(String(castedCondition.secondValue ?? ''))\n" +
        "                    } catch (err) {\n" +
        "                        throw new EngineGenericError('InvalidRegexError', `TEXT_DOES_NOT_MATCH_REGEX: invalid pattern ${castedCondition.secondValue}: ${(err as Error).message}`)\n" +
        "                    }\n" +
        "                    andGroup = andGroup && !re.test(String(castedCondition.firstValue ?? ''))\n" +
        "                    break\n" +
        "                }\n" +
        "                // === END JARVIS PATCH ===",
    },
  ],
  // Upstream's `flow-executor.executeFromTrigger` always calls
  // `triggerHelper.executeOnStart`, which throws `TriggerNameNotSetError`
  // when the trigger has no piece (the EMPTY / "Manual" type). Without this
  // patch, manually-triggered runs from the editor's Run button fail
  // before step 1. Anchor on the `BEGIN` branch's opening brace and insert
  // an EMPTY-trigger short-circuit that runs the bookkeeping (initial
  // backup + sendUpdate) and then walks straight into the action chain.
  "packages/server/engine/src/lib/handler/flow-executor.ts": [
    {
      anchor: /^\s*if \(input\.executionType === ExecutionType\.BEGIN\) \{\s*$/,
      insert:
        "            // === JARVIS PATCH: short-circuit for manual (EMPTY) triggers ===\n" +
        "            // Upstream unconditionally calls `triggerHelper.executeOnStart`,\n" +
        "            // which throws `TriggerNameNotSetError` whenever the trigger has\n" +
        "            // no piece (i.e. type === 'EMPTY' -- our user-facing \"Manual\"\n" +
        "            // trigger). Replicate the surrounding bookkeeping (initial-state\n" +
        "            // backup + progress update) and skip straight into the action chain.\n" +
        "            if ((trigger as { type?: string }).type === 'EMPTY') {\n" +
        "                void runProgressService.backup({\n" +
        "                    engineConstants: constants,\n" +
        "                    flowExecutorContext: executionState,\n" +
        "                }).catch((err) => {\n" +
        "                    console.error('[Progress] Initial payload upload failed', err)\n" +
        "                })\n" +
        "                await runProgressService.sendUpdate({\n" +
        "                    engineConstants: constants,\n" +
        "                    flowExecutorContext: executionState,\n" +
        "                    stepNameToUpdate: trigger.name,\n" +
        "                    startTime: dayjs().toISOString(),\n" +
        "                })\n" +
        "                return flowExecutor.execute({\n" +
        "                    action: trigger.nextAction,\n" +
        "                    executionState,\n" +
        "                    constants,\n" +
        "                })\n" +
        "            }\n" +
        "            // === END JARVIS PATCH ===",
    },
  ],
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
for (const [relPath, patterns] of Object.entries(STRIP_LINES)) {
  const dst = join(VENDOR_DIR, relPath);
  if (!existsSync(dst)) {
    fail(`strip-lines target missing: ${relPath}`);
  }
  const original = readFileSync(dst, "utf8");
  const lines = original.split("\n");
  const kept = lines.filter((line) => !patterns.some((re) => re.test(line)));
  const removed = lines.length - kept.length;
  if (removed === 0) {
    fail(`strip-lines matched 0 lines in ${relPath} -- did upstream restructure the file or fix the issue?`);
  }
  writeFileSync(dst, kept.join("\n"));
  info(`stripped ${removed} line(s) from ${relPath}`);
}
for (const [relPath, patches] of Object.entries(PATCH_INSERTIONS)) {
  const dst = join(VENDOR_DIR, relPath);
  if (!existsSync(dst)) {
    fail(`patch-insertions target missing: ${relPath}`);
  }
  const original = readFileSync(dst, "utf8");
  const lines = original.split("\n");
  const out: string[] = [];
  const matched = patches.map(() => 0);
  for (const line of lines) {
    // Pre-anchor insertions: insert ahead of the matching line so the
    // anchor itself stays in place. Used when the only unique anchor
    // available is structurally AFTER the desired insertion point.
    for (let i = 0; i < patches.length; i++) {
      if (patches[i]!.position === "before" && patches[i]!.anchor.test(line)) {
        out.push(patches[i]!.insert);
        matched[i] = (matched[i] ?? 0) + 1;
      }
    }
    out.push(line);
    for (let i = 0; i < patches.length; i++) {
      if ((patches[i]!.position ?? "after") === "after" && patches[i]!.anchor.test(line)) {
        out.push(patches[i]!.insert);
        matched[i] = (matched[i] ?? 0) + 1;
      }
    }
  }
  for (let i = 0; i < patches.length; i++) {
    if (matched[i] !== 1) {
      fail(
        `patch-insertions: anchor #${i} for ${relPath} matched ${matched[i]} time(s); expected 1. Did upstream restructure?`,
      );
    }
  }
  writeFileSync(dst, out.join("\n"));
  info(`applied ${patches.length} patch insertion(s) to ${relPath}`);
}

// 8. Defense-in-depth: walk the vendor tree and abort if any /ee/ path slipped through
assertNoEePaths(VENDOR_DIR);

// 9. Write the LICENSE alongside UPSTREAM.md
const licensePath = join(VENDOR_DIR, "LICENSE.activepieces");
writeFileSync(licensePath, upstreamLicenseText);
info(`wrote ${relative(REPO_ROOT, licensePath)}`);

// 9b. Emit the upstream pin as a TS constant the engine bundle reads at
// runtime. We used to read UPSTREAM.md directly inside `bundleHash()`,
// but that file is documentation and gets filtered out by .npmignore
// (`**/*.md`) -- so npm-installed daemons crashed on first bootstrap
// trying to readFileSync it. A generated TS file ships as code and is
// guaranteed to be in the npm tarball.
const upstreamPinPath = join(VENDOR_DIR, "upstream-pin.ts");
writeFileSync(
  upstreamPinPath,
  [
    "// AUTO-GENERATED by scripts/sync-activepieces.ts -- DO NOT EDIT BY HAND.",
    "// Captures the activepieces commit + tag this directory was vendored from.",
    "// Used as a cache-key input by the engine bundle build so a re-sync",
    "// invalidates the cached bundle even though dep versions are unchanged.",
    "",
    `export const UPSTREAM_PIN_TAG = "${PINNED_TAG}";`,
    `export const UPSTREAM_PIN_SHA = "${PINNED_SHA}";`,
    "",
  ].join("\n"),
);
info(`wrote ${relative(REPO_ROOT, upstreamPinPath)}`);

// 10. Cleanup temp dir
rmSync(work, { recursive: true, force: true });

info(`Done. Vendored ${totalFiles} files into ${relative(REPO_ROOT, VENDOR_DIR)}/.`);
info("Next: run `bun run check:no-ee` to confirm the EE guard is still green.");
