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
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { UpstreamFlowVersion } from "./flow-version-adapter";
import { collectCodeActions } from "./flow-version-adapter";
import { DEFAULT_RECENTLY_USED_MS } from "./engine-reaper";
import { sanitizedEnv } from "../../../util/subprocess-env";
import { BUN_INSTALL_ARGS, SANITIZED_INSTALL_HINT } from "../../../util/sanitized-install";
import { declaredDependencies } from "../../runtime/code-step-manifest";
import { measureTree, overLimit, type TreeLimit, type TreeSize } from "./code-tree-measure";
import {
  boundCacheAfterInstall,
  CODE_INSTALL_CACHE_LIMIT,
  codeInstallCacheDir,
  markInstalledPackagesUsed,
  removeCacheEntriesAddedSince,
  snapshotCache,
} from "./code-install-cache";

export { CODE_STEP_MAX_DEPENDENCIES, declaredDependencies, isRegistrySpec } from "../../runtime/code-step-manifest";
export { measureTree, overLimit, type TreeLimit, type TreeSize } from "./code-tree-measure";

export interface MaterializeResult {
  /** Number of CODE actions written. */
  written: number;
  /** Absolute paths of the written files (one per CODE action). */
  paths: string[];
}

/**
 * Runs `bun install` in `dir`, with `cacheDir` as Bun's install cache.
 * Injectable so tests need no registry.
 */
export type DependencyInstaller = (dir: string, opts: { cacheDir: string; limit?: TreeLimit }) => Promise<void>;

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
 * Most bytes one CODE step's installed packages may take (#865), as apparent
 * size: the `lstat` size of every entry, directories included, each hard link
 * counted where it appears.
 *
 * Measured with bun 1.3.8, `--ignore-scripts --linker=hoisted`, one package
 * per install: googleapis 246.5 MiB is the largest of 19 popular packages,
 * then aws-sdk (v2) 98.4 MiB and firebase-admin 66.2 MiB; the median is
 * 16.5 MiB. googleapis and aws-sdk together install to 344.6 MiB. So 512 MiB
 * holds the largest pairing measured with room, and refuses a step that
 * installs a multiple of the largest package anyone measured.
 *
 * Apparent, not on-disk, size on purpose. When Bun's install cache is on the
 * same filesystem (as the CODE-step cache in the code directory is, #1154) the
 * tree is hard links into it: installing googleapis and aws-sdk again with a
 * warm cache took 2.5 MB of new disk for 344.6 MiB of tree. The bytes are
 * real all the same, in the cache, the first time; and a cache on another
 * filesystem copies them into every tree. Apparent size is the upper bound
 * in both cases and does not depend on where the cache lives.
 */
export const CODE_STEP_MAX_INSTALL_BYTES = 512 * 1024 * 1024;

/**
 * Most entries (files, directories, links) one step's tree may hold (#865).
 * Bytes alone do not bound it: empty files and directories measure next to
 * nothing and still use an inode each. Measured as above: the largest of the
 * 19 trees is firebase-admin at 6,080 entries, the median 1,571, and 32
 * dependencies (the count cap) at the median is 50,272. 65,536 sits above
 * that and is ten times the largest package measured.
 */
export const CODE_STEP_MAX_INSTALL_ENTRIES = 65_536;

/**
 * How often a running install's tree is measured against the caps. Measured
 * with measureTree below (bun 1.3.8, median of 10): googleapis' 3,508
 * entries take 99 ms and firebase-admin's 6,080 take 173 ms, and the
 * walk is asynchronous, so it does not hold the daemon's event loop for that
 * long. Once a second stops a runaway install about a second after it
 * crosses a cap instead of at the 5-minute hang guard, and a walk never
 * overlaps the next one.
 */
export const INSTALL_SIZE_POLL_MS = 1_000;

export const CODE_STEP_TREE_LIMIT: TreeLimit = {
  maxBytes: CODE_STEP_MAX_INSTALL_BYTES,
  maxEntries: CODE_STEP_MAX_INSTALL_ENTRIES,
};

/**
 * Most one flow version's CODE steps may hold together (#1154), as the step
 * caps measure: four steps at the step cap. The step caps alone left a
 * version unbounded (a version may have any number of CODE steps); this is
 * what keeps one version from filling the whole code directory budget
 * (CODE_TREES_MAX_BYTES, twice this) on its own. For scale: eight steps of
 * googleapis, the largest package measured (246.5 MiB, 1,972 MiB together),
 * fit; a ninth does not.
 */
export const CODE_VERSION_TREE_LIMIT: TreeLimit = {
  maxBytes: 4 * CODE_STEP_MAX_INSTALL_BYTES,
  maxEntries: 4 * CODE_STEP_MAX_INSTALL_ENTRIES,
};

/** Refusal for a step whose packages install to more than a cap. */
export class CodeInstallTooLargeError extends Error {
  constructor(public readonly size: TreeSize, public readonly limit: TreeLimit) {
    super(`the install reached ${describeSize(size)}, over the limit for one CODE step's packages (${describeLimit(limit)})`);
    this.name = "CodeInstallTooLargeError";
  }
}

function describeSize(size: TreeSize): string {
  return `${size.bytes} bytes in ${size.entries} entries`;
}

function describeLimit(limit: TreeLimit): string {
  return `${limit.maxBytes / (1024 * 1024)} MiB, ${limit.maxEntries} entries`;
}

/**
 * `bun install` with the daemon's sanitized environment, no lifecycle scripts,
 * and the hoisted layout whatever a bunfig.toml says. Run by process.execPath,
 * the Bun running the daemon, never a `bun` found on PATH (#864). Killed once
 * its tree passes CODE_STEP_TREE_LIMIT (#865).
 */
export const bunInstall: DependencyInstaller = (dir, opts) =>
  runInstall(dir, process.execPath, [...BUN_INSTALL_ARGS, "--linker=hoisted"], CODE_INSTALL_TIMEOUT_MS,
    opts.limit ?? CODE_STEP_TREE_LIMIT, { cacheDir: opts.cacheDir });

/**
 * Run `command` in `dir` with the daemon's sanitized environment, SIGKILLed
 * after `timeoutMs`, or as soon as `dir/node_modules` measures past `limit` (rejecting
 * with CodeInstallTooLargeError). With `cacheDir`, that is Bun's install cache
 * (BUN_INSTALL_CACHE_DIR, which wins over a user's own setting of it; see
 * code-install-cache.ts). Exported so the timeout and the limit can be held on
 * a real child.
 */
export function runInstall(
  dir: string,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  limit?: TreeLimit & { pollMs?: number },
  opts: { cacheDir?: string } = {},
): Promise<void> {
  return new Promise<void>((res, rej) => {
    let stderr = "";
    let tooLarge: CodeInstallTooLargeError | null = null;
    let settled = false;
    const child = spawn(command, [...args], {
      cwd: dir,
      stdio: ["ignore", "ignore", "pipe"],
      env: sanitizedEnv(opts.cacheDir === undefined ? {} : { BUN_INSTALL_CACHE_DIR: opts.cacheDir }),
    });
    const timer = setTimeout(() => {
      stderr += `\n(killed after ${timeoutMs} ms)`;
      child.kill("SIGKILL");
    }, timeoutMs);
    // Bun writes the tree as it goes, so the install is measured while it
    // runs and stopped at the cap; checking only afterwards would let it fill
    // the disk for up to the whole hang guard first. A walk that races one of
    // Bun's renames can count a subtree twice and so stop an install slightly
    // early when it is right at a cap; accepted, given how far above every
    // measured tree the caps sit.
    let measuring = false;
    const watchdog = limit
      ? setInterval(() => {
          if (measuring || settled) return;
          measuring = true;
          // The tree the step would get, as the check after the install
          // measures it: the install's own package.json and lock are not.
          void measureTree(resolve(dir, "node_modules"), limit).then(
            (size) => {
              measuring = false;
              if (settled || tooLarge || !overLimit(size, limit)) return;
              tooLarge = new CodeInstallTooLargeError(size, { maxBytes: limit.maxBytes, maxEntries: limit.maxEntries });
              child.kill("SIGKILL");
            },
            () => {
              measuring = false;
            },
          );
        }, limit.pollMs ?? INSTALL_SIZE_POLL_MS)
      : null;
    const done = () => {
      settled = true;
      clearTimeout(timer);
      if (watchdog) clearInterval(watchdog);
    };
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString();
    });
    child.on("close", (code) => {
      done();
      if (tooLarge) rej(tooLarge);
      else if (code === 0) res();
      else {
        rej(new Error(
          `bun install of a CODE step's dependencies exited with code ${code}: ${stderr.trim()} ${SANITIZED_INSTALL_HINT}`,
        ));
      }
    });
    child.on("error", (e) => {
      done();
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
  stepName: string,
  dir: string,
  deps: Record<string, string>,
  install: DependencyInstaller,
  cache: { dir: string; limit: TreeLimit },
  versionDir: string,
  stepNames: ReadonlySet<string>,
): Promise<void> {
  // Asynchronously: a retired or refused tree can be hundreds of MiB in tens
  // of thousands of entries, and a synchronous delete of that holds the
  // daemon's event loop (review measured 693 ms for 200k entries on tmpfs).
  await Promise.all(
    readdirSync(dir)
      .filter((entry) => entry.startsWith(RETIRED_PREFIX) || entry.startsWith(INSTALL_DIR_PREFIX))
      .map((entry) => rm(resolve(dir, entry), { recursive: true, force: true })),
  );
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
    const built = resolve(work, "node_modules");
    // The install and everything that decides whether it is kept run as one
    // turn of the install queue, so the cache entries that appear meanwhile
    // are this install's: a refused one has them removed again (#1154).
    await oneInstallAtATime(async () => {
      // What this install may add: the step cap, or what the version's other
      // steps leave of the version's, whichever is less. Read inside the
      // queue's turn, so another install of this version cannot slip in
      // between the reading and the install.
      const others = await otherStepsSize(versionDir, dir, stepNames);
      const limit: TreeLimit = {
        maxBytes: Math.min(CODE_STEP_TREE_LIMIT.maxBytes, CODE_VERSION_TREE_LIMIT.maxBytes - others.bytes),
        maxEntries: Math.min(CODE_STEP_TREE_LIMIT.maxEntries, CODE_VERSION_TREE_LIMIT.maxEntries - others.entries),
      };
      const refuse = (size: TreeSize | null) => tooLargeForStep(stepName, size, limit, others);
      if (limit.maxBytes <= 0 || limit.maxEntries <= 0) throw refuse(null);
      const before = await snapshotCache(cache.dir);
      try {
        try {
          await install(work, { cacheDir: cache.dir, limit });
        } catch (e) {
          if (e instanceof CodeInstallTooLargeError) throw refuse(e.size);
          throw e;
        }
        if (!existsSync(resolve(work, "bun.lock")) || !existsSync(built)) {
          throw new Error(
            `bun install did not install a CODE step's dependencies where it was run (${work}); ` +
              `a package.json with "workspaces" in a directory above the code directory takes the install over. ` +
              `Refusing to run the step against another project's packages.`,
          );
        }
        // Measured again whatever installed it: the watchdog above is only on
        // bunInstall, and its last look can be up to a poll interval old.
        const size = await measureTree(built, limit);
        if (overLimit(size, limit)) throw refuse(size);
      } catch (e) {
        await removeCacheEntriesAddedSince(cache.dir, before);
        throw e;
      }
      await markInstalledPackagesUsed(cache.dir, built);
      await boundCacheAfterInstall(cache.dir, before, cache.limit);
    });
    writeFileSync(resolve(built, INSTALLED_MANIFEST_MARKER), manifest);
    retire();
    renameSync(built, nodeModules);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * The refusal for a step over what it may install: the step cap when it alone
 * is over that, the version's limit otherwise. `size` null: refused before
 * installing, because the other steps already hold the version's limit.
 */
function tooLargeForStep(stepName: string, size: TreeSize | null, limit: TreeLimit, others: TreeSize): Error {
  if (size && overLimit(size, CODE_STEP_TREE_LIMIT)) {
    return new Error(
      `CODE step ${JSON.stringify(stepName)}: its dependencies install to more than one step may take ` +
        `(${describeLimit(CODE_STEP_TREE_LIMIT)}); measured at least ${describeSize(size)}. ` +
        `Declare fewer or smaller packages.`,
    );
  }
  return new Error(
    `CODE step ${JSON.stringify(stepName)}: its dependencies would take this flow version's CODE steps together ` +
      `past their limit (${describeLimit(CODE_VERSION_TREE_LIMIT)}); the other steps hold ${describeSize(others)}` +
      (size ? ` and this one measured at least ${describeSize(size)}` : `, which leaves nothing for this one`) +
      `. Declare fewer or smaller packages, or use fewer CODE steps.`,
  );
}

/**
 * What the installed packages of the version's other current steps measure.
 * Only current steps: a renamed or removed step's directory still waiting
 * for the stale-step sweep is not something this version installs into.
 */
async function otherStepsSize(versionDir: string, stepDir: string, stepNames: ReadonlySet<string>): Promise<TreeSize> {
  const total: TreeSize = { bytes: 0, entries: 0 };
  let entries;
  try {
    entries = readdirSync(versionDir, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !stepNames.has(entry.name)) continue;
    const step = resolve(versionDir, entry.name);
    if (step === stepDir) continue;
    const size = await measureTree(resolve(step, "node_modules"));
    total.bytes += size.bytes;
    total.entries += size.entries;
  }
  return total;
}

/**
 * Trees an engine in THIS process may be reading right now (#865), counted,
 * keyed by absolute path: the version's directory and, since #1154, each of
 * the steps the run will execute. The engine `require`s a step's index.js and
 * packages from the tree while the flow runs, so neither the pruner
 * (code-tree-prune.ts) nor the stale-step sweep below may delete one under
 * it. EngineHandle.executeFlow takes a lease synchronously, before it
 * materializes anything, and gives it back only once the engine is done with
 * the run (or has been killed); the pruner checks leases and moves a tree
 * away in one synchronous step, so no run can start between the two.
 *
 * Per step because a DRAFT version keeps its id while it is edited: a run of
 * the draft as it was can still be executing a step that the draft as it is
 * has renamed or removed.
 */
const leases = new Map<string, number>();

/**
 * How often a leased tree's mtime is refreshed (#1154). Another process
 * sharing the code directory (an evaluation run) cannot see this process's
 * leases, only mtimes; before, the mtime was set once at the start of a run,
 * so a run longer than the pruner's 24h window lost its tree. Hourly is the
 * pruner's own interval: a lease never looks older than one interval.
 */
export const CODE_TREE_LEASE_REFRESH_MS = 60 * 60_000;

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/** Touch every leased path now. Exported so the refresh can be held in a test. */
export function refreshLeasedCodeTrees(now = new Date()): void {
  for (const path of leases.keys()) {
    try {
      utimesSync(path, now, now);
    } catch {
      // Not materialized yet, or already gone.
    }
  }
}

function armRefresh(): void {
  refreshTimer = setInterval(() => refreshLeasedCodeTrees(), CODE_TREE_LEASE_REFRESH_MS);
  refreshTimer.unref?.();
}

function hold(key: string): void {
  leases.set(key, (leases.get(key) ?? 0) + 1);
  if (!refreshTimer) armRefresh();
}

/**
 * Replace the refresh interval with a new one on the timers in effect now,
 * if any lease is held. For tests that swap in fake timers: the interval is
 * module-wide, so one armed earlier by another lease (on real timers) would
 * never fire under the fake clock.
 */
export function rearmCodeTreeLeaseRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  if (leases.size > 0) armRefresh();
}

function letGo(key: string): void {
  const left = (leases.get(key) ?? 1) - 1;
  if (left <= 0) leases.delete(key);
  else leases.set(key, left);
  if (leases.size === 0 && refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export function leaseCodeTree(baseCodeDir: string, versionId: string, stepNames: readonly string[] = []): () => void {
  const keys = [resolve(baseCodeDir, versionId), ...stepNames.map((step) => resolve(baseCodeDir, versionId, step))];
  for (const key of keys) hold(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) letGo(key);
  };
}

/** Lease the tree of `version` and every CODE step it will execute. What EngineHandle.executeFlow takes. */
export function leaseCodeTreeOf(baseCodeDir: string, version: UpstreamFlowVersion): () => void {
  return leaseCodeTree(baseCodeDir, version.id, collectCodeActions(version).map((a) => a.stepName));
}

/** True while some run in this process holds a lease on the tree at `path`. */
export function codeTreeLeased(path: string): boolean {
  return leases.has(resolve(path));
}

/** Prefix a stale step directory is renamed to before it is deleted. */
const STALE_STEP_PREFIX = ".stale-step-";

/**
 * Remove the step directories of `versionDir` that the version no longer has
 * (#1154): a draft keeps its id while its CODE steps are renamed or removed,
 * so each old name kept its whole `node_modules` for as long as the version
 * was kept. A directory goes only when no run in this process leases it and
 * it was not used within `recentlyUsedMs` (another process's run). As in the
 * pruner, the lease check and the rename are one synchronous step.
 */
export async function sweepStaleSteps(
  versionDir: string,
  current: ReadonlySet<string>,
  opts: { now?: number; recentlyUsedMs?: number } = {},
): Promise<string[]> {
  const now = opts.now ?? Date.now();
  const recentlyUsedMs = opts.recentlyUsedMs ?? DEFAULT_RECENTLY_USED_MS;
  let entries;
  try {
    entries = readdirSync(versionDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const doomed: string[] = [];
  const removed: string[] = [];
  for (const entry of entries) {
    const path = resolve(versionDir, entry.name);
    if (entry.name.startsWith(STALE_STEP_PREFIX)) {
      if (entry.isDirectory()) doomed.push(path);
      continue;
    }
    if (!entry.isDirectory() || entry.name.startsWith(".") || current.has(entry.name) || codeTreeLeased(path)) continue;
    let mtimeMs: number;
    try {
      mtimeMs = lstatSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs < recentlyUsedMs) continue;
    const away = resolve(versionDir, `${STALE_STEP_PREFIX}${randomBytes(4).toString("hex")}`);
    try {
      renameSync(path, away);
    } catch {
      continue;
    }
    doomed.push(away);
    removed.push(entry.name);
  }
  await Promise.all(doomed.map((path) => rm(path, { recursive: true, force: true }).catch(() => {})));
  return removed;
}

export async function materializeCodeActions(
  version: UpstreamFlowVersion,
  baseCodeDir: string,
  opts?: { install?: DependencyInstaller; installCacheLimit?: TreeLimit },
): Promise<MaterializeResult> {
  const install = opts?.install ?? bunInstall;
  const cache = { dir: codeInstallCacheDir(baseCodeDir), limit: opts?.installCacheLimit ?? CODE_INSTALL_CACHE_LIMIT };
  const actions = collectCodeActions(version);
  const base = resolve(baseCodeDir);
  // The version directory is leased, touched and pruned by this name, so it
  // must be one plain directory under the code directory (ids are apId()s).
  // Only a flow with CODE steps has one; any other flow writes nothing here.
  const plainVersionId = /^[A-Za-z0-9_-]+$/.test(version.id);
  if (actions.length > 0 && !plainVersionId) {
    throw new Error(`flow version id ${JSON.stringify(version.id)} is not a plain directory name`);
  }
  // Validate every step before writing any, so a refused manifest or step name
  // leaves no half-materialized flow behind.
  const planned = actions.map((action) => {
    const deps = declaredDependencies(action.stepName, action.packageJson ?? "");
    // One plain path segment, as readiness requires of every step name: the
    // leases, the stale-step sweep and the version's limit all key on it.
    if (!/^[A-Za-z0-9_-]+$/.test(action.stepName)) {
      throw new Error(`CODE step ${JSON.stringify(action.stepName)} is not a plain directory name`);
    }
    const dir = resolve(base, version.id, action.stepName);
    // The directory is about to have entries removed from it, so it must be
    // the step's own and nowhere else.
    if (!dir.startsWith(base + sep)) {
      throw new Error(`CODE step ${JSON.stringify(action.stepName)} resolves outside the code directory`);
    }
    return { action, deps, dir };
  });
  const versionDir = resolve(base, version.id);
  const stepNames = new Set(planned.map(({ action }) => action.stepName));
  if (planned.length === 0) {
    // A draft that removed its last CODE step still has its old steps' trees.
    if (plainVersionId && existsSync(versionDir)) await sweepStaleSteps(versionDir, stepNames);
  } else {
    // Marks the tree, and each step of it, as used now. The pruner and the
    // stale-step sweep keep what was used recently, which is what protects a
    // tree that ANOTHER process (an evaluation run sharing the default code
    // directory) is running from: leases are per process.
    const now = new Date();
    for (const { dir } of planned) {
      mkdirSync(dir, { recursive: true });
      utimesSync(dir, now, now);
    }
    utimesSync(versionDir, now, now);
    // Before installing, so what the version's limit counts is only its
    // current steps (and those still in use).
    await sweepStaleSteps(versionDir, stepNames);
  }
  const paths: string[] = [];
  for (const { action, deps, dir } of planned) {
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(dir, "index.js");
    writeFileSync(filePath, action.code);
    await perDirectory(dir, () => syncDependencies(action.stepName, dir, deps, install, cache, versionDir, stepNames));
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
