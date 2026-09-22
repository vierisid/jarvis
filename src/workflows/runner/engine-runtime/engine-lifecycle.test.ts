/**
 * The engine's own half of #491: it must die when told, and it must die when
 * the process that spawned it dies.
 *
 * Most of this runs against a STAND-IN for the engine rather than the real
 * bundle: a few lines that reproduce the one upstream behaviour that matters
 * here (a SIGTERM listener that flushes and never exits, plus a live timer
 * keeping the loop open), with our shim prepended exactly as the esbuild
 * banner prepends it. That keeps the test honest about what it is proving --
 * the shim's logic -- and lets it run on a machine with no engine bundle.
 * The last test closes the loop against the real bundle when one is cached.
 *
 * Process safety: every kill in this file targets a pid this file itself
 * spawned. Nothing here matches by name or pattern.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  ENGINE_LIFECYCLE_SHIM,
  ENGINE_ORPHAN_POLL_ENV,
  ENGINE_OWNER_PID_ENV,
  ENGINE_OWNER_START_ENV,
  ENGINE_SHUTDOWN_GRACE_ENV,
} from "./engine-lifecycle";
import { buildEngineBundle, findCachedBundle } from "./build";
import { spawnEngine } from "./spawn";

/**
 * What the real engine does that makes it deaf to SIGTERM: upstream's
 * run-progress module registers a listener that flushes and returns, which
 * removes the runtime's default terminate-on-SIGTERM. The interval stands in
 * for the socket.io connection holding the event loop open.
 */
const DEAF_ENGINE_BODY = `
process.on("SIGTERM", () => { /* upstream: flush only, never exits */ });
process.on("SIGINT", () => { /* same */ });
setInterval(() => {}, 1000);
console.log("ready");
`;

let tmp: string | null = null;
const spawned: ChildProcess[] = [];

afterEach(() => {
  // Reclaim anything a failing assertion left behind. These are our own
  // children, by handle -- never a pattern match.
  for (const child of spawned.splice(0)) {
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

function writeScript(name: string, body: string): string {
  tmp ??= mkdtempSync(resolve(tmpdir(), "jarvis-engine-lifecycle-"));
  const path = resolve(tmp, name);
  writeFileSync(path, body);
  return path;
}

function launch(path: string, env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [path], {
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  spawned.push(child);
  return child;
}

/** Resolves with the exit description, or `null` if `ms` elapses first. */
function exitWithin(
  child: ChildProcess,
  ms: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  return new Promise((res) => {
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      res({ code, signal });
    };
    // Detach on timeout: this is called more than once on the same child, and
    // a listener per call eventually trips MaxListenersExceededWarning.
    const timer = setTimeout(() => {
      child.removeListener("close", onClose);
      res(null);
    }, ms);
    child.once("close", onClose);
  });
}

/**
 * Is `pid` still the stand-in we started? Checked before signalling a pid we
 * hold no handle for. `/proc/<pid>/cmdline` is NUL-separated argv.
 */
function isOurProcess(pid: number, scriptPath: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(scriptPath);
  } catch {
    return false;
  }
}

/** This process's start time in clock ticks (`/proc/self/stat` field 22). */
function ownStartTime(): string {
  const stat = readFileSync("/proc/self/stat", "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? "";
}

/** Resolves once the child has written anything to stdout (it is up). */
function firstOutput(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((res) => {
    const timer = setTimeout(() => res(false), ms);
    child.stdout?.once("data", () => {
      clearTimeout(timer);
      res(true);
    });
  });
}

describe("engine lifecycle shim: SIGTERM", () => {
  test("the unpatched engine shape really does ignore SIGTERM", async () => {
    // The control case. Without this, a passing test below would not tell us
    // whether the shim fixed anything or the runtime was exiting on its own.
    const path = writeScript("deaf.js", DEAF_ENGINE_BODY);
    const child = launch(path, {});
    expect(await firstOutput(child, 5_000)).toBe(true);

    child.kill("SIGTERM");
    expect(await exitWithin(child, 1_500)).toBeNull();

    child.kill("SIGKILL");
    expect(await exitWithin(child, 5_000)).not.toBeNull();
  }, 20_000);

  test("with the shim, SIGTERM exits within the grace window", async () => {
    const path = writeScript("shimmed.js", `${ENGINE_LIFECYCLE_SHIM}\n${DEAF_ENGINE_BODY}`);
    const child = launch(path, { [ENGINE_SHUTDOWN_GRACE_ENV]: "300" });
    expect(await firstOutput(child, 5_000)).toBe(true);

    const startedAt = Date.now();
    child.kill("SIGTERM");
    const exit = await exitWithin(child, 5_000);
    expect(exit).not.toBeNull();
    // Terminated BY the signal it was sent: the shim restores the default
    // disposition and re-raises rather than exiting 0, so anything waiting on
    // the engine can still tell "was told to stop" from "finished".
    expect(exit?.signal).toBe("SIGTERM");
    // It waited for the grace window rather than exiting instantly -- that
    // window is what lets upstream's run-progress flush finish.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
  }, 20_000);

  test("upstream's own SIGTERM listener still runs before the exit", async () => {
    // Registration order matters: the shim's handler goes first, so anything
    // the engine registers later still gets its turn. Proving it here means a
    // future reordering of the banner shows up as a test failure rather than
    // as silently-dropped run progress.
    const body = `
process.on("SIGTERM", () => { console.log("flushed"); });
setInterval(() => {}, 1000);
console.log("ready");
`;
    const path = writeScript("flushing.js", `${ENGINE_LIFECYCLE_SHIM}\n${body}`);
    const child = launch(path, { [ENGINE_SHUTDOWN_GRACE_ENV]: "300" });
    const seen: string[] = [];
    child.stdout?.on("data", (c: Buffer) => seen.push(c.toString("utf8")));
    await new Promise((r) => setTimeout(r, 300));

    child.kill("SIGTERM");
    expect(await exitWithin(child, 5_000)).not.toBeNull();
    expect(seen.join("")).toContain("flushed");
  }, 20_000);

  test("a second SIGTERM cuts the grace window short", async () => {
    const path = writeScript("impatient.js", `${ENGINE_LIFECYCLE_SHIM}\n${DEAF_ENGINE_BODY}`);
    // A grace window long enough that finishing inside it can only mean the
    // second signal was honoured.
    const child = launch(path, { [ENGINE_SHUTDOWN_GRACE_ENV]: "30000" });
    expect(await firstOutput(child, 5_000)).toBe(true);

    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
    child.kill("SIGTERM");
    const exit = await exitWithin(child, 5_000);
    expect(exit).not.toBeNull();
    expect(exit?.signal).toBe("SIGTERM");
  }, 20_000);
});

describe("engine lifecycle shim: orphan watchdog", () => {
  test("exits once its owner dies", async () => {
    // The real #491 shape: the owner dies without running any teardown and
    // nothing is left that could signal the engine.
    //
    // The launcher deliberately waits until the engine has BOOTED before it
    // exits. An owner that dies in the first few microseconds is a different
    // (and much easier) test: the engine would come up already orphaned, and
    // a watchdog that only ever reads a value captured at startup would pass
    // it while never firing in production. Exercise the transition.
    const enginePath = writeScript(
      "orphan.js",
      `${ENGINE_LIFECYCLE_SHIM}\n${DEAF_ENGINE_BODY}\n` +
        // Self-destruct, so a failure here cannot strand a process on a
        // shared machine even if the assertions below never run.
        `setTimeout(() => process.exit(3), 20000);\n`,
    );
    const launcherPath = writeScript(
      "launcher.js",
      `
const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const stat = readFileSync("/proc/self/stat", "utf8");
const ownerStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
const child = spawn(process.execPath, [${JSON.stringify(enginePath)}], {
  env: {
    PATH: process.env.PATH,
    ${JSON.stringify(ENGINE_OWNER_PID_ENV)}: String(process.pid),
    ${JSON.stringify(ENGINE_OWNER_START_ENV)}: ownerStart,
    ${JSON.stringify(ENGINE_ORPHAN_POLL_ENV)}: "100",
  },
  stdio: ["ignore", "pipe", "ignore"],
  detached: true,
});
child.unref();
// Stay alive well past the engine's first few watchdog polls, THEN die.
// Leaving immediately would have the engine notice its owner missing on its
// very first check, which is the easy case: an implementation that reads a
// value cached at startup (Bun caches process.ppid on first access) passes
// that version of the test and still never fires in production, where the
// owner dies minutes into the engine's life.
child.stdout.once("data", () => {
  setTimeout(() => {
    process.stdout.write(String(child.pid));
    process.exit(0);
  }, 1000);
});
`,
    );

    const launcher = launch(launcherPath, {});
    const pid = await new Promise<number>((res, rej) => {
      let out = "";
      launcher.stdout?.on("data", (c: Buffer) => {
        out += c.toString("utf8");
      });
      launcher.on("close", () => {
        const n = Number.parseInt(out.trim(), 10);
        if (Number.isInteger(n) && n > 0) res(n);
        else rej(new Error(`launcher printed no pid (got ${JSON.stringify(out)})`));
      });
      setTimeout(() => rej(new Error("launcher did not exit")), 10_000);
    });

    const alive = (): boolean => {
      try {
        // Signal 0 = existence check, delivers nothing.
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    try {
      const deadline = Date.now() + 10_000;
      while (alive() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(alive()).toBe(false);
    } finally {
      // This pid has no handle here (its parent is gone), so confirm it is
      // still OUR stand-in before signalling it: a pid freed between the poll
      // above and this line can belong to anything on a shared machine. The
      // stand-in also self-destructs, so the worst case is bounded anyway.
      if (alive() && isOurProcess(pid, enginePath)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* raced with its own exit */
        }
      }
    }
  }, 30_000);

  test("exits when its owner's pid has been recycled by another process", async () => {
    // The hole in any pid-based liveness probe. The owner pid here is alive
    // (it is this very test process) but its recorded start time does not
    // match, which is what a recycled pid looks like from the engine's side.
    const path = writeScript("recycled.js", `${ENGINE_LIFECYCLE_SHIM}\n${DEAF_ENGINE_BODY}`);
    const child = launch(path, {
      [ENGINE_OWNER_PID_ENV]: String(process.pid),
      [ENGINE_OWNER_START_ENV]: "1", // no process ever started 1 tick after boot
      [ENGINE_ORPHAN_POLL_ENV]: "100",
    });
    expect(await firstOutput(child, 5_000)).toBe(true);
    expect(await exitWithin(child, 5_000)).not.toBeNull();
  }, 20_000);

  test("stays up while its owner is alive", async () => {
    // The pooled engine case: idle, no work in flight, owner alive. The
    // watchdog must not touch it -- "still running" is not by itself wrong.
    const path = writeScript("pooled.js", `${ENGINE_LIFECYCLE_SHIM}\n${DEAF_ENGINE_BODY}`);
    const child = launch(path, {
      [ENGINE_OWNER_PID_ENV]: String(process.pid),
      [ENGINE_OWNER_START_ENV]: ownStartTime(),
      [ENGINE_ORPHAN_POLL_ENV]: "50",
    });
    expect(await firstOutput(child, 5_000)).toBe(true);
    expect(await exitWithin(child, 1_000)).toBeNull();
  }, 20_000);
});

// The real bundle carries the shim through the esbuild banner. Gated the same
// way as every other bundle-dependent suite: skipped unless a bundle for the
// current source hash is already cached (or a build is opted into).
const buildOptIn = process.env["JARVIS_TEST_ENGINE_BUILD"] === "1";
const cachedBundle = findCachedBundle();

describe("real engine bundle", () => {
  test.skipIf(cachedBundle === null && !buildOptIn)(
    "honours SIGTERM instead of needing SIGKILL",
    async () => {
      const bundle = cachedBundle ?? (await buildEngineBundle());

      // No SandboxApi here: the engine dials a port nobody is listening on and
      // retries. That is a fine state to be signalled in -- and it is closer to
      // the leaked-engine case than a healthy engine would be.
      const codeDir = mkdtempSync(resolve(tmpdir(), "jarvis-engine-code-"));
      const engine = spawnEngine({
        bundlePath: bundle.bundlePath,
        sandboxId: "sigterm-probe",
        sandboxWsPort: 1,
        baseCodeDir: codeDir,
        env: { [ENGINE_SHUTDOWN_GRACE_ENV]: "300" },
      });
      engine.stdout?.resume();
      engine.stderr?.resume();
      try {
        await new Promise((r) => setTimeout(r, 1_000));
        expect(engine.alive()).toBe(true);

        engine.kill("SIGTERM");
        const exit = await Promise.race([
          engine.exited,
          new Promise<null>((r) => setTimeout(() => r(null), 5_000)),
        ]);
        expect(exit).not.toBeNull();
        // Crucially not SIGKILLed: it left on the FIRST, polite signal. The
        // shim re-raises SIGTERM after its flush window, so that is what the
        // wait status reports.
        expect(exit?.signal).toBe("SIGTERM");
      } finally {
        if (engine.alive()) engine.kill("SIGKILL");
        rmSync(codeDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
