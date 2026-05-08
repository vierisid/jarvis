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
  PieceCatalog,
  type PieceExtractionFailure,
} from "./piece-catalog";

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
}

export interface BootstrapWorkflowEngineResult {
  api: SandboxApi;
  runtime: EngineRuntime;
  catalog: PieceCatalog;
  failures: PieceExtractionFailure[];
  /** Tear down the SandboxApi server. Call after the worker has stopped. */
  shutdown: () => Promise<void>;
}

const DEFAULT_CACHE_FILE = resolve(homedir(), ".jarvis", "cache", "piece-metadata.json");

export async function bootstrapWorkflowEngine(
  opts: BootstrapWorkflowEngineOptions,
): Promise<BootstrapWorkflowEngineResult> {
  const log = opts.log ?? ((m) => console.log(`[engine-bootstrap] ${m}`));

  // 1. Ensure the engine bundle is built (cache hit on warm starts).
  const t0 = Date.now();
  let cached = findCachedBundle();
  if (!cached) {
    log("engine bundle not in cache; building (one-time cost ~700ms)");
    cached = await buildEngineBundle();
  }
  log(`engine bundle ready in ${Date.now() - t0}ms (${cached ? "" : "no-bundle "}path: ${cached?.bundlePath ?? "n/a"})`);

  // 2. Ensure each Jarvis piece's `dist/` artifact exists. The piece-loader
  // resolves `dist/package.json` matching by name, so a missing dist means
  // the engine can't load that piece. Cheap to rebuild on every startup
  // (~200ms total for all seven pieces).
  const t1 = Date.now();
  await buildAllJarvisPieces();
  log(`pieces compiled in ${Date.now() - t1}ms`);

  // 3. Start the SandboxApi server with the service backends supplied by the
  // daemon (LLM, tools, notify, context, agent, events, workflows).
  const api = new SandboxApi({ services: opts.services });
  await api.start({ host: opts.host ?? "127.0.0.1", port: 0 });
  log(`sandbox api listening on ${api.baseUrl}`);

  // 4. Build the EngineRuntime against the bundle. One runtime is shared
  // across all RUN_FLOW jobs + trigger hook calls; per-acquire spawn is the
  // unit of isolation.
  const runtime = new EngineRuntime({ api, bundlePath: cached.bundlePath });

  // 5. Extract piece metadata. Cached to disk keyed by the engine bundle's
  // content hash plus each piece's compiled bundle content; mismatch forces
  // a fresh extraction. A cache hit is ~instant; a miss spawns the engine
  // (~3s cold) and runs EXTRACT_PIECE_METADATA per piece.
  const pieceRoots = opts.pieceRoots ?? [
    resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, "pieces/jarvis"),
  ];
  const cacheKey = computeCatalogCacheKey({
    bundlePath: cached.bundlePath,
    pieceRoots,
  });
  const cacheFile = opts.cacheFile ?? DEFAULT_CACHE_FILE;
  const t2 = Date.now();
  const cacheHitBeforeBuild = existsSync(cacheFile);
  const { catalog, failures } = await buildPieceCatalog({
    runtime,
    pieceRoots,
    cacheFile,
    cacheKey,
    reporter: (m) => log(m),
  });
  const extractMs = Date.now() - t2;
  if (failures.length > 0) {
    log(`catalog built with ${failures.length} extraction failure(s); pieces still available: ${catalog.list().length} (${extractMs}ms)`);
  } else {
    log(
      `catalog built (${catalog.list().length} pieces, cache: ${cacheHitBeforeBuild ? "hit" : "miss"}, ${extractMs}ms)`,
    );
  }

  return {
    api,
    runtime,
    catalog,
    failures,
    shutdown: async () => {
      await api.stop();
    },
  };
}
