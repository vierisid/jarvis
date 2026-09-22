/**
 * The owner's half of #491: whatever spawns an engine must be able to get it
 * back, and a test run that fails to must say so.
 *
 * Everything here runs in a CHILD bun process that imports `spawn.ts` itself.
 * That is not ceremony: the live-engine registry is module state shared by
 * every suite in a `bun test` run, and a test that called `killLiveEngines()`
 * in-process could reach an engine belonging to a different suite. A child
 * process gets its own registry, and it is also the only way to observe an
 * exit-time guard at all.
 *
 * The stand-in "engine" is a few lines of JS: `spawnEngine` only cares that
 * the path is something the runtime can execute.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const SPAWN_MODULE = resolve(import.meta.dir, "spawn.ts");

/** Stays up until signalled; dies on SIGTERM (runtime default). */
const COOPERATIVE = `setInterval(() => {}, 1000); console.log("up");`;
/** Deaf to SIGTERM, exactly like a pre-shim engine bundle. */
const DEAF = `
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
console.log("up");
`;

let tmp: string | null = null;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

function write(name: string, body: string): string {
  tmp ??= mkdtempSync(resolve(tmpdir(), "jarvis-engine-teardown-"));
  const path = resolve(tmp, name);
  writeFileSync(path, body);
  return path;
}

/**
 * Run a script in a child bun process and return its exit status + output.
 * The child inherits nothing that matters; NODE_ENV is set explicitly per
 * test because the leak guard keys off it.
 */
function runChild(
  body: string,
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const path = write(`child-${Math.random().toString(36).slice(2)}.ts`, body);
  const r = spawnSync(process.execPath, [path], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Preamble: import spawnEngine + friends and define a spawn helper. */
function preamble(enginePath: string): string {
  return `
import { spawnEngine, liveEngines, killLiveEngines } from ${JSON.stringify(SPAWN_MODULE)};
// Waits for the stand-in to announce itself before handing it back: a signal
// delivered during the runtime's first milliseconds lands before any handler
// is registered, and would make a "does it ignore SIGTERM?" test meaningless.
const start = async (id: string) => {
  const e = spawnEngine({
    bundlePath: ${JSON.stringify(enginePath)},
    sandboxId: id,
    sandboxWsPort: 1,
    baseCodeDir: ${JSON.stringify(tmpdir())},
  });
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("stand-in never started")), 20000);
    e.stdout?.once("data", () => { clearTimeout(timer); res(); });
  });
  e.stdout?.resume();
  e.stderr?.resume();
  return e;
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
`;
}

describe("live engine registry", () => {
  test("tracks a spawned engine and forgets it once it exits", () => {
    const enginePath = write("coop.js", COOPERATIVE);
    const r = runChild(`${preamble(enginePath)}
const e = await start("sandbox-a");
if (liveEngines().length !== 1) throw new Error("not tracked: " + String(liveEngines().length));
if (liveEngines()[0]!.pid !== e.pid) throw new Error("wrong pid");
if (liveEngines()[0]!.sandboxId !== "sandbox-a") throw new Error("wrong sandbox");
e.kill("SIGTERM");
await e.exited;
if (liveEngines().length !== 0) throw new Error("still tracked after exit");
console.log("OK");
`);
    expect(r.stderr).not.toContain("engine-leak-guard");
    expect(r.stdout).toContain("OK");
    expect(r.status).toBe(0);
  }, 60_000);

  test("killLiveEngines reclaims every engine it spawned", () => {
    const enginePath = write("coop.js", COOPERATIVE);
    const r = runChild(`${preamble(enginePath)}
const a = await start("sandbox-a");
const b = await start("sandbox-b");
const reclaimed = await killLiveEngines({ graceMs: 3000 });
if (reclaimed.length !== 2) throw new Error("reclaimed " + reclaimed.length);
await Promise.all([a.exited, b.exited]);
if (alive(a.pid) || alive(b.pid)) throw new Error("still alive");
if (liveEngines().length !== 0) throw new Error("registry not empty");
console.log("OK");
`);
    expect(r.stdout).toContain("OK");
    expect(r.status).toBe(0);
  }, 60_000);

  test("killLiveEngines escalates to SIGKILL for an engine that ignores SIGTERM", () => {
    // The transition case that must keep working: a bundle cached before the
    // lifecycle shim existed, or an engine wedged in native code.
    const enginePath = write("deaf.js", DEAF);
    const r = runChild(`${preamble(enginePath)}
const e = await start("sandbox-deaf");
const t0 = Date.now();
await killLiveEngines({ graceMs: 300 });
const exit = await e.exited;
if (exit.signal !== "SIGKILL") throw new Error("expected SIGKILL, got " + JSON.stringify(exit));
if (Date.now() - t0 < 300) throw new Error("did not wait out the grace window first");
console.log("OK");
`);
    expect(r.stdout).toContain("OK");
    expect(r.status).toBe(0);
  }, 60_000);

  test("killLiveEngines on an empty registry is a no-op", () => {
    const enginePath = write("coop.js", COOPERATIVE);
    const r = runChild(`${preamble(enginePath)}
const reclaimed = await killLiveEngines();
if (reclaimed.length !== 0) throw new Error("reclaimed something from nothing");
console.log("OK");
`);
    expect(r.stdout).toContain("OK");
    expect(r.status).toBe(0);
  }, 60_000);
});

describe("exit net", () => {
  test("an owner exiting with an engine alive takes the engine with it", () => {
    // Not the loud guard -- the plain safety net for any process (a script, a
    // daemon) that exits without tidying up. It can only SIGKILL, because an
    // `exit` handler cannot wait for anything.
    const enginePath = write("coop.js", COOPERATIVE);
    const r = runChild(`${preamble(enginePath)}
const e = await start("sandbox-abandoned");
process.stdout.write("PID:" + e.pid + "\\n");
process.exit(0);
`);
    expect(r.status).toBe(0);
    const pid = Number.parseInt(r.stdout.match(/PID:(\d+)/)?.[1] ?? "", 10);
    expect(Number.isInteger(pid)).toBe(true);
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        // Existence check only; this pid came from our own child.
        process.kill(pid, 0);
        Bun.sleepSync(20);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 60_000);
});

/**
 * The loud guard, exercised the way it actually runs: a real `bun test`
 * invocation with the repo's preload, over a throwaway test file that leaks
 * an engine. Nothing simpler would do -- `bun test` does not run `process.on
 * ("exit")` handlers at all (measured), which is exactly why the guard hangs
 * off a run-level `afterAll` instead.
 */
describe("leaked engine guard", () => {
  const PRELOAD = resolve(import.meta.dir, "../../../test-preload.ts");

  function runInnerSuite(
    body: string,
    env: Record<string, string> = {},
  ): { status: number | null; stdout: string; stderr: string } {
    const dir = mkdtempSync(resolve(tmpdir(), "jarvis-guard-suite-"));
    try {
      const file = resolve(dir, "leaky.test.ts");
      writeFileSync(file, body);
      const r = spawnSync(process.execPath, ["test", "--preload", PRELOAD, file], {
        encoding: "utf8",
        timeout: 120_000,
        // Run from the temp dir so the inner run picks up no bunfig of its
        // own; the preload is passed explicitly.
        cwd: dir,
        env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env },
      });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a suite that leaves an engine running fails the run, loudly", () => {
    const enginePath = write("coop.js", COOPERATIVE);
    const r = runInnerSuite(`
import { test, expect } from "bun:test";
import { spawnEngine } from ${JSON.stringify(SPAWN_MODULE)};

test("leaks an engine", () => {
  const e = spawnEngine({
    bundlePath: ${JSON.stringify(enginePath)},
    sandboxId: "sandbox-leaked",
    sandboxWsPort: 1,
    baseCodeDir: ${JSON.stringify(tmpdir())},
  });
  e.stdout?.resume();
  e.stderr?.resume();
  console.log("LEAKED-PID:" + e.pid);
  expect(e.pid).toBeGreaterThan(0);
});
`);
    const output = r.stdout + r.stderr;
    expect(output).toContain("engine-leak-guard");
    expect(output).toContain("sandbox-leaked");
    // Loud means the run FAILS, not just a line in the scrollback.
    expect(r.status).not.toBe(0);

    // And the straggler was reclaimed, not merely reported.
    const pid = Number.parseInt(output.match(/LEAKED-PID:(\d+)/)?.[1] ?? "", 10);
    expect(Number.isInteger(pid)).toBe(true);
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(pid, 0);
        Bun.sleepSync(20);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 180_000);

  test("a suite that cleans up passes, with nothing printed", () => {
    const enginePath = write("coop.js", COOPERATIVE);
    const r = runInnerSuite(`
import { test, expect } from "bun:test";
import { spawnEngine } from ${JSON.stringify(SPAWN_MODULE)};

test("tidies up after itself", async () => {
  const e = spawnEngine({
    bundlePath: ${JSON.stringify(enginePath)},
    sandboxId: "sandbox-tidy",
    sandboxWsPort: 1,
    baseCodeDir: ${JSON.stringify(tmpdir())},
  });
  e.stdout?.resume();
  e.stderr?.resume();
  e.kill("SIGTERM");
  await e.exited;
  expect(e.alive()).toBe(false);
});
`);
    const output = r.stdout + r.stderr;
    expect(output).not.toContain("engine-leak-guard");
    expect(r.status).toBe(0);
  }, 180_000);

  test("honours the JARVIS_ALLOW_LEAKED_ENGINES escape hatch", () => {
    const enginePath = write("coop.js", COOPERATIVE);
    const r = runInnerSuite(
      `
import { test, expect } from "bun:test";
import { spawnEngine } from ${JSON.stringify(SPAWN_MODULE)};

test("leaks on purpose", () => {
  const e = spawnEngine({
    bundlePath: ${JSON.stringify(enginePath)},
    sandboxId: "sandbox-on-purpose",
    sandboxWsPort: 1,
    baseCodeDir: ${JSON.stringify(tmpdir())},
  });
  e.stdout?.resume();
  e.stderr?.resume();
  expect(e.pid).toBeGreaterThan(0);
});
`,
      { JARVIS_ALLOW_LEAKED_ENGINES: "1" },
    );
    // Still reported and still reclaimed -- just not fatal.
    expect(r.stdout + r.stderr).toContain("engine-leak-guard");
    expect(r.status).toBe(0);
  }, 180_000);
});
