import { describe, expect, test } from "bun:test";
import { resolveSharedRuntimePaths } from "./shared-runtime-paths";

describe("resolveSharedRuntimePaths", () => {
  const wf = (extra: Record<string, string>) =>
    ({
      workflows: {
        enabled: true,
        maxConcurrentExecutions: 1,
        defaultRetries: 0,
        defaultTimeoutMs: 1,
        selfHealEnabled: false,
        autoSuggestEnabled: false,
        ...extra,
      },
    }) as Parameters<typeof resolveSharedRuntimePaths>[0];

  test("plain config paths resolve as-is (config wins over env)", () => {
    const paths = resolveSharedRuntimePaths(
      wf({
        engine_dir: "/srv/engine",
        pieces_dir: "/srv/pieces",
        piece_metadata_cache: "/srv/piece-metadata.json",
      }),
      { JARVIS_SHARED_PIECES_DIR: "/somewhere/else" },
    );
    expect(paths.engineCacheRoot).toBe("/srv/engine");
    expect(paths.piecesDir).toBe("/srv/pieces");
    expect(paths.metadataCacheFile).toBe("/srv/piece-metadata.json");
    expect(paths.warnings).toEqual([]);
  });

  test("${version} placeholder expands from JARVIS_VERSION", () => {
    const paths = resolveSharedRuntimePaths(
      wf({
        engine_dir: "/opt/jarvis-engine/${version}",
        pieces_dir: "/opt/jarvis-pieces/${version}",
        piece_metadata_cache: "/opt/jarvis-cache/${version}/piece-metadata.json",
      }),
      { JARVIS_VERSION: "1.2.3" },
    );
    expect(paths.engineCacheRoot).toBe("/opt/jarvis-engine/1.2.3");
    expect(paths.piecesDir).toBe("/opt/jarvis-pieces/1.2.3");
    expect(paths.metadataCacheFile).toBe("/opt/jarvis-cache/1.2.3/piece-metadata.json");
    expect(paths.warnings).toEqual([]);
  });

  test("placeholder with an unusable version warns and falls back per path", () => {
    for (const version of [undefined, "current", "../evil", "bad/slash"]) {
      const paths = resolveSharedRuntimePaths(
        wf({
          engine_dir: "/opt/jarvis-engine/${version}",
          pieces_dir: "/plain/pieces",
        }),
        {
          ...(version !== undefined ? { JARVIS_VERSION: version } : {}),
          JARVIS_ENGINE_CACHE_ROOT: "/env/engine",
        },
      );
      // Placeholder path is dropped (env fallback used); plain path is fine.
      expect(paths.warnings.length).toBe(1);
      expect(paths.engineCacheRoot).toBe("/env/engine");
      expect(paths.piecesDir).toBe("/plain/pieces");
    }
  });

  test("no config: bare env vars are the fallback; nothing anywhere: all null", () => {
    const fromEnv = resolveSharedRuntimePaths(
      {},
      {
        JARVIS_ENGINE_CACHE_ROOT: "/env/engine",
        JARVIS_SHARED_PIECES_DIR: "/env/pieces",
        JARVIS_PIECE_METADATA_CACHE: "/env/cache/piece-metadata.json",
      },
    );
    expect(fromEnv.engineCacheRoot).toBe("/env/engine");
    expect(fromEnv.piecesDir).toBe("/env/pieces");
    expect(fromEnv.metadataCacheFile).toBe("/env/cache/piece-metadata.json");

    expect(resolveSharedRuntimePaths({}, {})).toEqual({
      engineCacheRoot: null,
      piecesDir: null,
      metadataCacheFile: null,
      warnings: [],
    });
  });
});
