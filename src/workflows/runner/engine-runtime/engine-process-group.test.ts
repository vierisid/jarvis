/**
 * A CODE step's process must not outlive the engine that started it.
 *
 * The engine runs a CODE step in a child process of its own
 * (no-op-code-sandbox.ts). Measured before this fix: SIGKILL to the engine's
 * pid left that child running, reparented to init, in the daemon's process
 * group. The engine now leads a process group, and the runtime signals the
 * group while the engine is alive.
 *
 * The stand-in engine starts a child the way the CODE sandbox does (an IPC
 * channel, a timer keeping it alive) and prints its pid. Every process here
 * self-destructs, and anything a failing test leaves is killed by exact pid.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn as spawnChild } from "node:child_process";
import { spawnEngine, type SpawnedEngine } from "./spawn";

const SANDBOX_MODULE = resolve(import.meta.dir, "../../activepieces/packages/server/engine/src/lib/core/code/no-op-code-sandbox.ts");

const STAND_IN = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["--eval", "process.once('message', () => {}); setInterval(() => {}, 1000); setTimeout(() => process.exit(3), 30000);"],
  { stdio: ["pipe", "pipe", "pipe", "ipc"] });
child.send({});
console.log("child " + child.pid);
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
setTimeout(() => process.exit(3), 30000);
`;

const linux = process.platform === "linux";
let tmp: string | null = null;
const pids: number[] = [];
const engines: SpawnedEngine[] = [];

afterEach(() => {
  for (const e of engines.splice(0)) if (e.alive()) e.child.kill("SIGKILL");
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone, as it should be */
    }
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

/** Running, as opposed to gone or a zombie nobody waited on. */
function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}

function pgidOf(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
}

async function start(): Promise<{ engine: SpawnedEngine; codeChild: number }> {
  tmp = mkdtempSync(resolve(tmpdir(), "jarvis-engine-pgroup-"));
  mkdirSync(resolve(tmp, "engine"));
  const bundlePath = resolve(tmp, "engine", "main.js");
  writeFileSync(bundlePath, STAND_IN);
  const engine = spawnEngine({ bundlePath, expectedDigest: null, sandboxId: "pgroup-probe", sandboxWsPort: 1, baseCodeDir: tmp, cwd: tmp });
  engines.push(engine);
  engine.stderr?.resume();
  const codeChild = await new Promise<number>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("stand-in never reported its child")), 20_000);
    let out = "";
    engine.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /child (\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        res(Number(m[1]));
      }
    });
  });
  pids.push(codeChild);
  return { engine, codeChild };
}

async function gone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!running(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !running(pid);
}

describe("an engine and the processes its CODE steps start", () => {
  test.skipIf(!linux)("the engine leads its own process group, and its CODE child is in it", async () => {
    const { engine, codeChild } = await start();
    expect(pgidOf(engine.pid)).toBe(engine.pid);
    expect(pgidOf(codeChild)).toBe(engine.pid);
    expect(pgidOf(process.pid)).not.toBe(engine.pid);
  });

  test.skipIf(!linux)("killing the engine kills its CODE child too", async () => {
    const { engine, codeChild } = await start();
    expect(running(codeChild)).toBe(true);
    engine.kill("SIGKILL");
    await engine.exited;
    expect(await gone(codeChild, 2_000)).toBe(true);
  });

  test.skipIf(!linux)("an engine that already exited is never signalled as a group", async () => {
    const { engine } = await start();
    engine.child.kill("SIGKILL");
    await engine.exited;
    const sent: number[] = [];
    const real = process.kill;
    process.kill = ((pid: number, signal?: string | number) => {
      sent.push(pid);
      return real.call(process, pid, signal);
    }) as typeof process.kill;
    try {
      engine.kill("SIGKILL");
    } finally {
      process.kill = real;
    }
    expect(sent.filter((pid) => pid < 0)).toEqual([]);
  });

  test.skipIf(!linux)("a CODE step exits when the engine that ran it dies by itself, unsignalled", async () => {
    tmp = mkdtempSync(resolve(tmpdir(), "jarvis-engine-pgroup-"));
    const pidFile = resolve(tmp, "step.pid");
    writeFileSync(resolve(tmp, "step.js"), `exports.code = async () => {
      require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setTimeout(() => process.exit(3), 30000);
      await new Promise(() => {});
    };`);
    // A stand-in engine: the real CODE sandbox, run in a process of its own
    // (not a group leader, so only the IPC channel can tell the step).
    const host = resolve(tmp, "host.ts");
    writeFileSync(host, `import { noOpCodeSandbox } from ${JSON.stringify(SANDBOX_MODULE)};
      void noOpCodeSandbox.runCodeModule({ codeFilePath: ${JSON.stringify(resolve(tmp, "step.js"))}, inputs: {} }).catch(() => {});
      setTimeout(() => process.exit(3), 30000);`);
    const engine = spawnChild(process.execPath, [host], { stdio: "ignore" });
    try {
      const deadline = Date.now() + 20_000;
      let stepPid = 0;
      while (!stepPid && Date.now() < deadline) {
        try { stepPid = Number(readFileSync(pidFile, "utf8")); } catch { await new Promise((r) => setTimeout(r, 25)); }
      }
      expect(stepPid).toBeGreaterThan(0);
      pids.push(stepPid);
      expect(running(stepPid)).toBe(true);
      // Dies by itself as far as the step can tell: nothing signals the step.
      engine.kill("SIGKILL");
      expect(await gone(stepPid, 2_000)).toBe(true);
    } finally {
      if (engine.exitCode === null && engine.signalCode === null) engine.kill("SIGKILL");
    }
  });
});
