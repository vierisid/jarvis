/**
 * Materialize CODE-action source files to disk before sending EXECUTE_FLOW.
 *
 * The engine's no-op-code-sandbox does:
 *   `require("${AP_BASE_CODE_DIRECTORY}/${flowVersionId}/${stepName}/index.js")`
 *
 * so the file MUST be a CommonJS module exporting `{ code: async (inputs) => result }`.
 * We write the raw source as-is. A future enhancement is to esbuild user TS into
 * a self-contained CJS bundle here -- the place to hook that is in this module
 * so callers don't change.
 *
 * PACKAGES (#837). A step can import the packages its `package.json` declares
 * in `dependencies`, and nothing else. The sandbox runs the step with
 * `--no-install`; before #837 it did not, and a step file has no `node_modules`
 * above it, so Bun AUTO-INSTALLED any bare name the step required: fetched the
 * LATEST version from the npm registry and ran it, a package nobody chose
 * (measured: `require("is-number")` fetched is-number@7.0.0 into an empty
 * install cache). Now the declared dependencies are installed here, beside
 * `index.js`, with `--ignore-scripts`, and an undeclared one fails the step
 * with a message naming it.
 *
 * Only `dependencies` is read, and only registry specs (a version, a range or
 * a dist-tag): the manifest that is installed is SYNTHESIZED from them, so the
 * step's own `scripts`, `overrides`, `workspaces` or a `file:`, `git+` or URL
 * spec never reach `bun install`. Anything else is refused, naming the step.
 *
 * Idempotent: existing files are overwritten so re-runs of the same flow_run
 * see the latest source, and an install is skipped when the same manifest was
 * already installed into that directory.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { UpstreamFlowVersion } from "./flow-version-adapter";
import { collectCodeActions } from "./flow-version-adapter";
import { sanitizedEnv } from "../../../util/subprocess-env";
import { BUN_INSTALL_ARGS, SANITIZED_INSTALL_HINT } from "../../../util/sanitized-install";
import { declaredDependencies } from "../../runtime/code-step-manifest";

export { declaredDependencies, isRegistrySpec } from "../../runtime/code-step-manifest";

export interface MaterializeResult {
  /** Number of CODE actions written. */
  written: number;
  /** Absolute paths of the written files (one per CODE action). */
  paths: string[];
}

/** Runs `bun install` in `dir`. Injectable so tests need no registry. */
export type DependencyInstaller = (dir: string) => Promise<void>;

/**
 * Written into `node_modules` after a successful install, holding the manifest
 * that was installed. It is what makes the install skippable, and its absence
 * (an install that died half way) is what makes it run again.
 */
export const INSTALLED_MANIFEST_MARKER = ".jarvis-code-step-manifest.json";

/** The manifest actually installed: the declared dependencies and nothing else. */
export function synthesizedManifest(deps: Record<string, string>): string {
  return JSON.stringify({ name: "jarvis-code-step", private: true, dependencies: deps }, null, 2) + "\n";
}

/**
 * A hang guard, not a performance budget: a cold install of three ordinary
 * packages (axios, lodash, dayjs; 12 MB) took 0.8 s with an empty cache. An
 * install still running after this is killed, so it cannot hold the install
 * queue below, and with it every CODE step on the instance, indefinitely.
 */
export const CODE_INSTALL_TIMEOUT_MS = 5 * 60_000;

/**
 * `bun install` with the daemon's sanitized environment, no lifecycle scripts,
 * and the hoisted layout whatever a bunfig.toml says.
 */
export const bunInstall: DependencyInstaller = (dir) =>
  runInstall(dir, "bun", [...BUN_INSTALL_ARGS, "--linker=hoisted"], CODE_INSTALL_TIMEOUT_MS);

/**
 * Run `command` in `dir` with the daemon's sanitized environment, SIGKILLed
 * after `timeoutMs`. Exported so the timeout can be held on a real child.
 */
export function runInstall(dir: string, command: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise<void>((res, rej) => {
    let stderr = "";
    const child = spawn(command, [...args], {
      cwd: dir,
      stdio: ["ignore", "ignore", "pipe"],
      env: sanitizedEnv(),
    });
    const timer = setTimeout(() => {
      stderr += `\n(killed after ${timeoutMs} ms)`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) res();
      else {
        rej(new Error(
          `bun install of a CODE step's dependencies exited with code ${code}: ${stderr.trim()} ${SANITIZED_INSTALL_HINT}`,
        ));
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      rej(e);
    });
  });
}

/** Prefix of a directory an install runs in, beside the step. */
const INSTALL_DIR_PREFIX = ".install-";
/** Prefix of a replaced `node_modules`, removed at the NEXT sync. */
const RETIRED_PREFIX = ".retired-node_modules-";

/**
 * Bring `dir`'s installed packages in line with `deps`.
 *
 * The install runs in a fresh directory beside the step and its `node_modules`
 * is renamed into place, so a run already using the old tree never sees it
 * half-replaced, and the old tree is only RETIRED (renamed away) here and
 * deleted at the next sync, not under a step that may still be requiring from
 * it. A step that no longer declares anything has its tree retired too, so a
 * dropped declaration really stops resolving.
 *
 * The install must happen IN that directory: Bun walks up from its cwd for a
 * workspace root, and a `package.json` with `workspaces` above the code
 * directory (HOME is above it by default) would otherwise take the install
 * over, with its own specs, and leave the step resolving through the
 * ancestor's tree. Found in review and reproduced; such an install leaves no
 * `bun.lock` or `node_modules` in the directory it was run in, which is what
 * refuses it here.
 */
async function syncDependencies(
  dir: string,
  deps: Record<string, string>,
  install: DependencyInstaller,
): Promise<void> {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(RETIRED_PREFIX) || entry.startsWith(INSTALL_DIR_PREFIX)) {
      rmSync(resolve(dir, entry), { recursive: true, force: true });
    }
  }
  // A package.json beside the step is what the materializer before #837 wrote
  // for any manifest that was not "{}", and installs no longer run here. Kept
  // out deliberately, not as dead cleanup: a stale `"type": "module"` in it
  // would turn the step's index.js into an ES module and break its require().
  rmSync(resolve(dir, "package.json"), { force: true });
  rmSync(resolve(dir, "bun.lock"), { force: true });

  const nodeModules = resolve(dir, "node_modules");
  const retire = () => {
    if (existsSync(nodeModules)) renameSync(nodeModules, resolve(dir, RETIRED_PREFIX + randomBytes(6).toString("hex")));
  };
  if (Object.keys(deps).length === 0) {
    retire();
    return;
  }
  const manifest = synthesizedManifest(deps);
  const marker = resolve(nodeModules, INSTALLED_MANIFEST_MARKER);
  if (existsSync(marker) && readFileSync(marker, "utf8") === manifest) return;

  const work = mkdtempSync(resolve(dir, INSTALL_DIR_PREFIX));
  try {
    writeFileSync(resolve(work, "package.json"), manifest);
    await install(work);
    const built = resolve(work, "node_modules");
    if (!existsSync(resolve(work, "bun.lock")) || !existsSync(built)) {
      throw new Error(
        `bun install did not install a CODE step's dependencies where it was run (${work}); ` +
          `a package.json with "workspaces" in a directory above the code directory takes the install over. ` +
          `Refusing to run the step against another project's packages.`,
      );
    }
    writeFileSync(resolve(built, INSTALLED_MANIFEST_MARKER), manifest);
    retire();
    renameSync(built, nodeModules);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function materializeCodeActions(
  version: UpstreamFlowVersion,
  baseCodeDir: string,
  opts?: { install?: DependencyInstaller },
): Promise<MaterializeResult> {
  const install = opts?.install ?? bunInstall;
  const actions = collectCodeActions(version);
  const base = resolve(baseCodeDir);
  // Validate every step before writing any, so a refused manifest or step name
  // leaves no half-materialized flow behind.
  const planned = actions.map((action) => {
    const deps = declaredDependencies(action.stepName, action.packageJson ?? "");
    const dir = resolve(base, version.id, action.stepName);
    // The directory is about to have entries removed from it, so it must be
    // the step's own and nowhere else.
    if (!dir.startsWith(base + sep)) {
      throw new Error(`CODE step ${JSON.stringify(action.stepName)} resolves outside the code directory`);
    }
    return { action, deps, dir };
  });
  const paths: string[] = [];
  for (const { action, deps, dir } of planned) {
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(dir, "index.js");
    writeFileSync(filePath, action.code);
    await perDirectory(dir, () => syncDependencies(dir, deps, (work) => oneInstallAtATime(() => install(work))));
    paths.push(filePath);
  }
  return { written: paths.length, paths };
}

/**
 * One sync per step directory at a time in this process: two runs of one flow
 * version share a directory, and an install racing a retirement would hand one
 * of them the wrong tree. Syncs of different directories, and syncs with
 * nothing to install, do not wait for each other.
 */
const syncing = new Map<string, Promise<void>>();
async function perDirectory(dir: string, fn: () => Promise<void>): Promise<void> {
  const next = (syncing.get(dir) ?? Promise.resolve()).catch(() => {}).then(fn);
  syncing.set(dir, next);
  try {
    await next;
  } finally {
    if (syncing.get(dir) === next) syncing.delete(dir);
  }
}

/**
 * One `bun install` at a time in this process, so a burst of runs cannot start
 * an unbounded number of installs (network, disk) at once.
 * CODE_INSTALL_TIMEOUT_MS bounds how long any one can hold the line; only a
 * step that actually has to install ever joins it.
 */
let installs: Promise<void> = Promise.resolve();
async function oneInstallAtATime(fn: () => Promise<void>): Promise<void> {
  const next = installs.catch(() => {}).then(fn);
  installs = next;
  await next;
}
