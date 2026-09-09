/**
 * Unit tests for the engine bundle builder.
 *
 * These cover the pure helpers (deterministic hash, package.json synthesis).
 * The actual esbuild + bun install path is exercised by `scripts/build-engine.ts`
 * and gated here on `JARVIS_TEST_ENGINE_BUILD=1` because it pulls ~30MB of
 * deps and takes a few seconds. CI opts in.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  buildEngineBundle,
  bundleHash,
  findCachedBundle,
  ENGINE_BUILD_PATHS,
  ENGINE_REQUEST_BASE_SHIM,
} from "./build";

describe("engine bundle build", () => {
  describe("Request base-URL shim (banner)", () => {
    /**
     * Runs the shim in a child bun process, because it replaces a global and
     * the test runner has to keep its own.
     */
    const inChild = async (body: string): Promise<string> => {
      const proc = Bun.spawn(["bun", "-e", `${ENGINE_REQUEST_BASE_SHIM}\n${body}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      return (out + err).trim();
    };

    test("an empty URL resolves instead of throwing, which is what a browser does", async () => {
      // The exact probe abortcontroller-polyfill runs at module load, reached
      // through the airtable SDK. Unpatched, Bun answers
      // `Failed to construct 'Request': url is required` and the piece import
      // dies before any of our code runs.
      expect(await inChild(`console.log("signal" in new Request(""))`)).toBe("true");
    });

    test("a URL that already works is passed through untouched", async () => {
      // The shim must be strictly additive: only inputs that would have THROWN
      // are resolved, so nothing that builds a Request today changes.
      expect(await inChild(`console.log(new Request("https://example.test/x?a=1").url)`)).toBe(
        "https://example.test/x?a=1",
      );
    });

    test("instanceof still recognises Requests built by fetch internals", async () => {
      // Subclassing would otherwise make `nativeRequest instanceof Request`
      // false, which is a subtle way to break piece code that type-checks.
      expect(
        await inChild(`
          const native = Reflect.construct(Object.getPrototypeOf(Request), ["https://example.test/"]);
          console.log(native instanceof Request);
        `),
      ).toBe("true");
    });

    test("the shim is part of the bundle cache key", () => {
      // A banner that does not invalidate the hash is served stale from every
      // host that already has a bundle -- the same trap PATCHED_VENDOR_SOURCES
      // exists to close, and the reason that list carries so many comments.
      const src = readFileSync(resolve(import.meta.dir, "build.ts"), "utf8");
      const hashBody = src.slice(src.indexOf("export function bundleHash"));
      expect(hashBody.slice(0, hashBody.indexOf("\n}")).includes("ENGINE_REQUEST_BASE_SHIM")).toBe(
        true,
      );
    });
  });

  test("staging dir lives outside the repo", () => {
    expect(ENGINE_BUILD_PATHS.STAGING_DIR.startsWith(ENGINE_BUILD_PATHS.REPO_ROOT)).toBe(false);
    expect(ENGINE_BUILD_PATHS.BUNDLE_ROOT.startsWith(ENGINE_BUILD_PATHS.REPO_ROOT)).toBe(false);
  });

  describe("shared bundle root (JARVIS_ENGINE_CACHE_ROOT)", () => {
    afterEach(() => {
      delete process.env.JARVIS_ENGINE_CACHE_ROOT;
    });

    test("a prebuilt shared bundle is found WITHOUT any staging dir precondition", async () => {
      // Multi-tenant hosting seeds the bundle read-only under the shared
      // root; discovery must not require the per-user 47MB staging install.
      const root = resolve(tmpdir(), `shared-engine-${Date.now()}`);
      const hash = bundleHash();
      const bundleDir = resolve(root, hash);
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(resolve(bundleDir, "main.js"), "// prebuilt");
      try {
        process.env.JARVIS_ENGINE_CACHE_ROOT = root;
        const found = findCachedBundle();
        expect(found?.hash).toBe(hash);
        expect(found?.bundlePath).toBe(resolve(bundleDir, "main.js"));
        // buildEngineBundle short-circuits on it too (no staging install).
        const built = await buildEngineBundle();
        expect(built.bundlePath).toBe(resolve(bundleDir, "main.js"));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("a shared root with no matching hash falls through to the per-user cache path", () => {
      const root = resolve(tmpdir(), `shared-engine-miss-${Date.now()}`);
      mkdirSync(root, { recursive: true });
      try {
        process.env.JARVIS_ENGINE_CACHE_ROOT = root;
        const found = findCachedBundle();
        // Either the developer machine has a warm per-user cache (found from
        // BUNDLE_ROOT) or nothing at all — never a hit under the shared root.
        if (found) {
          expect(found.bundlePath.startsWith(root)).toBe(false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
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
