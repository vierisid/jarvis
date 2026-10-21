/**
 * #864: the daemon's `bun install` spawns run the Bun that runs the daemon
 * (process.execPath), never the first `bun` on PATH.
 *
 * A fake `bun` that records being run goes first on PATH, and each install
 * site runs for real in a dir whose one dependency is a local `file:` package
 * (so the real Bun needs no registry, and its install is visible). The control
 * proves the fake IS what a bare "bun" resolves to under the same PATH, so its
 * silence below means it was bypassed, not unreachable.
 *
 * POSIX-only: the fake is a `#!/bin/sh` script.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUN_INSTALL_ARGS } from "../util/sanitized-install";
import { sanitizedEnv } from "../util/subprocess-env";
import { runPiecesBunInstall } from "./pieces-library/installer";
import { bunStagingInstall } from "./runner/engine-runtime/build";
import { bunInstall } from "./runner/engine-runtime/code-materialize";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A fake `bun` first on PATH for the duration of `run`; reports whether it ran. */
async function withFakeBunOnPath(run: (dir: string) => Promise<void>): Promise<{ fakeRan: boolean; dir: string }> {
  const root = mkdtempSync(join(tmpdir(), "jarvis-own-bun-"));
  roots.push(root);
  const bin = join(root, "bin");
  const dir = join(root, "work");
  mkdirSync(bin);
  mkdirSync(dir);
  const marker = join(root, "fake-bun-ran");
  writeFileSync(join(bin, "bun"), `#!/bin/sh\ntouch "${marker}"\nexit 0\n`, { mode: 0o755 });
  // One local `file:` dependency: something a real install visibly does with
  // no registry, and the fake does not.
  mkdirSync(join(root, "local-dep"));
  writeFileSync(join(root, "local-dep", "package.json"), JSON.stringify({ name: "local-dep", version: "1.0.0" }) + "\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "own-bun-probe", private: true, dependencies: { "local-dep": "file:../local-dep" } }) + "\n",
  );
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  try {
    await run(dir);
  } finally {
    process.env.PATH = savedPath;
  }
  return { fakeRan: existsSync(marker), dir };
}

describe.skipIf(process.platform === "win32")("installs run the daemon's own Bun, not one from PATH (#864)", () => {
  test("control: a bare `bun` spawned with the same PATH runs the fake", async () => {
    const { fakeRan } = await withFakeBunOnPath(
      (dir) =>
        new Promise<void>((res, rej) => {
          const child = spawn("bun", ["install"], { cwd: dir, stdio: "ignore", env: sanitizedEnv() });
          child.on("close", () => res());
          child.on("error", rej);
        }),
    );
    expect(fakeRan).toBe(true);
  });

  test("pieces-library: runPiecesBunInstall", async () => {
    const { fakeRan, dir } = await withFakeBunOnPath((d) => runPiecesBunInstall(d, "pieces"));
    expect(fakeRan).toBe(false);
    // The real Bun ran: the local dependency is installed.
    expect(existsSync(join(dir, "node_modules", "local-dep", "package.json"))).toBe(true);
  }, 60_000);

  test("engine staging: bunStagingInstall", async () => {
    const { fakeRan, dir } = await withFakeBunOnPath((d) => bunStagingInstall(d, BUN_INSTALL_ARGS));
    expect(fakeRan).toBe(false);
    expect(existsSync(join(dir, "node_modules", "local-dep", "package.json"))).toBe(true);
  }, 60_000);

  test("CODE-step dependencies: bunInstall", async () => {
    const { fakeRan, dir } = await withFakeBunOnPath((d) => bunInstall(d));
    expect(fakeRan).toBe(false);
    expect(existsSync(join(dir, "node_modules", "local-dep", "package.json"))).toBe(true);
  }, 60_000);
});
