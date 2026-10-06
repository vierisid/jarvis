/**
 * Build the activepieces engine into a single CJS bundle that the daemon can
 * spawn as a child process. Mirrors upstream's `engine/esbuild.config.mjs` so
 * the bundle layout matches what the engine expects when it boots.
 *
 * Why our own builder script (instead of just calling `bun run build` in the
 * vendored engine dir): upstream's config writes to `dist/packages/engine/`
 * relative to the activepieces monorepo root, and it relies on `workspace:*`
 * deps being installed by the upstream pnpm workspace. We don't have that
 * workspace; instead, we synthesize a small staging directory containing only
 * the engine's third-party deps, install them with `bun install`, then run
 * esbuild with explicit aliases pointing the workspace deps at the vendored
 * source we already shipped in `src/workflows/activepieces/`.
 *
 * Staging lives outside the repo (under `~/.jarvis/cache/engine-build`) so
 * `node_modules` from the engine build never pollutes the project tree.
 *
 * Bundle output is content-addressed: hash of the synthesized package.json +
 * UPSTREAM.md (which pins the activepieces commit). Re-running with the same
 * inputs short-circuits to the cached bundle.
 */

import { spawn } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  utimesSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { UPSTREAM_PIN_SHA, UPSTREAM_PIN_TAG } from "../../activepieces/upstream-pin";
import { ENGINE_LIFECYCLE_SHIM } from "./engine-lifecycle";
import { sanitizedEnv } from "../../../util/subprocess-env";
import { BUN_INSTALL_ARGS, SANITIZED_INSTALL_HINT } from "../../../util/sanitized-install";
import { pinVerifiedBundle, sha256OfFile } from "./bundle-integrity";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPO_ROOT = resolve(__dirname, "../../../..");
const VENDOR_PACKAGES = resolve(REPO_ROOT, "src/workflows/activepieces/packages");
const ENGINE_DIR = resolve(VENDOR_PACKAGES, "server/engine");

const CACHE_ROOT = resolve(homedir(), ".jarvis/cache");
const STAGING_DIR = resolve(CACHE_ROOT, "engine-build");
const BUNDLE_ROOT = resolve(CACHE_ROOT, "engine");

/**
 * Optional read-only SHARED bundle root (multi-tenant hosting): the host
 * builds the bundle once per installed version and points every instance at
 * it via this env var. Consulted before the per-user BUNDLE_ROOT; never
 * written to — builds always land in the user's own cache, so a shared-root
 * miss degrades to a local build instead of an EACCES on a root-owned tree.
 */
function sharedBundleRoot(explicit?: string | null): string | null {
  // `undefined` = caller didn't resolve one (env fallback); `null` = the
  // caller resolved "no shared root" (don't consult the env).
  if (explicit !== undefined) return explicit ? resolve(explicit) : null;
  const dir = process.env.JARVIS_ENGINE_CACHE_ROOT?.trim();
  return dir ? resolve(dir) : null;
}

/** esbuild version pinned to match what activepieces uses upstream. */
const ESBUILD_VERSION = "0.24.0";

export interface EngineBundle {
  bundlePath: string;
  hash: string;
  /** Absolute path to the directory containing the bundle (useful as cwd for the spawned engine). */
  bundleDir: string;
}

/**
 * Workspace package.json files whose third-party deps the engine bundle
 * pulls in transitively. Their `workspace:*` references are resolved by
 * esbuild aliases (see `buildEngineBundle` below) so we only collect their
 * non-workspace dependencies.
 */
const WORKSPACE_PKG_RELS = [
  "server/engine/package.json",
  "shared/package.json",
  "pieces/framework/package.json",
  "pieces/common/package.json",
] as const;

/**
 * Security floor for transitive deps the staging install resolves. When a
 * vendored manifest pins a dep at a version with a known advisory reachable
 * from JARVIS (e.g. axios in pieces/common feeds the HTTP node, which webhook
 * triggers can drive with untrusted internet payloads), pin it here. The floor
 * is injected into the synthesized staging package.json as a bun `overrides`
 * entry, which wins over the manifest pin during `bun install`.
 *
 * Triage when Dependabot flags a new vendored dep:
 *
 *   1. Does the dep appear in any WORKSPACE_PKG_RELS manifest as a non-dev
 *      dependency? If no -> add to .github/dependabot.yml ignore. The dep
 *      doesn't ship via this staging install; the alert is noise.
 *
 *   2. Is the vulnerability reachable from untrusted input (webhook payloads,
 *      LLM-generated workflow params, etc.)? If no -> add to ignore with a
 *      short "not reachable" note.
 *
 *   3. If reachable: is upstream already patched in a version we can sync?
 *      If yes -> bump via upstream sync. If no -> add a SECURITY_FLOOR entry
 *      here, link the advisory.
 *
 * Entries here are FLOORS, not clamps: when upstream's pin catches up to or
 * exceeds the floor, the override is skipped and the build logs a one-line
 * notice so the dead entry can be cleaned up by hand. No silent downgrade.
 */
const SECURITY_FLOOR: Record<string, string> = {
  // pieces/common pins axios@1.15.0 exact; the HTTP node uses axios for all
  // outbound requests. Webhook-triggered workflows can drive that node with
  // untrusted payload data (URLs, headers), so SSRF/DoS classes in 1.15.x
  // are reachable in production. 1.16.1 is the first patched release.
  // GHSA-3g43-6gmg-66jw, GHSA-35jp-ww65-95wh, GHSA-pf86-5x62-jrwf.
  axios: "1.16.1",
};

/**
 * Compare two pinned/range versions for the "floor satisfied?" check.
 * Tolerantly strips ^ / ~ prefixes and compares numerically. Sufficient for
 * vendored manifests which use exact pins; if upstream ever switches to
 * caret ranges we still answer "yes, floor is satisfied" correctly because
 * we compare against the minimum of the range.
 */
function versionMeetsFloor(declared: string, floor: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const parts = v.replace(/^[\^~>=<\s]+/, "").split(".");
    return [
      parseInt(parts[0] ?? "0", 10) || 0,
      parseInt(parts[1] ?? "0", 10) || 0,
      parseInt(parts[2] ?? "0", 10) || 0,
    ];
  };
  const [da, db, dc] = parse(declared);
  const [fa, fb, fc] = parse(floor);
  if (da !== fa) return da > fa;
  if (db !== fb) return db > fb;
  return dc >= fc;
}

/**
 * Synthesize the staging-dir package.json: union of every non-workspace dep
 * across the four workspace packages the engine bundle imports, plus esbuild.
 * Applies SECURITY_FLOOR via the `overrides` block when upstream's declared
 * version sits below the floor. On dep version conflict between manifests,
 * the latest entry wins -- we'd flag in CI if this ever matters, but in
 * practice the workspace pkgs all share pinned versions.
 */
function buildStagingPackageJson(): string {
  const deps: Record<string, string> = {};
  for (const rel of WORKSPACE_PKG_RELS) {
    const pkg = JSON.parse(
      readFileSync(resolve(VENDOR_PACKAGES, rel), "utf8"),
    ) as { dependencies?: Record<string, string> };
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (!String(version).startsWith("workspace:")) {
        deps[name] = version;
      }
    }
  }
  deps["esbuild"] = ESBUILD_VERSION;

  const overrides: Record<string, string> = {};
  for (const [name, floor] of Object.entries(SECURITY_FLOOR)) {
    const declared = deps[name];
    if (!declared) {
      // Dep removed upstream; the floor entry is dead and can be deleted.
      console.warn(
        `[engine-build] SECURITY_FLOOR entry '${name}' has no matching dep in vendored manifests; remove it.`,
      );
      continue;
    }
    if (versionMeetsFloor(declared, floor)) {
      // stderr: build tooling stdout may be captured as machine-readable
      // output (build-shared-runtime's summary) — diagnostics never go there.
      console.warn(
        `[engine-build] SECURITY_FLOOR '${name}@${floor}' satisfied by upstream '${declared}'; remove entry.`,
      );
      continue;
    }
    overrides[name] = floor;
  }

  return JSON.stringify(
    {
      name: "jarvis-engine-build-staging",
      private: true,
      type: "commonjs",
      dependencies: deps,
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    },
    null,
    2,
  );
}

/**
 * Vendored engine source files we patch directly in this fork. Their content
 * MUST flow into the bundle hash, otherwise a patch (e.g., the piece-loader
 * shared-`node_modules` discovery branch) would be served stale from cached
 * bundles. Listed explicitly -- relative to VENDOR_PACKAGES -- so adding a
 * new patch is a one-line cache-invalidation registration.
 */
export const PATCHED_VENDOR_SOURCES = [
  '../../runtime/safe-expression.ts',
  '../../runtime/input-validation.ts',
  '../../runtime/resolved-input-guard.ts',
  '../../runtime/router-presence.ts',
  '../../../lib/cron-scheduler.ts',
  'server/engine/src/lib/helper/trigger-helper.ts',
  // Jarvis: the governed-piece admission gate. The adapter table and the
  // engine-side client are daemon sources compiled INTO the bundle, so editing
  // either without registering them here would leave a cached engine running
  // the old table -- a stale bundle that silently governs the wrong actions.
  '../../runtime/piece-effects.ts',
  '../../runtime/piece-effect-guard.ts',
  // The CODE-step sandbox builds its child's env from this allowlist, so it is
  // compiled into the bundle too: widening or narrowing the allowlist has to
  // reach the engine, not just the daemon. The cost, accepted over keeping a
  // third copy of the list: ANY edit to that file, a comment included,
  // invalidates every cached engine bundle and compiled piece, on every
  // instance and shared root.
  '../../../util/subprocess-env.ts',
  'server/engine/src/lib/core/code/no-op-code-sandbox.ts',
  'server/engine/src/lib/variables/props-resolver.ts',
  'server/engine/src/lib/variables/props-processor.ts',
  'server/engine/src/lib/handler/piece-executor.ts',
  "server/engine/src/lib/helper/piece-loader.ts",
  // Jarvis-only `outputSample` extension on actions + the matching
  // ActionBase change. Hand-edits to these files (or a sync that
  // re-applies the patch in a different shape) must invalidate the
  // engine bundle and, transitively, every piece's compiled output --
  // otherwise the cached bundle keeps shipping the OLD framework even
  // though the source on disk has changed.
  "pieces/framework/src/lib/action/action.ts",
  "pieces/framework/src/lib/piece-metadata.ts",
  // Jarvis-only BranchOperator additions (TEXT_MATCHES_REGEX +
  // negation) and the matching router-executor cases. Hand-edits or
  // sync re-applications change the bundle hash so the cached engine
  // doesn't ship the OLD operator list / executor.
  "shared/src/lib/automation/flows/actions/action.ts",
  "server/engine/src/lib/handler/router-executor.ts",
  // Jarvis: the executeFromTrigger short-circuit that runs a flow's steps when
  // its trigger has no piece to start (the EMPTY "Manual" trigger, AND a
  // non-manual trigger — e.g. SCHEDULE — invoked manually from the Run button).
  // Without registering it here, editing that patch left the OLD engine cached
  // and the fix never shipped — which is exactly how a stale bundle kept
  // throwing TriggerNameNotSetError after the patch was generalized.
  "server/engine/src/lib/handler/flow-executor.ts",
  // Jarvis: upstream sets process.env.NODE_TLS_REJECT_UNAUTHORIZED='0'
  // on every HTTP-node request, which disables TLS verification for the
  // entire Node process (not just the one request). We strip that line
  // via STRIP_LINES in sync-activepieces.ts; if a sync ever re-introduces
  // it, the file content here changes and the bundle hash invalidates so
  // the cached engine doesn't keep shipping the OLD bypass.
  "pieces/common/src/lib/http/axios/axios-http-client.ts",
  // The remaining files sync-activepieces.ts patches (STUB_FILES / STRIP_LINES /
  // PATCH_INSERTIONS) — registered so ANY of them changing invalidates the
  // bundle, closing the same stale-engine gap flow-executor.ts hit. Keep this
  // set in sync with the sync script's patch tables; a file it patches but this
  // list omits is served stale from cache.
  "server/engine/src/lib/core/code/v8-isolate-code-sandbox.ts", // STUB_FILES
  "pieces/framework/src/lib/context/index.ts", // PATCH_INSERTIONS
  "shared/src/index.ts", // STRIP_LINES
  "pieces/framework/src/lib/index.ts", // STRIP_LINES
] as const;

/**
 * Prepended to the engine bundle, so it runs before any piece module is
 * imported.
 *
 * A BROWSER resolves a relative or empty Request URL against the document
 * base; Bun has no base and throws `Failed to construct 'Request': url is
 * required`. Bun also defines `self`, so bundles that sniff for a browser take
 * the browser branch and then hit that throw. The abortcontroller-polyfill
 * does exactly this AT MODULE LOAD:
 *
 *     I4 = typeof window < "u" ? window : typeof self < "u" ? self : null;
 *     I4 ? ("signal" in new Request("")) ? ... : ...
 *
 * It reaches us bundled inside the airtable SDK, so importing
 * `@activepieces/piece-airtable` throws before a single line of our code runs
 * and EXTRACT_PIECE_METADATA reports INTERNAL_ERROR. Reproduced with nothing
 * but `bun -e 'await import("@activepieces/piece-airtable")'`.
 *
 * So resolve against a dummy base, which is what the browser these bundles
 * think they are running in would do. STRICTLY ADDITIVE: an input that already
 * builds a Request is passed through untouched, and only one that would have
 * THROWN is resolved, so nothing that works today changes. The probe then
 * succeeds and the polyfill selects the NATIVE AbortController.
 *
 * `self` is deliberately left alone. Deleting it also fixes this piece, but
 * UMD wrappers commonly do `typeof self !== "undefined" ? self : this`, and
 * `this` is undefined in an ES module -- a broader blast radius than the one
 * invalid input this replaces. `Symbol.hasInstance` delegates to the native
 * constructor so `x instanceof Request` stays true for Requests built by
 * fetch internals.
 */
/**
 * The path-free half of the esbuild configuration: everything that changes the
 * OUTPUT rather than where it lands. `bundleHash` hashes this whole object, so
 * adding a define, changing the target, or removing the banner below all
 * invalidate cached bundles by themselves.
 *
 * Hashing the banner CONSTANT instead would not: deleting the `banner:` line
 * while leaving the constant in the file changes what the engine executes and
 * leaves the key untouched, which is the same stale-bundle trap
 * PATCHED_VENDOR_SOURCES exists to close. Paths stay out because they differ
 * per machine and must not fragment the cache.
 */
export const ENGINE_ESBUILD_CONFIG = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  minifySyntax: true,
  minifyWhitespace: true,
  metafile: true,
  // isolated-vm intentionally excluded -- we only run SANDBOX_PROCESS mode
  // (see SPIKE-SANDBOXING.md). utf-8-validate / bufferutil are optional ws deps.
  external: ["isolated-vm", "utf-8-validate", "bufferutil"],
  get banner() {
    // Lifecycle shim FIRST: it installs the SIGTERM/SIGINT handlers and the
    // orphan watchdog, and its handler must be registered before upstream's
    // run-progress listener (which flushes but never exits) so the flush runs
    // inside a window that ends in an exit. See engine-lifecycle.ts.
    return { js: `${ENGINE_LIFECYCLE_SHIM}\n${ENGINE_REQUEST_BASE_SHIM}` };
  },
} as const;

export const ENGINE_REQUEST_BASE_SHIM = `(() => {
  const NativeRequest = globalThis.Request;
  if (typeof NativeRequest !== "function") return;
  class Request extends NativeRequest {
    constructor(input, init) {
      if (typeof input === "string") {
        try { new URL(input); } catch { input = new URL(input, "http://localhost/").href; }
      }
      super(input, init);
    }
  }
  Object.defineProperty(Request, Symbol.hasInstance, {
    value: (x) => x instanceof NativeRequest,
  });
  globalThis.Request = Request;
})();`;

/**
 * Cache key combines the synthesized package.json (which captures dep versions),
 * the vendored upstream pin (tag + SHA shipped as a generated TS constant
 * by `sync-activepieces.ts`), and the content of any vendored source files
 * we've patched. The pin replaces a runtime `readFileSync(UPSTREAM.md)`
 * that crashed on npm-installed daemons -- markdown files get filtered
 * out by `.npmignore`, but a TS constant ships as code.
 */
export function bundleHash(): string {
  const pkg = buildStagingPackageJson();
  const hasher = createHash("sha256")
    .update(pkg)
    .update("\0")
    .update(UPSTREAM_PIN_TAG)
    .update("\0")
    .update(UPSTREAM_PIN_SHA);
  for (const rel of PATCHED_VENDOR_SOURCES) {
    const content = readFileSync(resolve(VENDOR_PACKAGES, rel), "utf8");
    hasher.update("\0").update(rel).update("\0").update(content);
  }
  // The build CONFIG is a patch too: it changes the bytes the engine executes,
  // just from our own options rather than a vendored file. Leaving it out of
  // the key would serve the OLD engine from cache to every host that already
  // has a bundle for this hash -- the exact stale-engine trap the list above
  // exists to close -- and hashing only the banner constant would miss the
  // banner being UNWIRED, or the target changing.
  hasher
    .update("\0")
    .update("esbuild-config")
    .update("\0")
    .update(JSON.stringify(ENGINE_ESBUILD_CONFIG));
  return hasher.digest("hex").slice(0, 16);
}

// Memoized install promise: every caller awaits the SAME pending
// `bun install` and we never spawn two concurrent installs against the
// same staging dir. Cleared on rejection so a transient failure can be
// retried by the next caller.
let stagingInstallInFlight: Promise<void> | null = null;

export function ensureStagingInstalled(): Promise<void> {
  if (stagingInstallInFlight) return stagingInstallInFlight;
  stagingInstallInFlight = (async (): Promise<void> => {
    mkdirSync(STAGING_DIR, { recursive: true });
    const pkgPath = resolve(STAGING_DIR, "package.json");
    const desired = buildStagingPackageJson();
    const existing = existsSync(pkgPath) ? readFileSync(pkgPath, "utf8") : null;
    const haveNodeModules = existsSync(resolve(STAGING_DIR, "node_modules"));
    if (existing === desired && haveNodeModules) return;

    writeFileSync(pkgPath, desired);

    await new Promise<void>((res, rej) => {
      // Third-party packages, none of which need the daemon's secrets. The
      // allowlist keeps what bun needs (PATH, HOME, proxies, registry and CA
      // settings); lifecycle scripts are skipped -- see BUN_INSTALL_ARGS.
      const child = spawn("bun", [...BUN_INSTALL_ARGS], {
        cwd: STAGING_DIR,
        stdio: "inherit",
        env: sanitizedEnv(),
      });
      child.on("close", (code) => {
        if (code === 0) res();
        else rej(new Error(`bun install (engine staging) exited with code ${code}. ${SANITIZED_INSTALL_HINT}`));
      });
      child.on("error", rej);
    });
  })().catch((e) => {
    stagingInstallInFlight = null;
    throw e;
  });
  return stagingInstallInFlight;
}

export async function buildEngineBundle(opts?: {
  force?: boolean;
  sharedRoot?: string | null;
}): Promise<EngineBundle> {
  // A shared prebuilt bundle short-circuits the whole build — including the
  // staging install, which would otherwise cost every tenant a ~47 MB
  // node_modules just to discover the bundle already exists.
  const shared = opts?.force ? { kind: "miss" as const } : findSharedBundle(opts?.sharedRoot);
  if (shared.kind === "hit") return shared.bundle;

  await ensureStagingInstalled();

  const hash = bundleHash();
  const bundleDir = resolve(BUNDLE_ROOT, hash);
  const bundlePath = resolve(bundleDir, "main.js");

  // A REFUSED shared bundle must not be answered by ADOPTING whatever sits in
  // the per-user cache (#624). The line below accepts a pre-existing main.js on
  // `existsSync` alone -- which is correct for its own case (same uid, this
  // daemon built it) and wrong as the answer to a failed verification: the
  // shared root is host-owned and read-only to the tenant, BUNDLE_ROOT is
  // tenant-writable, and `bundleHash()` is computable by anyone who can read
  // the install, so the target path is predictable. Degrading from an
  // unverified host-owned bundle to an unverified tenant-writable one is the
  // wrong direction in exactly the hosting shape this root exists for.
  //
  // So a refusal degrades to a BUILD, not to an adoption. That costs the
  // staging install, which is the cost the warning already announces.
  if (!opts?.force && shared.kind !== "refused" && existsSync(bundlePath)) {
    return { bundlePath, hash, bundleDir };
  }

  mkdirSync(bundleDir, { recursive: true });

  const esbuildEntry = resolve(STAGING_DIR, "node_modules/esbuild/lib/main.js");
  if (!existsSync(esbuildEntry)) {
    throw new Error(
      `esbuild not found at ${esbuildEntry}. Did the staging install fail?`,
    );
  }
  // esbuild lives only in the staging dir's node_modules, so we don't take a
  // direct dep on it at the project level. Declared locally with the surface
  // we actually use rather than pulling in @types/esbuild.
  const esbuild = (await import(esbuildEntry)) as {
    build(options: Record<string, unknown>): Promise<{ metafile: unknown }>;
  };

  const result = await esbuild.build({
    // The hashed config first, then only the path-dependent options. Anything
    // that changes the output must live in ENGINE_ESBUILD_CONFIG or it is
    // outside the cache key.
    ...ENGINE_ESBUILD_CONFIG,
    entryPoints: [resolve(ENGINE_DIR, "src/main.ts")],
    outfile: bundlePath,
    alias: {
      "@activepieces/shared": resolve(VENDOR_PACKAGES, "shared/src"),
      "@activepieces/pieces-framework": resolve(VENDOR_PACKAGES, "pieces/framework/src"),
      "@activepieces/pieces-common": resolve(VENDOR_PACKAGES, "pieces/common/src"),
    },
    nodePaths: [resolve(STAGING_DIR, "node_modules")],
    logLevel: "warning",
  });

  writeFileSync(bundlePath + ".meta.json", JSON.stringify(result.metafile));

  return { bundlePath, hash, bundleDir };
}

export const ENGINE_BUILD_PATHS = {
  REPO_ROOT,
  VENDOR_PACKAGES,
  ENGINE_DIR,
  CACHE_ROOT,
  STAGING_DIR,
  BUNDLE_ROOT,
} as const;

/**
 * A shared-root lookup. `miss` and `refused` are kept apart because they call
 * for different fallbacks: a miss is answered by the per-user cache, a refusal
 * must not be (see `buildEngineBundle`).
 */
type SharedBundleLookup =
  | { kind: "hit"; bundle: EngineBundle }
  | { kind: "miss" }
  | { kind: "refused" };

/**
 * One line of CONFIG text, safe to put in a log a person and a model both read.
 *
 * The path is operator-supplied by design and naming it is the whole point of
 * the warning, so this is not about secrecy. It is about forgery: a path
 * component may contain a newline, and `JARVIS_ENGINE_CACHE_ROOT` is in
 * `JARVIS_SETTINGS_ENV_NAMES`, i.e. deliberately forwarded to model-directed
 * children -- so a model that can start a daemon can choose this string. A
 * newline would let it write its own log lines; the `<<<` tokens would let it
 * disclaim whatever follows. Same reasoning as `boundedReceiptText` (#634),
 * done locally because this module is the engine BUILDER and must not grow an
 * import into the daemon's role machinery.
 */
function logSafePath(value: string): string {
  // `Zl`/`Zp` as well as `Cc`/`Cf`: U+2028 LINE SEPARATOR and U+2029 PARAGRAPH
  // SEPARATOR are line terminators to a JavaScript parser and to several log
  // shippers, and neither is a control or format character, so the first two
  // classes miss exactly the two code points a forger would reach for next.
  const flat = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "?").replaceAll("<<<", "(((").replaceAll(">>>", ")))");
  // `.toWellFormed()` AFTER the cut, for the reason `defangDelimiters` repairs
  // ill-formed UTF-16 at all: a fixed-length slice can land between the halves
  // of a surrogate pair, and a lone surrogate is rejected outright by some
  // providers and silently dropped by some serialisers -- the second of which
  // can bring two halves of a marker back together.
  return (flat.length > 400 ? flat.slice(0, 400) + "...(truncated)" : flat).toWellFormed();
}

/**
 * The digest a `.sha256` manifest names, out of the two shapes a publisher
 * actually produces.
 *
 * NEITHER NORMALISATION IS A WEAKENING, which is the only thing that matters
 * here, and both are stated because "be lenient about the input to a security
 * check" is normally the wrong instinct.
 *
 *   - The FIRST whitespace-delimited token. `sha256sum FILE > FILE.sha256` --
 *     the obvious command, and what anyone publishing a shared root by rsync or
 *     a tarball will reach for -- writes `<hash>  <filename>`. Only the
 *     Dockerfile's `| cut -d' ' -f1` avoided it in this tree. The second field
 *     is a filename, carries no integrity information, and dropping it leaves
 *     the comparison on exactly the same 64 characters.
 *   - LOWERCASED. Hex is case-insensitive by definition, so `AB` and `ab` are
 *     the same number; comparing them case-sensitively rejects a correct digest
 *     rather than accepting a wrong one. The value space is unchanged.
 *
 * What is NOT relaxed: the comparison itself stays full-string equality against
 * the real hash, so a truncated, padded, multi-digest or empty manifest still
 * refuses. Before this, all four of those and both shapes above landed in
 * `digest_mismatch` and logged `manifest says <not a sha256 digest>` -- which an
 * operator reads as corruption, not as a format mistake, and #624 turned that
 * from a silent fallback into every tenant on the host losing its shared
 * bundle. Getting the format wrong must not look like getting the bytes wrong.
 */
function manifestDigest(contents: string): string {
  return (contents.trim().split(/\s+/u)[0] ?? "").toLowerCase();
}

/**
 * Say why a shared root was not used, and refuse it.
 *
 * Warned EVERY time rather than once per path+reason. It is a refusal on a cold
 * path -- `findCachedBundle` is called per engine resolution, not per request --
 * and a memo keyed on the reason silently swallows the two cases an operator
 * most needs: the same failure recurring after a repair, and a tree that is
 * swapped under a long-lived daemon. `reason=` is a stable token so a fleet can
 * alert on it instead of reading prose.
 */
function refuseSharedBundle(bundlePath: string, reason: string, detail: string): { kind: "refused" } {
  console.warn(`[engine] shared bundle REFUSED reason=${reason} path=${logSafePath(bundlePath)}: ${detail}`);
  return { kind: "refused" };
}

/** The shared-root bundle for the current source hash, if it verifies.
 *
 * `main.js` out of this tree is spawned as the workflow engine with the
 * daemon's authority, and the directory NAME hashes build INPUTS, not output --
 * so without a content check the store would be content-addressed in name only.
 * The builder's `main.js.sha256` is that check.
 *
 * THE MANIFEST IS REQUIRED, not optional (#624). It used to be consulted only
 * `if (existsSync(manifestPath))`, so a verification was enabled by the
 * presence of the very thing it verified against -- which is not a
 * verification. Making absence behave exactly like a mismatch leaves one
 * contract instead of two, and turns "this tree was not produced by a known
 * good producer, or was produced partially" into a refusal instead of a pass.
 *
 * WHAT THIS IS NOT, stated because it is easy to claim more. It is NOT an
 * anti-tamper control, and requiring the manifest does not make it one: in both
 * producers the digest sits beside the bundle with the same ownership, written
 * by the same step, so anything that can replace `main.js` can replace the
 * digest beside it. `Dockerfile`'s own comment on the engine-cache COPY says
 * this already. Nor does it detect corruption introduced BY the producer --
 * `scripts/build-shared-runtime.ts` digests the bytes it just copied, read back
 * from the destination, so a truncated copy yields a self-consistent manifest.
 * And the trust root itself is chosen by configuration: `workflows.engine_dir`
 * or `JARVIS_ENGINE_CACHE_ROOT`, the latter forwarded into model-directed
 * children. Whoever sets that sets what is trusted. A real anti-tamper control
 * is a detached signature over the bundle, verified against a key the tenant
 * tree cannot write, plus a read-only mount -- a different change.
 *
 * What it DOES buy: an unconditional delivery-integrity and operator-error
 * check (a truncated copy, a bad layer pull, a tree published without its
 * digest) where it used to be opt-in, and the removal of a fail-open.
 *
 * EXECUTION-TIME INTEGRITY is pinned, not re-derived (#671). Verification
 * happens once, HERE, at resolution, and the path is then carried on the
 * `EngineRuntime` and spawned many times over the daemon's whole life. So a hit
 * pins the digest it just computed (`pinVerifiedBundle`), and `spawnEngine`
 * re-hashes the file and refuses bytes that differ -- which narrows the window
 * between check and use from the daemon's lifetime to the spawn itself. It
 * does not close it (the engine opens the file after the check, and modules it
 * leaves external are resolved from beside it -- see bundle-integrity.ts);
 * that is an immutable mount. `piece-catalog`'s cache key also re-hashes this
 * file with no manifest check. That executes nothing: on a cache miss the
 * metadata is extracted by an engine `spawnEngine` checks, and on a hit no
 * engine runs and the key is computed at boot, right after this verification.
 *
 * COST, scoped honestly: zero for in-tree producers. Both write the manifest
 * unconditionally in the same step as the bundle --
 * `scripts/build-shared-runtime.ts` and the Dockerfile's engine staging RUN --
 * and the Dockerfile's post-`USER jarvis` assertion, which already requires
 * `findCachedBundle()` to resolve from under `/app/engine-cache`, turns a
 * forgotten manifest into a failed image build rather than a silent runtime
 * regression. But a shared root can also be published out of tree, by an rsync
 * with an `--exclude`, a tarball or a fleet builder, and such a host now loses
 * its shared bundle on every tenant at once. That degradation is safe and
 * expensive -- and in a container with no egress or a read-only FS the staging
 * install fails outright and the daemon starts with workflow features
 * disabled. Which is why every refusal here is LOUD and carries a stable
 * `reason=` token: a fleet operator has to be able to alert on this rather than
 * discover it as an outage.
 *
 * HOW expensive, measured rather than implied, because "expensive" above
 * understated it. A refusal also switches off the per-user fast path -- that is
 * `buildEngineBundle`'s point, and the reason is stated there -- so it is a
 * REBUILD per resolution and not a one-time cost. `ensureStagingInstalled` is
 * memoized, so the ~47 MB install is paid at most once per process; the esbuild
 * (~700 ms, the figure `engine-bootstrap` logs) is paid on every
 * `buildEngineBundle`. In practice that is once per boot, plus once per
 * `createEvaluationEngine`. And `engine-bootstrap` calls `findCachedBundle` and
 * then `buildEngineBundle`, each of which runs this function, so one boot on a
 * broken host reads and hashes the shared `main.js` twice and logs two REFUSED
 * lines. Two attempts, two honest answers -- not a double-warning bug.
 *
 * SCOPE: the shared root only. The per-user BUNDLE_ROOT has no manifest by
 * design -- same uid, built locally -- and nothing here touches it. That it has
 * no verification AT ALL is a separate, larger matter; what this change does
 * owe it is not to make it the answer to a failed verification, which
 * `buildEngineBundle` handles. */
function findSharedBundle(sharedRoot?: string | null): SharedBundleLookup {
  const root = sharedBundleRoot(sharedRoot);
  if (!root) return { kind: "miss" };
  const hash = bundleHash();
  const bundleDir = resolve(root, hash);
  const bundlePath = resolve(bundleDir, "main.js");
  // Not a refusal: a shared root with no bundle for THIS source hash is the
  // ordinary miss the per-user build exists for, and on a developer machine it
  // is every single call.
  if (!existsSync(bundlePath)) return { kind: "miss" };
  const manifestPath = bundlePath + ".sha256";
  if (!existsSync(manifestPath)) {
    return refuseSharedBundle(bundlePath, "manifest_absent",
      "no main.js.sha256 beside it, so its bytes cannot be verified; publish the manifest with the bundle");
  }
  let want: string;
  let got: string;
  try {
    want = manifestDigest(readFileSync(manifestPath, "utf8"));
    got = sha256OfFile(bundlePath);
  } catch (err) {
    // `err instanceof Error ? err.message : String(err)`, the shape used
    // everywhere else, and not `String((err as Error).message)`: that cast
    // renders a non-Error throw as the literal "undefined", which is the one
    // outcome a line whose whole job is to be diagnosable cannot afford.
    return refuseSharedBundle(bundlePath, "manifest_unreadable",
      `manifest or bundle could not be read (${logSafePath(err instanceof Error ? err.message : String(err))})`);
  }
  if (want !== got) {
    // The manifest's contents reach the log line, so they are shown only in the
    // one shape that cannot forge a line: the premise of this check is that
    // something may have written into this tree. `manifestDigest` already makes
    // a newline structurally impossible -- it splits on whitespace and keeps one
    // token -- and this keeps the shape check anyway, because a single token can
    // still be `<<<UNTRUSTED_CONTENT` or a megabyte of text, and the two
    // defences answer different questions.
    const shown = /^[0-9a-f]{64}$/u.test(want) ? want : "<not a sha256 digest>";
    return refuseSharedBundle(bundlePath, "digest_mismatch",
      `manifest says ${shown}, bytes hash to ${got}`);
  }
  // Pin the digest that just verified, so every later spawn of this path is
  // checked against THESE bytes and not merely against whatever the manifest
  // beside them says by then (#671, bundle-integrity.ts).
  pinVerifiedBundle(bundlePath, got);
  return { kind: "hit", bundle: { bundlePath, hash, bundleDir } };
}

/**
 * Locate an already-built engine bundle for the current source state —
 * the shared root (if configured) first, then the per-user cache. Returns
 * null if no matching bundle is on disk -- callers can either
 * `buildEngineBundle()` (slow on cold start) or skip the work entirely.
 *
 * Note: NO staging-dir precondition. `bundleHash()` is computed purely from
 * the install tree + compiled-in constants; the old `STAGING_DIR/package.json`
 * guard was unsound and forced a pointless per-user staging install before a
 * prebuilt bundle could even be discovered.
 *
 * `bundleRoot` overrides the per-user cache root (default BUNDLE_ROOT,
 * `~/.jarvis/cache/engine`), mirroring `sharedRoot` (#673). Production never
 * passes it; it exists so the per-user cache's contract -- a bundle with NO
 * manifest beside it is still returned -- can be asserted on behaviour, without
 * a unit test seeding the developer's own cache.
 */
export function findCachedBundle(opts?: {
  sharedRoot?: string | null;
  bundleRoot?: string;
}): { bundlePath: string; hash: string } | null {
  const shared = findSharedBundle(opts?.sharedRoot);
  if (shared.kind === "hit") return { bundlePath: shared.bundle.bundlePath, hash: shared.bundle.hash };
  // A REFUSED shared bundle is answered by "nothing is cached", never by the
  // per-user copy (#624): that tree is tenant-writable and unverified, so
  // adopting it would answer a failed integrity check by lowering the trust
  // level. The caller's `buildEngineBundle` then BUILDS rather than adopts.
  if (shared.kind === "refused") return null;
  const hash = bundleHash();
  const bundleDir = resolve(opts?.bundleRoot ?? BUNDLE_ROOT, hash);
  const bundlePath = resolve(bundleDir, "main.js");
  if (!existsSync(bundlePath)) return null;
  // Mark it as in use for the cache pruner (#491): a daemon that resolves a
  // bundle needs it for its whole life, not just while an engine happens to
  // be running from it. Best-effort; a missed touch only costs protection.
  try {
    const when = new Date();
    utimesSync(bundleDir, when, when);
  } catch {
    /* read-only or gone */
  }
  return { bundlePath, hash };
}
