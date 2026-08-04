/**
 * Daemon-side bootstrap for the workflow engine: locates / builds the engine
 * bundle, ensures Jarvis-native pieces are compiled to dist/, starts a
 * loopback `SandboxApi` server on a random port, constructs an
 * `EngineRuntime` against the bundle, and extracts the `PieceCatalog`.
 *
 * Call once at daemon startup. Returns `{api, runtime, catalog, shutdown}`
 * for the daemon's composition root to wire into the worker, the trigger
 * manager, and the API route table.
 *
 * Failure handling:
 *   - If the engine bundle cannot be built, throws -- the workflow runtime
 *     is unusable and the daemon should surface that to the operator.
 *   - If catalog extraction fails for individual pieces, the catalog is
 *     returned with whatever succeeded plus a `failures[]` for surfacing.
 *
 * The caller owns lifecycle (stop the worker first, then call `shutdown()`
 * to stop the SandboxApi).
 */

import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import {
  buildEngineBundle,
  ENGINE_BUILD_PATHS,
  findCachedBundle,
} from "../runner/engine-runtime/build";
import { buildAllJarvisPieces } from "../runner/engine-runtime/build-pieces";
import { EngineRuntime } from "../runner/engine-runtime/engine-runtime";
import {
  SandboxApi,
  type SandboxApiServices,
} from "../sandbox-api/server";
import {
  buildPieceCatalog,
  computeCatalogCacheKey,
  readCachedEntries,
  PieceCatalog,
  type PieceExtractionFailure,
} from "./piece-catalog";
import {
  reconcilePiecesLibrary,
  piecesNodeModulesDir,
} from "../pieces-library/reconciler";
import { piecesBaseDir } from "../pieces-library/installer";

export interface BootstrapWorkflowEngineOptions {
  /** Service backends for the `/v1/jarvis/*` routes. Each unset slot returns 503. */
  services: SandboxApiServices;
  /**
   * Bind host for the SandboxApi. Default `127.0.0.1` -- the engine spawns
   * locally, no external traffic should reach this.
   */
  host?: string;
  /** Optional log sink. Default `console.log` with a `[engine-bootstrap]` prefix. */
  log?: (line: string) => void;
  /**
   * Optional override for the catalog cache file. Default
   * `~/.jarvis/cache/piece-metadata.json`. Tests can pass their own path.
   */
  cacheFile?: string;
  /**
   * Optional override for the piece root dirs scanned during catalog build.
   * Default: the vendored Jarvis piece tree only. Future community pieces
   * will be added here.
   */
  pieceRoots?: string[];
  /**
   * Idle TTL for the warm engine subprocess (see EngineRuntimeOptions.
   * poolIdleTtlMs). Default: EngineRuntime's own 5-minute default.
   */
  engineIdleTtlMs?: number;
  /**
   * Shared-runtime paths, config-resolved by the daemon (see
   * shared-runtime-paths.ts). `undefined` = fall back to the bare env vars;
   * `null` = definitively none. config.yaml is the hosting-owned source of
   * truth; the env vars are the fallback for unmanaged deployments.
   */
  sharedPiecesDir?: string | null;
  sharedCacheFile?: string | null;
  engineCacheRoot?: string | null;
}

export interface BootstrapWorkflowEngineResult {
  api: SandboxApi;
  runtime: EngineRuntime;
  catalog: PieceCatalog;
  failures: PieceExtractionFailure[];
  /**
   * Content hash of the engine bundle currently in use. Exposed so the
   * daemon can log it at startup -- a user who forgot to rebuild after
   * editing the framework sees a stale hash and knows to rerun
   * `bun run build:workflows`.
   */
  bundleHash: string;
  /**
   * GLOBAL cache-invalidation key for the piece-metadata cache: projection
   * schema + engine bundle + event-type registry. Per-piece source changes
   * invalidate their own cache ENTRY (content hash), not this key. Logged
   * alongside `bundleHash` so users can confirm cache freshness from the
   * daemon log alone.
   */
  catalogCacheKey: string;
  /** Tear down the SandboxApi server. Call after the worker has stopped. */
  shutdown: () => Promise<void>;
}

const DEFAULT_CACHE_FILE = resolve(homedir(), ".jarvis", "cache", "piece-metadata.json");

export async function bootstrapWorkflowEngine(
  opts: BootstrapWorkflowEngineOptions,
): Promise<BootstrapWorkflowEngineResult> {
  const log = opts.log ?? ((m) => console.log(`[engine-bootstrap] ${m}`));
  const t0 = Date.now();

  // 0. Reconcile the user-installed pieces library before anything else.
  // A fresh Docker container (volume mounted but no node_modules yet) needs
  // `bun install` to re-materialize the install set declared in
  // `~/.jarvis/pieces/installed.json`. Empty manifest = no-op. Failures are
  // logged but don't block engine startup -- the catalog will just exclude
  // the missing pieces and the user can re-trigger via the Library UI.
  try {
    const reconcile = await reconcilePiecesLibrary({ log });
    if (reconcile.ranInstall) {
      log(
        `pieces-library reconciled: ${reconcile.materialized.length}/${reconcile.declared} ready` +
          (reconcile.missing.length > 0
            ? `, ${reconcile.missing.length} missing`
            : ""),
      );
    }
  } catch (e) {
    log(`pieces-library reconcile failed (continuing without user pieces): ${(e as Error).message}`);
  }

  // Phases 1-3 run in parallel because none depends on another:
  //   - bundle build (CPU + disk)
  //   - piece compile (CPU + disk; uses a different staging dir)
  //   - SandboxApi server start (network bind + socket.io setup)
  // On warm starts (cached bundle, dist/ exists) the long pole is the
  // SandboxApi's socket.io spinup; on cold starts it's the bundle build
  // (~700ms). Either way overlapping shaves the slowest path.
  //
  // Each arm's failure is labelled with which phase blew up so the operator
  // doesn't have to guess. Promise.all rejects on the first failure; we
  // wrap so the rejection identifies the responsible phase.
  const api = new SandboxApi({ services: opts.services });
  const labelled = <T>(phase: string, p: Promise<T>): Promise<T> =>
    p.catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`workflow-engine bootstrap phase '${phase}' failed: ${msg}`);
    });
  const [cached] = await Promise.all([
    labelled(
      "bundle-build",
      (async () => {
        let c = findCachedBundle({ sharedRoot: opts.engineCacheRoot });
        if (!c) {
          log("engine bundle not in cache; building (one-time cost ~700ms)");
          c = await buildEngineBundle({ sharedRoot: opts.engineCacheRoot });
        }
        return c;
      })(),
    ),
    labelled("piece-compile", buildAllJarvisPieces()),
    labelled("sandbox-api-start", api.start({ host: opts.host ?? "127.0.0.1", port: 0 })),
  ]);
  log(`bundle + pieces + sandbox api ready in ${Date.now() - t0}ms (${api.baseUrl})`);

  // 4. Build the EngineRuntime against the bundle. One runtime is shared
  // across all RUN_FLOW jobs + trigger hook calls. Pooling is enabled so
  // cron-fired runs / fast event-bus polls reuse the warm engine rather
  // than paying the ~3s cold-spawn cost on every fire. The catalog
  // extraction below acquires + releases an engine; with pool=true the
  // released engine ends up in the warm slot and is reused by the first
  // real RUN_FLOW after bootstrap -- effectively "pre-warm for free".
  //
  // customPiecesPaths includes the user pieces dir (`~/.jarvis/pieces`)
  // alongside the vendored Jarvis pieces. The engine's piece-loader walks
  // both at runtime: vendored pieces resolve via the standard upstream
  // layout, user-installed pieces via our patched shared-node_modules
  // shape (see piece-loader.ts).
  //
  // JARVIS_SHARED_PIECES_DIR (multi-tenant hosting): a root-owned READ-ONLY
  // catalog tree built once per installed version. Appended AFTER the user's
  // own dir so a user-installed piece shadows the shared copy (both the
  // loader walk and discoverPieces are first-wins). The installer/reconciler
  // never touch it — they operate solely on `~/.jarvis/pieces`.
  const sharedPiecesDir =
    opts.sharedPiecesDir !== undefined
      ? opts.sharedPiecesDir
      : process.env.JARVIS_SHARED_PIECES_DIR?.trim() || null;
  const runtime = new EngineRuntime({
    api,
    bundlePath: cached.bundlePath,
    pool: true,
    poolIdleTtlMs: opts.engineIdleTtlMs,
    customPiecesPaths: [
      resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces"),
      piecesBaseDir(),
      ...(sharedPiecesDir ? [sharedPiecesDir] : []),
    ],
  });

  // 5. Extract piece metadata. Cached to disk keyed by the engine bundle's
  // content hash plus each piece's compiled bundle content; mismatch forces
  // a fresh extraction. A cache hit is ~instant; a miss spawns the engine
  // (~3s cold) and runs EXTRACT_PIECE_METADATA per piece.
  // pieceRoots feeds discoverPieces -- which walks each root's children for
  // a `package.json` and registers them in the catalog. Two roots today:
  //   1. vendored Jarvis-native pieces (always present)
  //   2. user-installed community pieces under `~/.jarvis/pieces/node_modules/@activepieces/`
  //      (may be missing; discoverPieces handles a missing dir gracefully)
  const pieceRoots = opts.pieceRoots ?? [
    resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis"),
    resolve(piecesNodeModulesDir(), "@activepieces"),
    // Shared catalog last: discoverPieces is first-wins, so a user install
    // of the same piece shadows the shared copy here too.
    ...(sharedPiecesDir ? [resolve(sharedPiecesDir, "node_modules/@activepieces")] : []),
  ];
  const cacheKey = computeCatalogCacheKey({ bundlePath: cached.bundlePath });
  const cacheFile = opts.cacheFile ?? DEFAULT_CACHE_FILE;
  // JARVIS_PIECE_METADATA_CACHE: a READ-ONLY prebuilt metadata cache for the
  // shared tree (generated at version-install time). With it, first boot is
  // a cache hit for every shared piece — no 650-piece extraction spike.
  const sharedCacheFile =
    opts.sharedCacheFile !== undefined
      ? opts.sharedCacheFile
      : process.env.JARVIS_PIECE_METADATA_CACHE?.trim() || null;
  // A CONFIGURED shared cache that exists but fails the global-key gate means
  // the host's artifacts don't match this daemon (a bundle rebuilt locally,
  // or shared artifacts not regenerated for a daemon change). The fallback —
  // every tenant re-extracting the whole shared catalog — is a fleet-wide
  // storm, so say so LOUDLY instead of silently filtering to nothing.
  if (sharedCacheFile && existsSync(sharedCacheFile)) {
    if (readCachedEntries(sharedCacheFile, cacheKey) === null) {
      log(
        `WARNING: shared piece-metadata cache ${sharedCacheFile} does not match this daemon's ` +
          `catalog key — falling back to per-tenant extraction (were the shared artifacts ` +
          `rebuilt for this version?)`,
      );
    }
  }
  const t2 = Date.now();
  const cacheFilePresent = existsSync(cacheFile);
  const { catalog, failures } = await buildPieceCatalog({
    runtime,
    pieceRoots,
    cacheFile,
    cacheKey,
    sharedCacheFiles: sharedCacheFile ? [sharedCacheFile] : [],
    // A shared tree can hold the whole 650-piece catalog; if its prebuilt
    // cache was rejected (warning above) the default 60s deadline would mark
    // hundreds of pieces failed. Give the recovery path room instead.
    ...(sharedPiecesDir ? { overallTimeoutMs: 15 * 60_000 } : {}),
    reporter: (m) => log(m),
  });
  const extractMs = Date.now() - t2;
  if (failures.length > 0) {
    log(`catalog built with ${failures.length} extraction failure(s); pieces still available: ${catalog.list().length} (${extractMs}ms)`);
  } else {
    log(
      `catalog built (${catalog.list().length} pieces, cache file ${cacheFilePresent ? "present" : "absent"}, ${extractMs}ms)`,
    );
  }

  return {
    api,
    runtime,
    catalog,
    failures,
    bundleHash: cached.hash,
    catalogCacheKey: cacheKey,
    shutdown: async () => {
      // Kill any pooled idle engine before stopping the SandboxApi -- the
      // engine's HTTP/WS callbacks would otherwise spin against a dead server.
      await runtime.shutdown();
      await api.stop();
    },
  };
}
