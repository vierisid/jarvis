/**
 * The warm pool's parked engine, against a real SandboxApi and a stand-in
 * engine process that dials the worker socket like the real bundle does, so
 * it runs without the engine build.
 *
 *   - A parked engine's token is revoked at park, not left valid until the
 *     next rebind, retirement or idle eviction; only its run's own late log
 *     upload still goes through.
 *   - A rebind that fails on an engine which exited meanwhile never signals
 *     through the dead handle, and its sandbox stays revoked.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { closeWorkflowDb, initWorkflowDb } from "../../db";
import { DEFAULT_IDS } from "../../db/schema";
import { CredentialResolver } from "../../credentials/adapter";
import { EngineTokenSigner } from "../../sandbox-api/engine-token";
import { SandboxApi } from "../../sandbox-api/server";
import { EngineRuntime, type EngineHandle } from "./engine-runtime";
import { signalCodeStepsRevoked } from "../../runtime/cancellation-signals";

const SOCKET_CLIENT = require.resolve("socket.io-client");

/**
 * Connects to the worker socket as the sandbox its environment names and
 * stays up. Self-destructs, so a test killed half way leaves nothing behind,
 * and is named `main.js` like an engine (see engine-teardown.test.ts).
 */
const STAND_IN = `
const { io } = require(${JSON.stringify(SOCKET_CLIENT)});
const socket = io("http://127.0.0.1:" + process.env.AP_SANDBOX_WS_PORT, {
  path: "/worker/ws", transports: ["websocket"], auth: { sandboxId: process.env.SANDBOX_ID },
});
socket.on("connect", () => console.log("connected"));
setTimeout(() => process.exit(3), 60000);
`;

let tmp: string;
let api: SandboxApi;
let runtime: EngineRuntime | null = null;
let previousDataDir: string | undefined;
/** Set to run something inside the next mint, between the pool's alive check and its rebind. */
let duringMint: (() => Promise<void>) | null = null;

class HookedSigner extends EngineTokenSigner {
  override async mint(...args: Parameters<EngineTokenSigner["mint"]>) {
    const hook = duringMint;
    duringMint = null;
    if (hook) await hook();
    return super.mint(...args);
  }
}

beforeEach(async () => {
  initWorkflowDb(":memory:");
  tmp = mkdtempSync(resolve(tmpdir(), "jarvis-engine-park-"));
  previousDataDir = process.env.JARVIS_WORKFLOW_DATA_DIR;
  process.env.JARVIS_WORKFLOW_DATA_DIR = resolve(tmp, "data");
  mkdirSync(resolve(tmp, "engine"));
  writeFileSync(resolve(tmp, "engine", "main.js"), STAND_IN);
  api = new SandboxApi({ signer: new HookedSigner(), services: { credentialResolver: new CredentialResolver() } });
  await api.start({ port: 0 });
  runtime = new EngineRuntime({
    api,
    bundlePath: resolve(tmp, "engine", "main.js"),
    expectedDigest: null,
    pool: true,
    poolIdleTtlMs: 60_000,
    killGraceMs: 200,
    cwd: tmp,
    baseCodeDir: resolve(tmp, "codes"),
  });
});

afterEach(async () => {
  duringMint = null;
  if (runtime) await runtime.shutdown();
  runtime = null;
  await api.stop();
  closeWorkflowDb();
  if (previousDataDir === undefined) delete process.env.JARVIS_WORKFLOW_DATA_DIR;
  else process.env.JARVIS_WORKFLOW_DATA_DIR = previousDataDir;
  rmSync(tmp, { recursive: true, force: true });
});

const acquire = (runId: string) => runtime!.acquire({ runId, projectId: DEFAULT_IDS.project, flowId: "flow-a" });
const call = (handle: EngineHandle, path: string, init: RequestInit = {}) =>
  fetch(`${api.baseUrl}${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${handle.engineToken}` } });

describe("a parked warm engine", () => {
  test("its token is refused once it is parked, except for its run's own log upload; the next run's token works", async () => {
    const first = await acquire("run-1");
    expect((await call(first, "/v1/store-entries?key=k")).status).toBe(404);
    await first.release();
    // Parked, same process and sandbox: the finished run's token reaches nothing.
    const parked = await call(first, "/v1/store-entries?key=k");
    expect(parked.status).toBe(401);
    expect(await parked.json()).toMatchObject({ error: "sandbox parked" });
    expect((await call(first, "/v1/store-entries", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "k", value: 1 }) })).status).toBe(401);
    // A late execution-state backup of that run still lands, once: piece code
    // left running cannot keep rewriting the state a RESUME restores from.
    expect((await call(first, "/v1/logs/run-1", { method: "PUT", body: "x" })).status).toBe(200);
    expect((await call(first, "/v1/logs/run-1", { method: "PUT", body: "forged" })).status).toBe(401);
    // Rebound to the next run: its token works, the old one stays refused.
    const second = await acquire("run-2");
    expect(second.sandboxId).toBe(first.sandboxId);
    expect((await call(second, "/v1/store-entries?key=k")).status).toBe(404);
    expect((await call(first, "/v1/logs/run-1", { method: "PUT", body: "x" })).status).toBe(401);
    await second.release();
  });

  test("released twice, it stays parked and reusable rather than retired in its slot", async () => {
    const first = await acquire("run-1");
    await first.release();
    await first.release();
    const second = await acquire("run-2");
    expect(second.sandboxId).toBe(first.sandboxId);
    expect((await call(second, "/v1/store-entries?key=k")).status).toBe(404);
    await second.release();
  });

  test("a stale handle released again never parks the engine the next run is using", async () => {
    const first = await acquire("run-1");
    await first.release();
    const second = await acquire("run-2");
    expect(second.sandboxId).toBe(first.sandboxId);
    await first.release();
    // The second run's token still works, and a third run gets an engine of its own.
    expect((await call(second, "/v1/store-entries?key=k")).status).toBe(404);
    const third = await acquire("run-3");
    expect(third.sandboxId).not.toBe(second.sandboxId);
    await third.release();
    await second.release();
  });

  test("a parked engine taken for a run whose token cannot be minted is retired, not stranded", async () => {
    const first = await acquire("run-1");
    const { proc } = first._internals();
    await first.release();
    duringMint = async () => { throw new Error("signing failed"); };
    await expect(acquire("run-2")).rejects.toThrow("signing failed");
    expect(api.registry.get(first.sandboxId)).toBeNull();
    await proc.exited;
    expect(proc.alive()).toBe(false);
  });

  test("a rebind failing on an engine that exited meanwhile signals nothing through the dead handle", async () => {
    const first = await acquire("run-1");
    const { proc } = first._internals();
    const signalsAfterExit: string[] = [];
    const kill = proc.kill;
    proc.kill = (signal) => {
      if (!proc.alive()) signalsAfterExit.push(String(signal));
      return kill(signal);
    };
    await first.release();
    // Between the pool's alive check and its rebind: the engine dies and
    // its sandbox is revoked out of band, so the rebind throws.
    duringMint = async () => {
      proc.child.kill("SIGKILL");
      await proc.exited;
      api.registry.terminate(first.sandboxId);
    };
    const next = await acquire("run-2");
    expect(next.sandboxId).not.toBe(first.sandboxId);
    expect(signalsAfterExit).toEqual([]);
    expect(api.registry.get(first.sandboxId)).toBeNull();
    await next.release();
  });

  test("revoking CODE steps for its flow retires it; a revoke for another flow does not (#1426)", async () => {
    const first = await acquire("run-1");
    const { proc } = first._internals();
    await first.release();
    signalCodeStepsRevoked("flow-b");
    expect(proc.alive()).toBe(true);
    expect(api.registry.get(first.sandboxId)).not.toBeNull();
    signalCodeStepsRevoked("flow-a");
    expect(api.registry.get(first.sandboxId)).toBeNull();
    await proc.exited;
    expect(proc.alive()).toBe(false);
    // The next run of the flow gets an engine of its own.
    const next = await acquire("run-2");
    expect(next.sandboxId).not.toBe(first.sandboxId);
    await next.release();
  });
});
