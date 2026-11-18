#!/usr/bin/env bun
/**
 * Build the workflow engine's sandbox launcher (#1154, sandbox-launcher/)
 * into sandbox-launcher/dist/jarvis-sandbox-linux-<arch>, where the daemon
 * looks for it (src/workflows/runner/engine-runtime/sandbox.ts).
 *
 *   bun run build:sandbox          this machine's architecture
 *   bun run build:sandbox --all    linux x64 and arm64 (the release)
 *
 * Needs Go. A static binary (CGO_ENABLED=0), so it runs on any Linux of that
 * architecture, in any container. Without it the daemon runs engines
 * unsandboxed with a warning, or refuses under workflows.sandbox: require.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SRC = resolve(ROOT, "sandbox-launcher");
const OUT = resolve(SRC, "dist");

/** Node's architecture names (the file name) to Go's. */
const GOARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };

export function buildSandboxLauncher(arch: string, outDir: string = OUT): string {
  const goarch = GOARCH[arch];
  if (!goarch) throw new Error(`no sandbox launcher for architecture ${arch}`);
  mkdirSync(outDir, { recursive: true });
  const out = resolve(outDir, `jarvis-sandbox-linux-${arch}`);
  const built = spawnSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", out, "."], {
    cwd: SRC,
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: goarch, GOFLAGS: "-mod=readonly" },
  });
  if (built.error) throw new Error(`go build failed to start (is Go installed?): ${built.error.message}`);
  if (built.status !== 0) throw new Error(`go build exited ${built.status}`);
  return out;
}

if (import.meta.main) {
  const arches = process.argv.includes("--all") ? Object.keys(GOARCH) : [process.arch];
  for (const arch of arches) console.log(`built ${buildSandboxLauncher(arch)}`);
}
