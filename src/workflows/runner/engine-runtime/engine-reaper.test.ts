/**
 * Reaping orphaned engines and pruning the bundle cache (#491).
 *
 * The identification tests run against a FAKE `/proc` tree, because the
 * interesting cases are the ones that must NOT be touched -- a live daemon's
 * pooled engine, another user's process, a CODE-action child that inherited
 * the engine's environment -- and manufacturing those for real would mean
 * spawning things this test has no business spawning. Signals go to an
 * injected recorder, so a mistake in the matching logic shows up as a
 * recorded pid rather than as a dead process on a shared machine.
 *
 * One test at the end does the real thing end to end, against a process it
 * spawned itself -- and passes `only: [pid]` so that even then the reaper
 * cannot reach anything else running here.
 *
 * Pruning always runs against a temp cache dir. Never `~/.jarvis/cache`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  ENGINE_BUNDLE_ENV,
  ENGINE_MARKER_ENV,
  ENGINE_MARKER_VALUE,
  ENGINE_ORPHAN_POLL_ENV,
  ENGINE_OWNER_PID_ENV,
  ENGINE_OWNER_START_ENV,
  ENGINE_STARTED_AT_ENV,
} from "./engine-lifecycle";
import {
  findEngineProcesses,
  pruneEngineBundleCache,
  reapOrphanedEngines,
} from "./engine-reaper";

let tmp: string | null = null;

/**
 * Stand-in owners this file spawned, killed by HANDLE after each test. A
 * launcher that never reports (a rejected await, a failed assertion) would
 * otherwise outlive the test along with the watchdog-disabled engine it had
 * already spawned, and the only thing left to clean them up would be their own
 * self-destruct timers.
 */
const standIns: ChildProcess[] = [];

afterEach(() => {
  for (const child of standIns.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

function tmpDir(): string {
  tmp ??= mkdtempSync(resolve(tmpdir(), "jarvis-reaper-"));
  return tmp;
}

/** Build one fake `/proc/<pid>` entry. */
function fakeProcess(
  procRoot: string,
  pid: number,
  opts: { env: Record<string, string>; argv: string[]; startTicks?: string },
): void {
  const dir = resolve(procRoot, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, "environ"),
    Object.entries(opts.env)
      .map(([k, v]) => `${k}=${v}\0`)
      .join(""),
  );
  writeFileSync(resolve(dir, "cmdline"), opts.argv.map((a) => `${a}\0`).join(""));
  // Only fields 1, 2 and 22 matter here; comm deliberately contains a space
  // and parens, which is what breaks naive field splitting. `tokens` holds
  // everything from field 3 (state) on, so field 22 is tokens[19].
  const tokens = Array.from({ length: 50 }, (_, i) => String(i + 3));
  tokens[0] = "S";
  tokens[19] = opts.startTicks ?? "1000";
  writeFileSync(resolve(dir, "stat"), `${pid} (bun (smol)) ${tokens.join(" ")}\n`);
}

const BUNDLE = "/home/someone/.jarvis/cache/engine/abc123/main.js";

function engineEnv(over: Record<string, string> = {}): Record<string, string> {
  return {
    [ENGINE_MARKER_ENV]: ENGINE_MARKER_VALUE,
    [ENGINE_BUNDLE_ENV]: BUNDLE,
    [ENGINE_OWNER_PID_ENV]: "999001",
    [ENGINE_OWNER_START_ENV]: "5000",
    [ENGINE_STARTED_AT_ENV]: String(Date.now() - 60_000),
    ...over,
  };
}

/**
 * A kill that records instead of signalling; `alive` decides probe results.
 *
 * When a fixture tree is supplied, a fatal signal also removes that pid's
 * `/proc` entry -- the reaper re-reads it before every signal, so a fake
 * machine where killing changes nothing would let the tests pass a reaper
 * that signals the same pid forever.
 */
function recordingKill(
  alive: Set<number>,
  procRoot?: string,
): {
  calls: Array<{ pid: number; signal: NodeJS.Signals | 0 }>;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
} {
  const calls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
  return {
    calls,
    kill(pid, signal) {
      if (signal !== 0) calls.push({ pid, signal });
      if (!alive.has(pid)) {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        alive.delete(pid);
        if (procRoot) rmSync(resolve(procRoot, String(pid)), { recursive: true, force: true });
      }
    },
  };
}

describe("identifying an engine of ours", () => {
  test("finds a marked engine and reports it orphaned when its owner is gone", () => {
    const procRoot = tmpDir();
    fakeProcess(procRoot, 1234, { env: engineEnv(), argv: ["bun", "--smol", BUNDLE] });
    const { kill } = recordingKill(new Set()); // owner 999001 is not alive

    const found = findEngineProcesses({ procRoot, kill });
    expect(found).toHaveLength(1);
    expect(found[0]!.pid).toBe(1234);
    expect(found[0]!.bundlePath).toBe(BUNDLE);
    expect(found[0]!.orphaned).toBe(true);
  });

  test("leaves a pooled engine alone while its owner is alive", () => {
    // The nuance the issue insists on: the engine is pooled across runs by
    // design, so "idle" is not "abandoned".
    const procRoot = tmpDir();
    fakeProcess(procRoot, 1234, { env: engineEnv(), argv: ["bun", "--smol", BUNDLE] });
    fakeProcess(procRoot, 999001, { env: {}, argv: ["bun", "daemon"], startTicks: "5000" });
    const { kill, calls } = recordingKill(new Set([999001]));

    const found = findEngineProcesses({ procRoot, kill });
    expect(found).toHaveLength(1);
    expect(found[0]!.orphaned).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("treats a recycled owner pid as gone", () => {
    // Owner pid is alive, but it started at a different time -- something
    // else has the number now.
    const procRoot = tmpDir();
    fakeProcess(procRoot, 1234, { env: engineEnv(), argv: ["bun", "--smol", BUNDLE] });
    fakeProcess(procRoot, 999001, { env: {}, argv: ["something", "else"], startTicks: "77777" });
    const { kill } = recordingKill(new Set([999001]));

    expect(findEngineProcesses({ procRoot, kill })[0]!.orphaned).toBe(true);
  });

  test("ignores a CODE-action child that inherited the engine's environment", () => {
    // The engine spawns user code with no env of its own, so the marker is
    // inherited. Its argv is `bun --eval <script>`, never a bundle path --
    // which is the whole reason the argv check exists. Reaping one of these
    // would kill a running workflow step.
    const procRoot = tmpDir();
    fakeProcess(procRoot, 4321, {
      env: engineEnv(),
      argv: ["bun", "--eval", "console.log('user code')"],
    });
    const { kill } = recordingKill(new Set());

    expect(findEngineProcesses({ procRoot, kill })).toHaveLength(0);
  });

  test("ignores unmarked processes entirely", () => {
    const procRoot = tmpDir();
    fakeProcess(procRoot, 1111, { env: { PATH: "/usr/bin" }, argv: ["bun", "test"] });
    fakeProcess(procRoot, 2222, {
      env: { [ENGINE_MARKER_ENV]: "something-else", [ENGINE_BUNDLE_ENV]: BUNDLE },
      argv: ["bun", "--smol", BUNDLE],
    });
    const { kill } = recordingKill(new Set());

    expect(findEngineProcesses({ procRoot, kill })).toHaveLength(0);
  });

  test("ignores a marked process whose argv does not name its own bundle", () => {
    const procRoot = tmpDir();
    fakeProcess(procRoot, 3333, {
      env: engineEnv(),
      argv: ["bun", "--smol", "/some/other/bundle/main.js"],
    });
    const { kill } = recordingKill(new Set());

    expect(findEngineProcesses({ procRoot, kill })).toHaveLength(0);
  });

  test("scanning a machine with no procfs finds nothing rather than throwing", () => {
    const { kill } = recordingKill(new Set());
    expect(findEngineProcesses({ procRoot: resolve(tmpDir(), "nope"), kill })).toEqual([]);
  });

  test("ignores a process belonging to another user", () => {
    // The fixture tree is owned by us, so the uid to match is overridden
    // instead. Same effect: the candidate's owner is not the uid we accept.
    const procRoot = tmpDir();
    fakeProcess(procRoot, 1234, { env: engineEnv(), argv: ["bun", "--smol", BUNDLE] });
    const { kill } = recordingKill(new Set());
    const ourUid = typeof process.getuid === "function" ? process.getuid() : 0;

    expect(findEngineProcesses({ procRoot, kill, uid: ourUid })).toHaveLength(1);
    expect(findEngineProcesses({ procRoot, kill, uid: ourUid + 1 })).toHaveLength(0);
  });

  test("an owner pid we are not allowed to signal counts as recycled, not alive", () => {
    // EPERM means that pid belongs to somebody else now. Our engine passed
    // the uid gate, so its real owner could not have been another user's.
    const procRoot = tmpDir();
    fakeProcess(procRoot, 1234, { env: engineEnv(), argv: ["bun", "--smol", BUNDLE] });
    const kill = (_pid: number, _signal: NodeJS.Signals | 0): void => {
      const err = new Error("operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    };

    expect(findEngineProcesses({ procRoot, kill })[0]!.orphaned).toBe(true);
  });

  test("an engine with no usable owner pid is left alone, not assumed abandoned", () => {
    // "We cannot tell who owns this" must never read as "nobody does".
    const procRoot = tmpDir();
    fakeProcess(procRoot, 1234, {
      env: engineEnv({ [ENGINE_OWNER_PID_ENV]: "" }),
      argv: ["bun", "--smol", BUNDLE],
    });
    const { kill } = recordingKill(new Set());

    const found = findEngineProcesses({ procRoot, kill });
    expect(found).toHaveLength(1);
    expect(found[0]!.orphaned).toBe(false);
  });
});

describe("reaping", () => {
  test("signals only the orphans, politely first", async () => {
    const procRoot = tmpDir();
    fakeProcess(procRoot, 1234, { env: engineEnv(), argv: ["bun", "--smol", BUNDLE] });
    fakeProcess(procRoot, 5678, {
      env: engineEnv({ [ENGINE_OWNER_PID_ENV]: "999002" }),
      argv: ["bun", "--smol", BUNDLE],
    });
    fakeProcess(procRoot, 999002, { env: {}, argv: ["bun", "daemon"], startTicks: "5000" });
    const { kill, calls } = recordingKill(new Set([1234, 5678, 999002]), procRoot);

    const { reaped, live } = await reapOrphanedEngines({ procRoot, kill, graceMs: 1_000 });
    expect(reaped.map((e) => e.pid)).toEqual([1234]);
    expect(live.map((e) => e.pid)).toEqual([5678]);
    // SIGTERM only: the recorder's process dies on it, so no escalation.
    expect(calls).toEqual([{ pid: 1234, signal: "SIGTERM" }]);
  });

  test("escalates to SIGKILL for an orphan that ignores SIGTERM", async () => {
    const procRoot = tmpDir();
    fakeProcess(procRoot, 1234, { env: engineEnv(), argv: ["bun", "--smol", BUNDLE] });
    const alive = new Set([1234]);
    const calls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
      if (signal !== 0) calls.push({ pid, signal });
      if (!alive.has(pid)) {
        const err = new Error("gone") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      if (signal === "SIGKILL") {
        // Deaf to SIGTERM; only SIGKILL ends it, and the fake machine has to
        // reflect that or the re-check before each signal never settles.
        alive.delete(pid);
        rmSync(resolve(procRoot, String(pid)), { recursive: true, force: true });
      }
    };

    const { reaped } = await reapOrphanedEngines({ procRoot, kill, graceMs: 200 });
    expect(reaped.map((e) => e.pid)).toEqual([1234]);
    expect(calls).toEqual([
      { pid: 1234, signal: "SIGTERM" },
      { pid: 1234, signal: "SIGKILL" },
    ]);
  });

  test("re-checks identity before signalling, so a recycled pid is spared", async () => {
    // The pid exists at scan time and is ours; by the time the signal would
    // go out the process is gone and something else has the number. Modelled
    // by rewriting the fixture between the scan and the kill.
    const procRoot = tmpDir();
    fakeProcess(procRoot, 1234, { env: engineEnv(), argv: ["bun", "--smol", BUNDLE] });
    const calls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    let firstProbe = true;
    const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
      if (signal !== 0) calls.push({ pid, signal });
      if (pid === 999001) {
        if (firstProbe) {
          firstProbe = false;
          // Owner is gone -> pid 1234 is an orphan, as far as the scan sees.
          const err = new Error("gone") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
      }
    };
    const found = findEngineProcesses({ procRoot, kill });
    expect(found[0]!.orphaned).toBe(true);

    // Now 1234 is somebody else's shell: same pid, no marker.
    rmSync(resolve(procRoot, "1234"), { recursive: true, force: true });
    fakeProcess(procRoot, 1234, { env: { PATH: "/usr/bin" }, argv: ["zsh"] });

    const { reaped } = await reapOrphanedEngines({ procRoot, kill, graceMs: 100 });
    expect(reaped).toEqual([]);
    expect(calls).toEqual([]); // nothing was signalled at all
  });

  test("`only` confines a reap to the pids the caller names", async () => {
    const procRoot = tmpDir();
    fakeProcess(procRoot, 1234, { env: engineEnv(), argv: ["bun", "--smol", BUNDLE] });
    fakeProcess(procRoot, 4567, { env: engineEnv(), argv: ["bun", "--smol", BUNDLE] });
    const { kill, calls } = recordingKill(new Set([1234, 4567]), procRoot);

    const { reaped } = await reapOrphanedEngines({
      procRoot,
      kill,
      graceMs: 500,
      only: [4567],
    });
    expect(reaped.map((e) => e.pid)).toEqual([4567]);
    expect(calls).toEqual([{ pid: 4567, signal: "SIGTERM" }]);
  });

  test("does nothing at all when there is nothing to reap", async () => {
    const procRoot = tmpDir();
    fakeProcess(procRoot, 1111, { env: { PATH: "/usr/bin" }, argv: ["bun", "test"] });
    const { kill, calls } = recordingKill(new Set([1111]));

    const { reaped } = await reapOrphanedEngines({ procRoot, kill });
    expect(reaped).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("pruning the bundle cache", () => {
  /** A cache dir with `count` bundles, oldest last. */
  function cacheWith(bundles: Array<{ name: string; ageMs: number }>): string {
    const root = resolve(tmpDir(), "engine");
    mkdirSync(root, { recursive: true });
    const now = Date.now();
    for (const b of bundles) {
      const dir = resolve(root, b.name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, "main.js"), "// bundle\n".repeat(100));
      const when = (now - b.ageMs) / 1000;
      utimesSync(dir, when, when);
    }
    return root;
  }

  test("keeps the newest N and deletes the rest", () => {
    const root = cacheWith([
      { name: "aaa", ageMs: 1_000 },
      { name: "bbb", ageMs: 2_000 },
      { name: "ccc", ageMs: 3_000 },
      { name: "ddd", ageMs: 4_000 },
    ]);
    const r = pruneEngineBundleCache({ root, keep: 2, maxAgeMs: 0, recentlyUsedMs: 0 });
    expect(r.deleted.map((d) => d.split("/").pop()).sort()).toEqual(["ccc", "ddd"]);
    expect(existsSync(resolve(root, "aaa"))).toBe(true);
    expect(existsSync(resolve(root, "bbb"))).toBe(true);
    expect(existsSync(resolve(root, "ccc"))).toBe(false);
    expect(r.freedBytes).toBeGreaterThan(0);
  });

  test("deletes by age independently of the count cap", () => {
    const root = cacheWith([
      { name: "fresh", ageMs: 1_000 },
      { name: "ancient", ageMs: 40 * 24 * 60 * 60_000 },
    ]);
    const r = pruneEngineBundleCache({ root, keep: 0, maxAgeMs: 7 * 24 * 60 * 60_000 });
    expect(r.deleted.map((d) => d.split("/").pop())).toEqual(["ancient"]);
    expect(existsSync(resolve(root, "fresh"))).toBe(true);
  });

  test("never deletes a protected bundle, however old or numerous", () => {
    // The in-use bundle. Deleting this is the one outcome that turns a tidy-up
    // into an outage: the running engine's main.js disappears underneath it.
    const root = cacheWith([
      { name: "new1", ageMs: 1_000 },
      { name: "new2", ageMs: 2_000 },
      { name: "inuse", ageMs: 400 * 24 * 60 * 60_000 },
    ]);
    const r = pruneEngineBundleCache({
      root,
      keep: 1,
      maxAgeMs: 1_000,
      protect: [resolve(root, "inuse")],
    });
    expect(existsSync(resolve(root, "inuse"))).toBe(true);
    expect(r.deleted).not.toContain(resolve(root, "inuse"));
  });

  test("disabling both caps prunes nothing", () => {
    const root = cacheWith([
      { name: "a", ageMs: 1_000 },
      { name: "b", ageMs: 400 * 24 * 60 * 60_000 },
    ]);
    const r = pruneEngineBundleCache({ root, keep: 0, maxAgeMs: 0 });
    expect(r.deleted).toEqual([]);
    expect(existsSync(resolve(root, "b"))).toBe(true);
  });

  test("a missing cache dir is a no-op, not an error", () => {
    const r = pruneEngineBundleCache({ root: resolve(tmpDir(), "does-not-exist") });
    expect(r).toEqual({ deleted: [], kept: [], freedBytes: 0 });
  });

  test("ignores stray files next to the bundle dirs", () => {
    const root = cacheWith([{ name: "a", ageMs: 1_000 }]);
    writeFileSync(resolve(root, "notes.txt"), "hi");
    const r = pruneEngineBundleCache({ root, keep: 0, maxAgeMs: 1, recentlyUsedMs: 0 });
    expect(existsSync(resolve(root, "notes.txt"))).toBe(true);
    expect(r.deleted.map((d) => d.split("/").pop())).toEqual(["a"]);
  });

  test("keeps a bundle used recently, whatever the caps say", () => {
    // The steady state of a second checkout: its daemon is alive and holding
    // this bundle, but its pooled engine was evicted minutes ago so there is
    // no process to find. Deleting it here breaks that daemon's next run.
    const root = cacheWith([
      { name: "mine", ageMs: 1_000 },
      { name: "theirs", ageMs: 60 * 60_000 }, // an hour old: still in use
    ]);
    const r = pruneEngineBundleCache({
      root,
      keep: 1,
      maxAgeMs: 60_000,
      recentlyUsedMs: 24 * 60 * 60_000,
    });
    expect(r.deleted).toEqual([]);
    expect(existsSync(resolve(root, "theirs"))).toBe(true);
  });

  test("keeps a bundle a live engine process is executing", () => {
    // Even when the bundle is ancient and the caps say it should go: an
    // engine is running out of it right now.
    const root = cacheWith([
      { name: "new1", ageMs: 1_000 },
      { name: "running", ageMs: 400 * 24 * 60 * 60_000 },
    ]);
    const procRoot = resolve(tmpDir(), "fakeproc");
    mkdirSync(procRoot, { recursive: true });
    const runningBundle = resolve(root, "running", "main.js");
    fakeProcess(procRoot, 2468, {
      env: engineEnv({ [ENGINE_BUNDLE_ENV]: runningBundle }),
      argv: ["bun", "--smol", runningBundle],
    });

    const r = pruneEngineBundleCache({
      root,
      keep: 1,
      maxAgeMs: 1_000,
      recentlyUsedMs: 0,
      scan: { procRoot, kill: recordingKill(new Set()).kill },
    });
    expect(existsSync(resolve(root, "running"))).toBe(true);
    expect(r.deleted).not.toContain(resolve(root, "running"));
  });

  test("protected bundles do not eat the keep budget", () => {
    // Three checkouts, each protecting its own bundle, with keep=3. If
    // protections counted against the budget it would already be spent and
    // every other bundle would go -- including ones that are merely old, not
    // abandoned. The budget governs the UNPROTECTED remainder.
    const root = cacheWith([
      { name: "p1", ageMs: 1_000 },
      { name: "p2", ageMs: 2_000 },
      { name: "p3", ageMs: 3_000 },
      { name: "spare1", ageMs: 10 * 24 * 60 * 60_000 },
      { name: "spare2", ageMs: 11 * 24 * 60 * 60_000 },
      { name: "junk", ageMs: 12 * 24 * 60 * 60_000 },
    ]);
    const r = pruneEngineBundleCache({
      root,
      keep: 2,
      maxAgeMs: 0,
      recentlyUsedMs: 0,
      protect: [resolve(root, "p1"), resolve(root, "p2"), resolve(root, "p3")],
    });
    // All three protected survive, plus the two newest unprotected ones.
    for (const name of ["p1", "p2", "p3", "spare1", "spare2"]) {
      expect(existsSync(resolve(root, name))).toBe(true);
    }
    expect(r.deleted.map((d) => d.split("/").pop())).toEqual(["junk"]);
  });

  test("an in-use list from the caller replaces the process scan", () => {
    const root = cacheWith([
      { name: "new", ageMs: 1_000 },
      { name: "elsewhere", ageMs: 400 * 24 * 60 * 60_000 },
    ]);
    const r = pruneEngineBundleCache({
      root,
      keep: 1,
      maxAgeMs: 1_000,
      recentlyUsedMs: 0,
      inUseBundleDirs: [resolve(root, "elsewhere")],
    });
    expect(existsSync(resolve(root, "elsewhere"))).toBe(true);
    expect(r.deleted).not.toContain(resolve(root, "elsewhere"));
  });

  test("refuses to prune a shared read-only bundle root", () => {
    // Host-owned, shared between tenants, and never ours to delete from.
    const root = cacheWith([{ name: "old", ageMs: 400 * 24 * 60 * 60_000 }]);
    const previous = process.env["JARVIS_ENGINE_CACHE_ROOT"];
    process.env["JARVIS_ENGINE_CACHE_ROOT"] = root;
    try {
      const r = pruneEngineBundleCache({ root, keep: 0, maxAgeMs: 1, recentlyUsedMs: 0 });
      expect(r.deleted).toEqual([]);
      expect(existsSync(resolve(root, "old"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env["JARVIS_ENGINE_CACHE_ROOT"];
      else process.env["JARVIS_ENGINE_CACHE_ROOT"] = previous;
    }
  });
});

describe("end to end, against a real process", () => {
  test("reaps an engine whose owner really did die", async () => {
    // A stand-in engine with its own watchdog DISABLED, so the only thing
    // that can reclaim it is the reaper. This is the pre-shim bundle case:
    // an engine on disk from before this fix, orphaned on a machine that has
    // since been upgraded.
    const dir = tmpDir();
    const bundleDir = resolve(dir, "engine", "deadbeef");
    mkdirSync(bundleDir, { recursive: true });
    const bundlePath = resolve(bundleDir, "main.js");
    writeFileSync(bundlePath, `setInterval(() => {}, 1000);\nsetTimeout(() => process.exit(3), 30000);\nconsole.log("up");\n`);

    const launcherPath = resolve(dir, "launcher.js");
    writeFileSync(
      launcherPath,
      `
const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const stat = readFileSync("/proc/self/stat", "utf8");
const ownerStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
const child = spawn(process.execPath, ["--smol", ${JSON.stringify(bundlePath)}], {
  env: {
    PATH: process.env.PATH,
    ${JSON.stringify(ENGINE_MARKER_ENV)}: ${JSON.stringify(ENGINE_MARKER_VALUE)},
    ${JSON.stringify(ENGINE_BUNDLE_ENV)}: ${JSON.stringify(bundlePath)},
    ${JSON.stringify(ENGINE_OWNER_PID_ENV)}: String(process.pid),
    ${JSON.stringify(ENGINE_OWNER_START_ENV)}: ownerStart,
    ${JSON.stringify(ENGINE_STARTED_AT_ENV)}: String(Date.now()),
    ${JSON.stringify(ENGINE_ORPHAN_POLL_ENV)}: "0",
  },
  stdio: ["ignore", "pipe", "ignore"],
  detached: true,
});
child.unref();
child.stdout.once("data", () => {
  process.stdout.write(String(child.pid));
  process.exit(0);
});
`,
    );

    const pid = await new Promise<number>((res, rej) => {
      const launcher = spawn(process.execPath, [launcherPath], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      launcher.stdout.on("data", (c: Buffer) => {
        out += c.toString("utf8");
      });
      launcher.on("close", () => {
        const n = Number.parseInt(out.trim(), 10);
        if (Number.isInteger(n) && n > 0) res(n);
        else rej(new Error(`launcher printed no pid: ${JSON.stringify(out)}`));
      });
      setTimeout(() => rej(new Error("launcher never exited")), 20_000);
    });

    /**
     * Running, as opposed to gone OR a zombie. A reaped orphan is reparented
     * to a subreaper that may not have called wait() yet, and a zombie still
     * answers `kill(pid, 0)` -- it holds no memory, no timers and no sockets,
     * so treating it as alive would fail this test for the wrong reason.
     */
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
      } catch {
        return false;
      }
    };

    try {
      // It is genuinely orphaned and genuinely still running.
      expect(alive()).toBe(true);
      const found = findEngineProcesses().filter((e) => e.pid === pid);
      expect(found).toHaveLength(1);
      expect(found[0]!.orphaned).toBe(true);
      expect(found[0]!.bundlePath).toBe(bundlePath);

      // `only` keeps this confined to the process this test started. Without
      // it, a test run would reap every orphaned engine on the machine --
      // including another worktree's, which is exactly the blast radius this
      // whole module is written to avoid.
      const { reaped } = await reapOrphanedEngines({ graceMs: 2_000, only: [pid] });
      expect(reaped.map((e) => e.pid)).toEqual([pid]);
      expect(alive()).toBe(false);
    } finally {
      // Its own bundle path is unique to this temp dir, so this can only ever
      // be our stand-in; it also self-destructs after 30s.
      if (alive() && findEngineProcesses().some((e) => e.pid === pid && e.bundlePath === bundlePath)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* raced */
        }
      }
    }
  }, 60_000);
});

/**
 * #546, the outside view. The daemon now calls prctl(PR_SET_DUMPABLE, 0) at
 * startup, so the OWNER of every engine on this machine is non-dumpable: the
 * files under its /proc/<pid> belong to root and the ptrace-gated ones are
 * closed. The reaper decides whether to kill an engine by asking about that
 * owner, and both of its answers fail safe toward "assume alive" -- so a
 * regression here leaks orphans silently and undoes #501 without a single
 * error message. Hence a real engine, a real non-dumpable owner, and both
 * verdicts asserted.
 *
 * The engine's own watchdog is disabled (poll 0), so the reaper is the only
 * thing that can reclaim it: what is measured is the reaper, not the shim.
 */
describe.skipIf(process.platform !== "linux")(
  "with the owner's process inspection blocked (#546)",
  () => {
    const HARDENING_MODULE = resolve(import.meta.dir, "..", "..", "..", "daemon", "process-hardening.ts");

    test("an engine of a hardened owner is left alone while it lives, then reaped once it dies", async () => {
      const dir = tmpDir();
      const bundleDir = resolve(dir, "engine", "hardened");
      mkdirSync(bundleDir, { recursive: true });
      const bundlePath = resolve(bundleDir, "main.js");
      writeFileSync(
        bundlePath,
        `setInterval(() => {}, 1000);\nsetTimeout(() => process.exit(3), 60000);\nconsole.log("up");\n`,
      );

      // The owner hardens itself exactly as startDaemon does, proves it took
      // effect, stamps its own start time from /proc/self/stat while
      // non-dumpable, spawns the engine, and STAYS ALIVE until killed.
      const launcherPath = resolve(dir, "hardened-launcher.js");
      writeFileSync(
        launcherPath,
        `
const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { hardenProcessInspection } = await import(${JSON.stringify(HARDENING_MODULE)});
const outcome = hardenProcessInspection({ log: () => {} });
if (outcome.kind !== "hardened") {
  process.stderr.write("HARDENING FAILED " + JSON.stringify(outcome));
  process.exit(9);
}
let environ = "readable";
try { readFileSync("/proc/self/environ"); } catch (e) { environ = e.code; }
if (environ !== "EACCES") {
  process.stderr.write("NOT ACTUALLY HARDENED: environ is " + environ);
  process.exit(8);
}
const stat = readFileSync("/proc/self/stat", "utf8");
const ownerStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
const child = spawn(process.execPath, ["--smol", ${JSON.stringify(bundlePath)}], {
  env: {
    PATH: process.env.PATH,
    ${JSON.stringify(ENGINE_MARKER_ENV)}: ${JSON.stringify(ENGINE_MARKER_VALUE)},
    ${JSON.stringify(ENGINE_BUNDLE_ENV)}: ${JSON.stringify(bundlePath)},
    ${JSON.stringify(ENGINE_OWNER_PID_ENV)}: String(process.pid),
    ${JSON.stringify(ENGINE_OWNER_START_ENV)}: ownerStart,
    ${JSON.stringify(ENGINE_STARTED_AT_ENV)}: String(Date.now()),
    ${JSON.stringify(ENGINE_ORPHAN_POLL_ENV)}: "0",
  },
  stdio: ["ignore", "pipe", "ignore"],
  detached: true,
});
child.unref();
// The stamp goes out too: what the owner read of ITSELF while non-dumpable
// must equal what a stranger reads back, or the recycled-pid check is blind.
child.stdout.once("data", () => process.stdout.write(child.pid + " " + ownerStart + "\\n"));
// Self-destruct, so a failed assertion cannot strand the owner either.
setTimeout(() => process.exit(0), 60000);
`,
      );

      const launcher = spawn(process.execPath, [launcherPath], { stdio: ["ignore", "pipe", "pipe"] });
      // Registered BEFORE the await below: a rejection there (the launcher
      // never reports) would otherwise leave it, and the watchdog-disabled
      // engine it may already have spawned, running on this machine until
      // their self-destruct timers fire.
      standIns.push(launcher);
      let stderr = "";
      launcher.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString("utf8");
      });
      const reported = await new Promise<{ pid: number; ownerStart: string }>((res, rej) => {
        let out = "";
        launcher.stdout?.on("data", (c: Buffer) => {
          out += c.toString("utf8");
          if (!out.includes("\n")) return;
          const [pidText, startText] = out.trim().split(/\s+/);
          const n = Number.parseInt(pidText ?? "", 10);
          if (Number.isInteger(n) && n > 0 && startText) res({ pid: n, ownerStart: startText });
        });
        launcher.on("close", (code) =>
          rej(new Error(`hardened launcher exited ${code} before reporting: ${JSON.stringify(stderr)}`)),
        );
        setTimeout(() => rej(new Error("hardened launcher never reported an engine pid")), 20_000);
      });
      const enginePid = reported.pid;
      const ownerPid = launcher.pid!;

      const running = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
        } catch {
          return false;
        }
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
        } catch {
          return false;
        }
      };

      try {
        // The owner really is closed to us, so this test cannot pass by the
        // hardening having quietly not happened.
        expect(() => readFileSync(`/proc/${ownerPid}/environ`)).toThrow(/EACCES/);

        // The recycled-pid check, pinned directly. `ownerIsAlive` compares the
        // stamp the owner took of ITSELF while non-dumpable against field 22
        // read back from outside, and it treats an unreadable read as "alive"
        // -- so if that read closed, nothing else in this test would notice
        // (verified by mutation: forcing it to null leaves this test green).
        // Assert the equality the check depends on.
        const ownerStatNow = readFileSync(`/proc/${ownerPid}/stat`, "utf8");
        expect(ownerStatNow.slice(ownerStatNow.lastIndexOf(')') + 2).split(' ')[19])
          .toBe(reported.ownerStart);

        // The CLI's reads of a running daemon, from a stranger process (this
        // one): src/cli/systemd-unit.ts takes the ppid out of `stat` and the
        // unit out of `cgroup` to route `jarvis restart` and `jarvis update`
        // through systemd. Neither is ptrace-gated, so both must survive --
        // and nothing else in the suite would notice if they stopped.
        expect(readFileSync(`/proc/${ownerPid}/cgroup`, "utf8").length).toBeGreaterThan(0);
        expect(ownerStatNow.slice(ownerStatNow.lastIndexOf(')') + 2).split(' ')[1])
          .toMatch(/^\d+$/);

        // And the positive half of what #546 buys, from the same stranger
        // vantage point: the owner's descriptors are closed to us even though
        // its own readlink of them still works (pinned in
        // src/daemon/process-hardening.test.ts).
        expect(() => readlinkSync(`/proc/${ownerPid}/fd/1`)).toThrow(/EACCES/);

        // --- While the owner lives: identified, and NOT orphaned. ---
        // This is the assertion that catches the dangerous regression. Both
        // liveness probes (kill(owner, 0) and /proc/<owner>/stat field 22) run
        // against a non-dumpable owner here; if either returned EPERM or came
        // back empty, the reaper would read a recycled pid and SIGKILL the
        // engine of a perfectly healthy daemon.
        const live = findEngineProcesses().filter((e) => e.pid === enginePid);
        expect(live).toHaveLength(1);
        expect(live[0]!.orphaned).toBe(false);
        expect(live[0]!.ownerPid).toBe(ownerPid);
        expect(live[0]!.bundlePath).toBe(bundlePath);
        expect(live[0]!.startTicks).toMatch(/^\d+$/);

        // And a reap aimed straight at it does nothing, because it is not an
        // orphan.
        const spared = await reapOrphanedEngines({ graceMs: 500, only: [enginePid] });
        expect(spared.reaped).toEqual([]);
        expect(spared.live.map((e) => e.pid)).toEqual([enginePid]);
        expect(running(enginePid)).toBe(true);

        // --- Now the owner dies, the way a daemon dies without teardown. ---
        // Our own child, by handle.
        launcher.kill("SIGKILL");
        const orphanDeadline = Date.now() + 10_000;
        let seen = findEngineProcesses().filter((e) => e.pid === enginePid);
        while ((seen.length !== 1 || !seen[0]!.orphaned) && Date.now() < orphanDeadline) {
          await new Promise((r) => setTimeout(r, 100));
          seen = findEngineProcesses().filter((e) => e.pid === enginePid);
        }
        expect(seen).toHaveLength(1);
        expect(seen[0]!.orphaned).toBe(true);
        expect(running(enginePid)).toBe(true);

        // --- And it is reclaimed. ---
        const { reaped, survived } = await reapOrphanedEngines({ graceMs: 2_000, only: [enginePid] });
        expect(survived).toEqual([]);
        expect(reaped.map((e) => e.pid)).toEqual([enginePid]);
        expect(running(enginePid)).toBe(false);
      } finally {
        if (launcher.exitCode === null && launcher.signalCode === null) {
          try {
            launcher.kill("SIGKILL");
          } catch {
            /* gone */
          }
        }
        // Its bundle path is unique to this temp dir, so this can only be our
        // own stand-in; it also self-destructs.
        if (
          running(enginePid) &&
          findEngineProcesses().some((e) => e.pid === enginePid && e.bundlePath === bundlePath)
        ) {
          try {
            process.kill(enginePid, "SIGKILL");
          } catch {
            /* raced */
          }
        }
      }
    }, 90_000);
  },
);
