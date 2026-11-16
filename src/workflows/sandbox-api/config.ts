/**
 * Filesystem locations for sandbox-api side-files.
 *
 * Centralized so tests can override via env without leaking $HOME state.
 * Defaults to `~/.jarvis/workflow-files/` and `~/.jarvis/workflow-logs/`,
 * matching the rest of the daemon's `~/.jarvis/...` tree.
 */

import { homeJarvisDir } from "../../util/jarvis-dirs";
import { resolve } from "node:path";

const ROOT_ENV = "JARVIS_WORKFLOW_DATA_DIR";

function root(): string {
  const override = process.env[ROOT_ENV];
  if (override) return resolve(override);
  return homeJarvisDir();
}

export function workflowFileBase(): string {
  return resolve(root(), "workflow-files");
}

/** The folder the workflow files and CODE-step trees live under (`~/.jarvis` unless it cannot be written). */
export function workflowRoot(): string {
  return root();
}

/**
 * Run-log backups. An instance that sets `JARVIS_HOME` keeps them in its data
 * dir (they used to land in `$HOME/.jarvis` whatever the data dir was).
 */
export function workflowLogsBase(): string {
  const override = process.env[ROOT_ENV];
  const dataDir = process.env.JARVIS_HOME?.trim();
  return resolve(override || dataDir || root(), "workflow-logs");
}

/** Where earlier versions wrote them: still read, and cleaned up with a run, never written. */
export function legacyWorkflowLogsBase(): string {
  return resolve(root(), "workflow-logs");
}
