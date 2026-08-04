/**
 * Resolve where the workflow runtime finds READY-MADE artifacts (a prebuilt
 * engine-bundle dir, a ready-made pieces catalog, a prebuilt piece-metadata
 * cache) instead of building/installing its own.
 *
 * Source of truth is the `workflows` config section (`engine_dir`,
 * `pieces_dir`, `piece_metadata_cache`). Each path may carry a `${version}`
 * placeholder expanded from the `JARVIS_VERSION` env var — useful when one
 * machine keeps artifacts per installed version (a multi-tenant host is one
 * such deployment; a self-hosted instance can just use plain paths). The
 * bare JARVIS_* env vars are honored as fallbacks; config wins when both
 * are set. Every consumer treats a null as "no ready-made artifact" and
 * does the work itself.
 */

import { resolve } from "node:path";
import type { JarvisConfig } from "../../config/types";

export interface SharedRuntimePaths {
  /** Dir containing <hash>/main.js prebuilt engine bundles. */
  engineCacheRoot: string | null;
  /** Dir whose node_modules/@activepieces holds a ready-made catalog. */
  piecesDir: string | null;
  /** The prebuilt per-entry metadata cache FILE. */
  metadataCacheFile: string | null;
  /** Human-readable notes worth logging (e.g. a ${version} placeholder with
   * no usable JARVIS_VERSION). */
  warnings: string[];
}

const VERSION_PLACEHOLDER = "${version}";
// One path component, no traversal; the literal `current` symlink name is
// refused — placeholder expansion is for concrete versions only.
const VERSION_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function resolveSharedRuntimePaths(
  cfg: Pick<JarvisConfig, "workflows">,
  env: Record<string, string | undefined> = process.env,
): SharedRuntimePaths {
  const warnings: string[] = [];
  const wf = cfg.workflows;
  const version = env.JARVIS_VERSION?.trim() ?? "";
  const versionOk = VERSION_RE.test(version) && version !== "current" && !version.includes("..");

  const fromEnv = (name: string): string | null => {
    const v = env[name]?.trim();
    return v ? resolve(v) : null;
  };

  /** Config path (with placeholder expansion) or the env fallback. */
  const resolvePath = (configured: string | undefined, envName: string): string | null => {
    if (configured?.trim()) {
      const raw = configured.trim();
      if (!raw.includes(VERSION_PLACEHOLDER)) return resolve(raw);
      if (versionOk) return resolve(raw.replaceAll(VERSION_PLACEHOLDER, version));
      warnings.push(
        `workflows config path ${JSON.stringify(raw)} uses ${VERSION_PLACEHOLDER} but ` +
          `JARVIS_VERSION (${JSON.stringify(version)}) is not a usable concrete version — ` +
          `ignoring it (falling back to ${envName} / self-build)`,
      );
    }
    return fromEnv(envName);
  };

  return {
    engineCacheRoot: resolvePath(wf?.engine_dir, "JARVIS_ENGINE_CACHE_ROOT"),
    piecesDir: resolvePath(wf?.pieces_dir, "JARVIS_SHARED_PIECES_DIR"),
    metadataCacheFile: resolvePath(wf?.piece_metadata_cache, "JARVIS_PIECE_METADATA_CACHE"),
    warnings,
  };
}
