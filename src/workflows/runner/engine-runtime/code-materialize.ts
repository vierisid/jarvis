/**
 * Materialize CODE-action source files to disk before sending EXECUTE_FLOW.
 *
 * The engine's no-op-code-sandbox does:
 *   `require("${AP_BASE_CODE_DIRECTORY}/${flowVersionId}/${stepName}/index.js")`
 *
 * so the file MUST be a CommonJS module exporting `{ code: async (inputs) => result }`.
 * For now we write the raw source as-is; this works when the source uses no
 * external imports beyond the Node/Bun standard library. A future enhancement
 * is to esbuild user TS into a self-contained CJS bundle here -- the place to
 * hook that is in this module so callers don't change.
 *
 * Idempotent: existing files are overwritten so re-runs of the same flow_run
 * see the latest source.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { UpstreamFlowVersion } from "./flow-version-adapter";
import { collectCodeActions } from "./flow-version-adapter";

export interface MaterializeResult {
  /** Number of CODE actions written. */
  written: number;
  /** Absolute paths of the written files (one per CODE action). */
  paths: string[];
}

export function materializeCodeActions(
  version: UpstreamFlowVersion,
  baseCodeDir: string,
): MaterializeResult {
  const actions = collectCodeActions(version);
  const paths: string[] = [];
  for (const action of actions) {
    const dir = resolve(baseCodeDir, version.id, action.stepName);
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(dir, "index.js");
    writeFileSync(filePath, action.code);
    if (action.packageJson && action.packageJson !== "{}") {
      writeFileSync(resolve(dir, "package.json"), action.packageJson);
    }
    paths.push(filePath);
  }
  return { written: paths.length, paths };
}
