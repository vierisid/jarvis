#!/usr/bin/env bun
/**
 * CLI: build the activepieces engine bundle.
 *
 * Usage:
 *   bun run scripts/build-engine.ts          # build (cached if up-to-date)
 *   bun run scripts/build-engine.ts --force  # rebuild even if cache is fresh
 *   bun run scripts/build-engine.ts --smoke  # build + spawn the bundle as a smoke test
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { buildEngineBundle } from "../src/workflows/runner/engine-runtime/build";

const force = process.argv.includes("--force");
const smoke = process.argv.includes("--smoke");

const start = Date.now();
const bundle = await buildEngineBundle({ force });
const elapsed = Date.now() - start;

const bundleSize = statSync(bundle.bundlePath).size;
const sizeMb = (bundleSize / 1024 / 1024).toFixed(1);

console.log(`Engine bundle: ${bundle.bundlePath}`);
console.log(`  hash:  ${bundle.hash}`);
console.log(`  size:  ${sizeMb} MB`);
console.log(`  built: ${elapsed} ms`);

if (!smoke) process.exit(0);

// Smoke test: spawn the bundle without SANDBOX_ID. main.ts gates the worker-
// socket init on SANDBOX_ID via isNil(); empty string is NOT nil and would
// cause a real WS connect attempt, so we omit the var entirely.
console.log("\nSmoke test: spawning bundle without SANDBOX_ID, expecting clean exit...");
const smokeEnv = { ...process.env };
delete smokeEnv.SANDBOX_ID;
const child = spawn(process.execPath, [bundle.bundlePath], {
  stdio: ["ignore", "pipe", "pipe"],
  env: smokeEnv,
});

let stdout = "";
let stderr = "";
child.stdout?.on("data", (d) => { stdout += d.toString(); });
child.stderr?.on("data", (d) => { stderr += d.toString(); });

const exitCode = await new Promise<number>((res, rej) => {
  const t = setTimeout(() => {
    child.kill("SIGKILL");
    rej(new Error("smoke test timed out after 5s"));
  }, 5000);
  child.on("close", (code) => { clearTimeout(t); res(code ?? -1); });
  child.on("error", (e) => { clearTimeout(t); rej(e); });
});

console.log(`  exit:   ${exitCode}`);
if (stdout.trim()) console.log(`  stdout: ${stdout.trim().slice(0, 400)}`);
if (stderr.trim()) console.log(`  stderr: ${stderr.trim().slice(0, 400)}`);

if (exitCode !== 0) {
  console.error("Smoke test FAILED: bundle did not exit cleanly without SANDBOX_ID");
  process.exit(1);
}
console.log("Smoke test PASS");
