#!/usr/bin/env bun
/**
 * Phase 2 spike: verify that Bun can spawn itself with IPC, matching the
 * pattern used by activepieces' `no-op-code-sandbox.ts` (SANDBOX_PROCESS mode).
 *
 * If this works, we never need `isolated-vm` -- we can run the engine in
 * SANDBOX_PROCESS mode and rely on OS-level process isolation, which is
 * sufficient for a personal-AI workflow runtime where the user trusts the
 * code they configure.
 *
 * Test cases:
 *   1. spawn(bun, ['-e', script]) with stdio including 'ipc'
 *   2. parent send -> child receive via process.message
 *   3. child send -> parent receive
 *   4. child exits cleanly with the expected code
 *   5. require()-ing a CJS file from the spawned child works
 *      (the engine's no-op sandbox does `require(codeFilePath)` to load user code)
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type SpikeResult = { name: string; ok: boolean; detail: string };

async function ipcRoundTrip(): Promise<SpikeResult> {
  const script = `
    process.once("message", (msg) => {
      process.send({ result: msg.x + msg.y }, () => process.exit(0));
    });
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    let got: unknown = null;
    child.on("message", (m) => { got = m; });
    child.on("close", (code) => {
      const ok = code === 0 && got !== null && (got as { result?: number }).result === 5;
      resolve({
        name: "ipc round-trip with -e",
        ok,
        detail: `exit=${code} message=${JSON.stringify(got)}`,
      });
    });
    child.on("error", (e) => {
      resolve({ name: "ipc round-trip with -e", ok: false, detail: `spawn error: ${e.message}` });
    });
    child.send({ x: 2, y: 3 });
  });
}

async function requireCjsFromChild(): Promise<SpikeResult> {
  const dir = mkdtempSync(join(tmpdir(), "bun-spike-"));
  const codeFile = join(dir, "user-code.cjs");
  writeFileSync(codeFile, `
    module.exports = {
      code: async (inputs) => ({ doubled: inputs.value * 2, ts: Date.now() }),
    };
  `);
  const runner = `
    process.once("message", async (msg) => {
      try {
        const mod = require(msg.codeFilePath);
        const result = await mod.code(msg.inputs);
        process.send({ success: true, result }, () => process.exit(0));
      } catch (e) {
        process.send({ success: false, error: String(e) }, () => process.exit(1));
      }
    });
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", runner], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    let got: { success?: boolean; result?: { doubled?: number } } | null = null;
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("message", (m) => { got = m as typeof got; });
    child.on("close", (code) => {
      rmSync(dir, { recursive: true, force: true });
      const ok = code === 0 && got?.success === true && got?.result?.doubled === 42;
      resolve({
        name: "child requires CJS module and runs user code",
        ok,
        detail: ok
          ? `exit=${code} doubled=${got?.result?.doubled}`
          : `exit=${code} got=${JSON.stringify(got)} stderr=${stderr.trim().slice(0, 200)}`,
      });
    });
    child.on("error", (e) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ name: "child requires CJS module and runs user code", ok: false, detail: `spawn error: ${e.message}` });
    });
    child.send({ codeFilePath: codeFile, inputs: { value: 21 } });
  });
}

async function uncaughtRejectionPropagates(): Promise<SpikeResult> {
  // Mirrors the no-op-code-sandbox unhandledRejection trap.
  const runner = `
    process.on("unhandledRejection", (reason) => {
      process.send({ success: false, error: String(reason) }, () => process.exit(1));
    });
    process.once("message", () => {
      Promise.reject(new Error("oops"));
    });
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", runner], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    let got: { success?: boolean; error?: string } | null = null;
    child.on("message", (m) => { got = m as typeof got; });
    child.on("close", (code) => {
      const ok = got?.success === false && (got?.error ?? "").includes("oops");
      resolve({
        name: "unhandled rejection propagates via IPC",
        ok,
        detail: `exit=${code} got=${JSON.stringify(got)}`,
      });
    });
    child.on("error", (e) => {
      resolve({ name: "unhandled rejection propagates via IPC", ok: false, detail: `spawn error: ${e.message}` });
    });
    child.send({});
  });
}

async function memoryLimitEnforced(): Promise<SpikeResult> {
  // Bun supports --max-heap-size (Node uses --max-old-space-size). This is for
  // SANDBOX_PROCESS mode where we may want to cap child memory. If neither flag
  // is honored we'll need to enforce limits another way (rlimit, container).
  // We don't fail the spike if this doesn't work -- it's informational.
  const script = `
    const arr = [];
    try {
      while (true) arr.push(new Array(1024 * 1024).fill(0));
    } catch (e) {
      process.send({ caught: true, error: String(e) }, () => process.exit(0));
    }
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--smol", "-e", script], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    let got: { caught?: boolean } | null = null;
    let killed = false;
    const timeout = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, 5000);
    child.on("message", (m) => { got = m as typeof got; });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const handled = got?.caught === true || code !== 0 || signal !== null;
      resolve({
        name: "child memory pressure terminates (informational)",
        ok: handled,
        detail: killed
          ? "child needed external SIGKILL after 5s"
          : `exit=${code} signal=${signal} got=${JSON.stringify(got)}`,
      });
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve({ name: "child memory pressure terminates (informational)", ok: false, detail: "spawn failed" });
    });
    child.send({});
  });
}

const results: SpikeResult[] = [];
results.push(await ipcRoundTrip());
results.push(await requireCjsFromChild());
results.push(await uncaughtRejectionPropagates());
results.push(await memoryLimitEnforced());

console.log("\nBun child-process IPC spike (mirrors no-op-code-sandbox.ts):\n");
for (const r of results) {
  const mark = r.ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${r.name}`);
  console.log(`         ${r.detail}`);
}

const required = results.slice(0, 3);
const allRequired = required.every((r) => r.ok);
console.log("");
if (allRequired) {
  console.log("Result: SANDBOX_PROCESS mode is viable under Bun. We can avoid `isolated-vm`.");
  process.exit(0);
} else {
  console.log("Result: at least one required test failed. SANDBOX_PROCESS may need a Node sub-binary fallback.");
  process.exit(1);
}
