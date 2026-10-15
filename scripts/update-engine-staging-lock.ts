#!/usr/bin/env bun
/**
 * Regenerate `src/workflows/runner/engine-runtime/engine-staging.lock`, the
 * committed lockfile the engine's staging install is held to (#836).
 *
 * Run after an upstream sync changes the vendored manifests, or a
 * SECURITY_FLOOR entry changes: the lockfile-consistency test fails until you
 * do. It resolves the synthesized staging package.json afresh, so EVERY
 * floating range moves to its newest match -- review the diff of the lockfile
 * like any dependency bump. Changing it changes `bundleHash()`, so every
 * cached engine bundle rebuilds once.
 *
 *   bun run scripts/update-engine-staging-lock.ts
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildStagingPackageJson, STAGING_INSTALL_ARGS } from "../src/workflows/runner/engine-runtime/build";
import { sanitizedEnv } from "../src/util/subprocess-env";

const target = resolve(import.meta.dir, "../src/workflows/runner/engine-runtime/engine-staging.lock");
const dir = mkdtempSync(resolve(tmpdir(), "jarvis-staging-lock-"));
try {
  writeFileSync(resolve(dir, "package.json"), buildStagingPackageJson());
  const r = spawnSync(process.execPath, [...STAGING_INSTALL_ARGS.filter((a) => a !== "--frozen-lockfile")], { cwd: dir, stdio: "inherit", env: sanitizedEnv() });
  if (r.status !== 0) {
    console.error(`bun install exited with ${r.status}`);
    process.exit(1);
  }
  copyFileSync(resolve(dir, "bun.lock"), target);
  console.error(`wrote ${target}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
