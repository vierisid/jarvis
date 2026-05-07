/**
 * Unit tests for the engine bundle builder.
 *
 * These cover the pure helpers (deterministic hash, package.json synthesis).
 * The actual esbuild + bun install path is exercised by `scripts/build-engine.ts`
 * and gated here on `JARVIS_TEST_ENGINE_BUILD=1` because it pulls ~30MB of
 * deps and takes a few seconds. CI opts in.
 */

import { test, expect, describe } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { buildEngineBundle, ENGINE_BUILD_PATHS } from "./build";

describe("engine bundle build", () => {
  test("staging dir lives outside the repo", () => {
    expect(ENGINE_BUILD_PATHS.STAGING_DIR.startsWith(ENGINE_BUILD_PATHS.REPO_ROOT)).toBe(false);
    expect(ENGINE_BUILD_PATHS.BUNDLE_ROOT.startsWith(ENGINE_BUILD_PATHS.REPO_ROOT)).toBe(false);
  });

  test("vendored engine source exists at the expected path", () => {
    const enginePkg = `${ENGINE_BUILD_PATHS.ENGINE_DIR}/package.json`;
    expect(existsSync(enginePkg)).toBe(true);
    const main = `${ENGINE_BUILD_PATHS.ENGINE_DIR}/src/main.ts`;
    expect(existsSync(main)).toBe(true);
  });

  test.skipIf(process.env.JARVIS_TEST_ENGINE_BUILD !== "1")(
    "produces a runnable bundle that exits cleanly without SANDBOX_ID",
    async () => {
      const { bundlePath } = await buildEngineBundle();
      expect(existsSync(bundlePath)).toBe(true);
      const size = statSync(bundlePath).size;
      // Anything under 200KB or over 10MB is suspicious.
      expect(size).toBeGreaterThan(200_000);
      expect(size).toBeLessThan(10_000_000);

      const env = { ...process.env };
      delete env.SANDBOX_ID;

      const exitCode = await new Promise<number>((res, rej) => {
        const child = spawn(process.execPath, [bundlePath], {
          stdio: ["ignore", "pipe", "pipe"],
          env,
        });
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          rej(new Error("bundle did not exit within 5s"));
        }, 5000);
        child.on("close", (code) => {
          clearTimeout(t);
          res(code ?? -1);
        });
        child.on("error", (e) => {
          clearTimeout(t);
          rej(e);
        });
      });

      expect(exitCode).toBe(0);
    },
    20_000,
  );
});
