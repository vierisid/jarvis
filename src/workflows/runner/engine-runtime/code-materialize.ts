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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { lstat, opendir, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { UpstreamFlowVersion } from "./flow-version-adapter";
import { collectCodeActions } from "./flow-version-adapter";
import { sanitizedEnv } from "../../../util/subprocess-env";
import { BUN_INSTALL_ARGS, SANITIZED_INSTALL_HINT } from "../../../util/sanitized-install";
import { declaredDependencies } from "../../runtime/code-step-manifest";

export { CODE_STEP_MAX_DEPENDENCIES, declaredDependencies, isRegistrySpec } from "../../runtime/code-step-manifest";

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
 * same filesystem (the default, ~/.bun/install/cache beside ~/.jarvis) the
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

/** What a tree measured to. A walk stopped at a limit reports what it saw. */
export interface TreeSize {
  bytes: number;
  entries: number;
}

/** The caps one step's tree is held to. */
export interface TreeLimit {
  maxBytes: number;
  maxEntries: number;
}

export const CODE_STEP_TREE_LIMIT: TreeLimit = {
  maxBytes: CODE_STEP_MAX_INSTALL_BYTES,
  maxEntries: CODE_STEP_MAX_INSTALL_ENTRIES,
};

export function overLimit(size: TreeSize, limit: TreeLimit): boolean {
  return size.bytes > limit.maxBytes || size.entries > limit.maxEntries;
}

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

/** lstat calls in flight at once during a walk. */
const WALK_BATCH = 64;

/**
 * Apparent size and entry count of everything under `dir`: `lstat` sizes,
 * directories included, symlinks never followed. Entries that vanish mid-walk
 * (an install still moving files) are skipped; a missing `dir` is empty.
 *
 * Directories are streamed and stat'ed WALK_BATCH at a time, so memory does
 * not grow with the size of one directory, and with `stopPast` the walk ends
 * as soon as the answer to "is it over?" is yes.
 */
export async function measureTree(dir: string, stopPast?: TreeLimit): Promise<TreeSize> {
  const size: TreeSize = { bytes: 0, entries: 0 };
  const pending = [dir];
  const statBatch = async (base: string, names: string[]) => {
    const stats = await Promise.all(names.map((n) => lstat(resolve(base, n)).catch(() => null)));
    for (let i = 0; i < names.length; i++) {
      const st = stats[i];
      if (!st) continue;
      size.entries++;
      size.bytes += st.size;
      if (st.isDirectory()) pending.push(resolve(base, names[i]!));
    }
  };
  while (pending.length > 0) {
    const current = pending.pop()!;
    let handle;
    try {
      handle = await opendir(current);
    } catch {
      continue;
    }
    let batch: string[] = [];
    try {
      for await (const entry of handle) {
        batch.push(entry.name);
        if (batch.length < WALK_BATCH) continue;
        await statBatch(current, batch);
        batch = [];
        if (stopPast && overLimit(size, stopPast)) return size;
      }
    } catch {
      // The directory went away mid-read; what was read is counted.
    }
    if (batch.length > 0) await statBatch(current, batch);
    if (stopPast && overLimit(size, stopPast)) return size;
  }
  return size;
}

/**
 * `bun install` with the daemon's sanitized environment, no lifecycle scripts,
 * and the hoisted layout whatever a bunfig.toml says. Run by process.execPath,
 * the Bun running the daemon, never a `bun` found on PATH (#864). Killed once
 * its tree passes CODE_STEP_TREE_LIMIT (#865).
 */
export const bunInstall: DependencyInstaller = (dir) =>
  runInstall(dir, process.execPath, [...BUN_INSTALL_ARGS, "--linker=hoisted"], CODE_INSTALL_TIMEOUT_MS, CODE_STEP_TREE_LIMIT);

/**
 * Run `command` in `dir` with the daemon's sanitized environment, SIGKILLed
 * after `timeoutMs`, or as soon as `dir/node_modules` measures past `limit` (rejecting
 * with CodeInstallTooLargeError). Exported so the timeout and the limit can be
 * held on a real child.
 */
export function runInstall(
  dir: string,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  limit?: TreeLimit & { pollMs?: number },
): Promise<void> {
  return new Promise<void>((res, rej) => {
    let stderr = "";
    let tooLarge: CodeInstallTooLargeError | null = null;
    let settled = false;
    const child = spawn(command, [...args], {
      cwd: dir,
      stdio: ["ignore", "ignore", "pipe"],
      env: sanitizedEnv(),
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
    try {
      await install(work);
    } catch (e) {
      if (e instanceof CodeInstallTooLargeError) throw tooLargeForStep(stepName, e.size);
      throw e;
    }
    const built = resolve(work, "node_modules");
    if (!existsSync(resolve(work, "bun.lock")) || !existsSync(built)) {
      throw new Error(
        `bun install did not install a CODE step's dependencies where it was run (${work}); ` +
          `a package.json with "workspaces" in a directory above the code directory takes the install over. ` +
          `Refusing to run the step against another project's packages.`,
      );
    }
    // Measured again whatever installed it: the watchdog above is only on
    // bunInstall, and its last look can be up to a poll interval old.
    const size = await measureTree(built, CODE_STEP_TREE_LIMIT);
    if (overLimit(size, CODE_STEP_TREE_LIMIT)) throw tooLargeForStep(stepName, size);
    writeFileSync(resolve(built, INSTALLED_MANIFEST_MARKER), manifest);
    retire();
    renameSync(built, nodeModules);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function tooLargeForStep(stepName: string, size: TreeSize): Error {
  return new Error(
    `CODE step ${JSON.stringify(stepName)}: its dependencies install to more than one step may take ` +
      `(${describeLimit(CODE_STEP_TREE_LIMIT)}); measured at least ${describeSize(size)}. ` +
      `Declare fewer or smaller packages.`,
  );
}

/**
 * Version trees an engine in THIS process may be reading right now (#865),
 * counted, keyed by the tree's absolute path. The engine `require`s a step's
 * index.js and packages from the tree while the flow runs, so the pruner
 * (code-tree-prune.ts) must not delete one under it. EngineHandle.executeFlow
 * takes a lease synchronously, before it materializes anything, and gives it
 * back only once the engine is done with the run (or has been killed); the
 * pruner checks leases and moves a tree away in one synchronous step, so no
 * run can start between the two.
 */
const leases = new Map<string, number>();

export function leaseCodeTree(baseCodeDir: string, versionId: string): () => void {
  const key = resolve(baseCodeDir, versionId);
  leases.set(key, (leases.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (leases.get(key) ?? 1) - 1;
    if (left <= 0) leases.delete(key);
    else leases.set(key, left);
  };
}

/** True while some run in this process holds a lease on the tree at `path`. */
export function codeTreeLeased(path: string): boolean {
  return leases.has(resolve(path));
}

export async function materializeCodeActions(
  version: UpstreamFlowVersion,
  baseCodeDir: string,
  opts?: { install?: DependencyInstaller },
): Promise<MaterializeResult> {
  const install = opts?.install ?? bunInstall;
  const actions = collectCodeActions(version);
  const base = resolve(baseCodeDir);
  // The version directory is leased, touched and pruned by this name, so it
  // must be one plain directory under the code directory (ids are apId()s).
  // Only a flow with CODE steps has one; any other flow writes nothing here.
  if (actions.length > 0 && !/^[A-Za-z0-9_-]+$/.test(version.id)) {
    throw new Error(`flow version id ${JSON.stringify(version.id)} is not a plain directory name`);
  }
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
  if (planned.length > 0) {
    // Marks the tree as used now. The pruner keeps a recently used tree, which
    // is what protects one that ANOTHER process (an evaluation run sharing the
    // default code directory) is running from: leases are per process.
    const versionDir = resolve(base, version.id);
    mkdirSync(versionDir, { recursive: true });
    const now = new Date();
    utimesSync(versionDir, now, now);
  }
  const paths: string[] = [];
  for (const { action, deps, dir } of planned) {
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(dir, "index.js");
    writeFileSync(filePath, action.code);
    await perDirectory(dir, () =>
      syncDependencies(action.stepName, dir, deps, (work) => oneInstallAtATime(() => install(work))));
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
