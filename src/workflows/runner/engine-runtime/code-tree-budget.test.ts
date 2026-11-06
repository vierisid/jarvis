/**
 * #1154: what bounds `workflow-codes` beyond the per-step caps of #865.
 *   - a lease covers the steps a run executes and keeps their mtimes fresh;
 *   - a step a draft renamed or removed is swept from its version's tree;
 *   - one version's steps together are held to CODE_VERSION_TREE_LIMIT;
 *   - the trees together are trimmed to a size budget, least recently used
 *     first, never a tree a continuing run, a lease or a recent use needs.
 * Sizes come from sparse files: the caps measure apparent size, so a 500 MiB
 * file costs no disk here.
 */
import { afterAll, describe, expect, jest, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODE_STEP_MAX_INSTALL_BYTES,
  CODE_TREE_LEASE_REFRESH_MS,
  CODE_VERSION_TREE_LIMIT,
  bunInstall,
  CodeInstallTooLargeError,
  codeTreeLeased,
  leaseCodeTree,
  leaseCodeTreeOf,
  materializeCodeActions,
  rearmCodeTreeLeaseRefresh,
  refreshLeasedCodeTrees,
  sweepStaleSteps,
} from "./code-materialize";
import { CODE_TREES_MAX_BYTES, CODE_TREES_MAX_ENTRIES, pruneCodeTrees } from "./code-tree-prune";
import type { UpstreamFlowVersion } from "./flow-version-adapter";

const MiB = 1024 * 1024;
const DAY = 24 * 60 * 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-code-budget-"));
  roots.push(dir);
  return dir;
}

/** A version whose CODE steps each declare one dependency. */
function version(id: string, steps: string[]): UpstreamFlowVersion {
  let next: unknown = undefined;
  for (const name of [...steps].reverse()) {
    next = {
      name,
      type: "CODE",
      settings: { sourceCode: { packageJson: JSON.stringify({ dependencies: { [`dep-${name}`]: "1.0.0" } }), code: "exports.code = async () => 1;" }, input: {} },
      nextAction: next,
    };
  }
  return { id, trigger: { name: "trigger", type: "EMPTY", nextAction: next } } as unknown as UpstreamFlowVersion;
}

/** An installer whose tree is one sparse file of `bytes`. */
const installOf = (bytes: number) => async (dir: string) => {
  writeFileSync(join(dir, "bun.lock"), "{}");
  mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "dep", "blob"), "");
  truncateSync(join(dir, "node_modules", "dep", "blob"), bytes);
};

function age(path: string, ms: number): void {
  const at = new Date(Date.now() - ms);
  utimesSync(path, at, at);
}

describe("leases cover the steps a run executes, and stay fresh (#1154)", () => {
  test("refreshing touches every leased version and step, and nothing else", () => {
    const base = scratch();
    for (const p of ["v1/a", "v1/b", "v2/a"]) mkdirSync(join(base, p), { recursive: true });
    for (const p of ["v1", "v1/a", "v1/b", "v2", "v2/a"]) age(join(base, p), 2 * DAY);
    const release = leaseCodeTree(base, "v1", ["a"]);
    try {
      refreshLeasedCodeTrees();
    } finally {
      release();
    }
    const fresh = (p: string) => Date.now() - lstatSync(join(base, p)).mtimeMs < 60_000;
    expect(fresh("v1")).toBe(true);
    expect(fresh("v1/a")).toBe(true);
    expect(fresh("v1/b")).toBe(false);
    expect(fresh("v2")).toBe(false);
    expect(fresh("v2/a")).toBe(false);
    // Released: a refresh now touches nothing of it.
    age(join(base, "v1"), 2 * DAY);
    refreshLeasedCodeTrees();
    expect(fresh("v1")).toBe(false);
  });

  test("the refresh interval is pinned to the pruner's own (1h), well inside its 24h window", () => {
    expect(CODE_TREE_LEASE_REFRESH_MS).toBe(60 * 60_000);
  });

  test("a held lease is refreshed on its own every interval, and a released one no longer", () => {
    const base = scratch();
    mkdirSync(join(base, "v_long", "step"), { recursive: true });
    const fresh = () => Date.now() - lstatSync(join(base, "v_long")).mtimeMs < 60_000;
    jest.useFakeTimers();
    // The interval is module-wide: any lease still held when this test starts
    // (another file's run, say) armed it on real timers, which the fake clock
    // never fires. Arm it on the fake clock.
    rearmCodeTreeLeaseRefresh();
    try {
      const release = leaseCodeTree(base, "v_long", ["step"]);
      age(join(base, "v_long"), 2 * DAY);
      jest.advanceTimersByTime(CODE_TREE_LEASE_REFRESH_MS + 1);
      expect(fresh()).toBe(true);
      release();
      age(join(base, "v_long"), 2 * DAY);
      jest.advanceTimersByTime(CODE_TREE_LEASE_REFRESH_MS + 1);
      expect(fresh()).toBe(false);
    } finally {
      jest.useRealTimers();
      rearmCodeTreeLeaseRefresh();
    }
  });
});

describe("a step the version no longer has is swept (#1154)", () => {
  test("a draft that renamed its CODE step loses the old step's tree", async () => {
    const base = scratch();
    await materializeCodeActions(version("v_draft", ["old_name"]), base, { install: installOf(1024) });
    age(join(base, "v_draft", "old_name"), 2 * DAY);
    await materializeCodeActions(version("v_draft", ["new_name"]), base, { install: installOf(1024) });
    expect(existsSync(join(base, "v_draft", "old_name"))).toBe(false);
    expect(existsSync(join(base, "v_draft", "new_name", "node_modules", "dep", "blob"))).toBe(true);
  });

  test("a step a run in this process still executes is kept", async () => {
    const base = scratch();
    await materializeCodeActions(version("v_draft", ["old_name"]), base, { install: installOf(1024) });
    age(join(base, "v_draft", "old_name"), 2 * DAY);
    const release = leaseCodeTree(base, "v_draft", ["old_name"]);
    try {
      await materializeCodeActions(version("v_draft", ["new_name"]), base, { install: installOf(1024) });
      expect(existsSync(join(base, "v_draft", "old_name", "index.js"))).toBe(true);
    } finally {
      release();
    }
  });

  test("a draft that removed its last CODE step loses that step's tree too", async () => {
    const base = scratch();
    await materializeCodeActions(version("v_draft", ["only"]), base, { install: installOf(1024) });
    age(join(base, "v_draft", "only"), 2 * DAY);
    await materializeCodeActions(version("v_draft", []), base, { install: installOf(1024) });
    expect(existsSync(join(base, "v_draft", "only"))).toBe(false);
  });

  test("a run's lease covers the steps its version executes", () => {
    const base = scratch();
    const release = leaseCodeTreeOf(base, version("v_run", ["a", "b"]));
    try {
      for (const p of ["v_run", "v_run/a", "v_run/b"]) expect(codeTreeLeased(join(base, p))).toBe(true);
      expect(codeTreeLeased(join(base, "v_run/c"))).toBe(false);
    } finally {
      release();
    }
    expect(codeTreeLeased(join(base, "v_run"))).toBe(false);
  });

  test("a step used recently (by another process, say) is kept, and an interrupted sweep is finished", async () => {
    const base = scratch();
    mkdirSync(join(base, "v", "recent"), { recursive: true });
    mkdirSync(join(base, "v", ".stale-step-dead"), { recursive: true });
    mkdirSync(join(base, "v", "old"), { recursive: true });
    age(join(base, "v", "old"), 2 * DAY);
    const removed = await sweepStaleSteps(join(base, "v"), new Set(["current"]));
    expect(removed).toEqual(["old"]);
    expect(existsSync(join(base, "v", "recent"))).toBe(true);
    expect(existsSync(join(base, "v", ".stale-step-dead"))).toBe(false);
  });
});

describe("one version's steps together are capped (#1154)", () => {
  test("the limit is four steps at the step cap", () => {
    expect(CODE_VERSION_TREE_LIMIT.maxBytes).toBe(4 * CODE_STEP_MAX_INSTALL_BYTES);
  });

  test("a step whose install would take the version past it is refused, naming it, and the others stay", async () => {
    const base = scratch();
    const steps = ["s1", "s2", "s3", "s4", "s5"];
    // Each step under its own cap; four of them leave less than 100 MiB.
    const sizes: Record<string, number> = { s1: 500 * MiB, s2: 500 * MiB, s3: 500 * MiB, s4: 500 * MiB, s5: 100 * MiB };
    const install = async (dir: string) => installOf(sizes[dir.split("/").at(-2)!]!)(dir);
    const err = await materializeCodeActions(version("v_many", steps), base, { install }).then(() => null, (e: Error) => e.message);
    expect(err).toContain('CODE step "s5"');
    expect(err).toContain("this flow version's CODE steps together");
    for (const s of steps.slice(0, 4)) expect(existsSync(join(base, "v_many", s, "node_modules", "dep", "blob"))).toBe(true);
    expect(existsSync(join(base, "v_many", "s5", "node_modules"))).toBe(false);
  });

  test("a step still awaiting the sweep does not count against the version", async () => {
    // Renamed in a draft near the limit: the old step's tree is recent, so
    // the sweep keeps it for now, but the version no longer installs into it.
    const base = scratch();
    const install = installOf(500 * MiB);
    await materializeCodeActions(version("v_d", ["s1", "s2", "s3", "s4"]), base, { install });
    await materializeCodeActions(version("v_d", ["s1", "s2", "s3", "s4_renamed"]), base, { install });
    expect(existsSync(join(base, "v_d", "s4", "node_modules"))).toBe(true);
    expect(existsSync(join(base, "v_d", "s4_renamed", "node_modules", "dep", "blob"))).toBe(true);
  });

  test.skipIf(process.platform === "win32")("the real installer holds an install to the version's remaining room, not only the step cap", async () => {
    const root = scratch();
    const work = join(root, "work");
    mkdirSync(work);
    const realExecPath = process.execPath;
    const grow = `const fs = require("fs"); fs.mkdirSync("node_modules"); fs.writeFileSync("node_modules/blob", "");` +
      ` fs.truncateSync("node_modules/blob", ${2 * MiB}); setInterval(() => {}, 1000);`;
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "bun"), `#!/bin/sh\nexec ${JSON.stringify(realExecPath)} -e ${JSON.stringify(grow)}\n`, { mode: 0o755 });
    process.execPath = join(root, "bin", "bun");
    let err: unknown;
    try {
      err = await bunInstall(work, { cacheDir: join(root, "cache"), limit: { maxBytes: MiB, maxEntries: 1000 } })
        .then(() => null, (e: unknown) => e);
    } finally {
      process.execPath = realExecPath;
    }
    expect(err).toBeInstanceOf(CodeInstallTooLargeError);
  }, 30_000);

  test("the same step alone in its version installs", async () => {
    const base = scratch();
    await materializeCodeActions(version("v_one", ["s5"]), base, { install: installOf(100 * MiB) });
    expect(existsSync(join(base, "v_one", "s5", "node_modules", "dep", "blob"))).toBe(true);
  });
});

describe("the trees together are kept under a size budget (#1154)", () => {
  /** A version tree of `mib` MiB, last used `ageMs` ago. */
  function tree(base: string, id: string, mib: number, ageMs: number): void {
    const dir = join(base, id, "step", "node_modules", "dep");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "blob"), "");
    truncateSync(join(dir, "blob"), mib * MiB);
    age(join(base, id), ageMs);
  }

  test("the budget is two versions at their limit", () => {
    expect(CODE_TREES_MAX_BYTES).toBe(2 * CODE_VERSION_TREE_LIMIT.maxBytes);
  });

  test("least recently used first, until it fits; pinned, leased and in-use trees stay", async () => {
    const base = scratch();
    // All needed (published, say) and so past the plain prune.
    tree(base, "oldest", 100, 10 * DAY);
    tree(base, "pinned", 100, 9 * DAY);
    tree(base, "leased", 100, 8 * DAY);
    tree(base, "older", 100, 7 * DAY);
    tree(base, "old", 100, 6 * DAY);
    tree(base, "inuse", 100, 60_000);
    const all = new Set(["oldest", "pinned", "leased", "older", "old", "inuse"]);
    const release = leaseCodeTree(base, "leased");
    let result;
    try {
      result = await pruneCodeTrees({
        baseCodeDir: base,
        needed: () => all,
        pinned: () => new Set(["pinned"]),
        maxBytes: 150 * MiB,
      });
    } finally {
      release();
    }
    // 600 MiB toward 150: oldest, older and old go; pinned and leased are
    // skipped though older, and inuse is too recent, so it stays over budget.
    expect(result.evicted).toEqual(["oldest", "older", "old"]);
    for (const id of ["pinned", "leased", "inuse"]) expect(existsSync(join(base, id))).toBe(true);
    for (const id of result.evicted) expect(existsSync(join(base, id))).toBe(false);
  });

  test("the entry budget evicts too: many near-empty entries", async () => {
    const base = scratch();
    for (const [id, ageMs] of [["many", 10 * DAY], ["few", 9 * DAY]] as const) {
      const dir = join(base, id, "step", "node_modules");
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < (id === "many" ? 40 : 2); i++) writeFileSync(join(dir, `f${i}`), "");
      age(join(base, id), ageMs);
    }
    expect(CODE_TREES_MAX_ENTRIES).toBe(2 * CODE_VERSION_TREE_LIMIT.maxEntries);
    const result = await pruneCodeTrees({ baseCodeDir: base, needed: () => new Set(["many", "few"]), pinned: () => new Set(),
      maxBytes: Number.MAX_SAFE_INTEGER, maxEntries: 20 });
    expect(result.evicted).toEqual(["many"]);
  });

  test("a pass refreshes the trees this process leases before it looks at mtimes", async () => {
    const base = scratch();
    mkdirSync(join(base, "v_long", "step"), { recursive: true });
    age(join(base, "v_long"), 2 * DAY);
    const release = leaseCodeTree(base, "v_long", ["step"]);
    try {
      await pruneCodeTrees({ baseCodeDir: base, needed: () => new Set() });
      expect(Date.now() - lstatSync(join(base, "v_long")).mtimeMs).toBeLessThan(60_000);
    } finally {
      release();
    }
  });

  test("under the budget, or without the pinned rule, nothing is removed for size", async () => {
    const base = scratch();
    tree(base, "a", 100, 10 * DAY);
    tree(base, "b", 100, 10 * DAY);
    const needed = () => new Set(["a", "b"]);
    expect((await pruneCodeTrees({ baseCodeDir: base, needed, pinned: () => new Set(), maxBytes: 500 * MiB })).evicted).toEqual([]);
    expect((await pruneCodeTrees({ baseCodeDir: base, needed, maxBytes: 1 })).evicted).toEqual([]);
    expect(existsSync(join(base, "a"))).toBe(true);
  });
});
