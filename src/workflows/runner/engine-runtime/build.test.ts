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
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  buildEngineBundle,
  bundleHash,
  findCachedBundle,
  ENGINE_BUILD_PATHS,
  ENGINE_ESBUILD_CONFIG,
  ENGINE_REQUEST_BASE_SHIM,
  PATCHED_VENDOR_SOURCES,
} from "./build";
import { ENGINE_LIFECYCLE_SHIM, ENGINE_OWNER_PID_ENV } from "./engine-lifecycle";

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

    test("the banner is WIRED IN, not merely defined", () => {
      // The previous version of this test grepped bundleHash's source for the
      // constant's name. It passed with the hashing removed as long as the
      // name survived in a comment, and it could not see the banner being
      // unwired from the esbuild call at all -- which is the failure that
      // matters, because it changes the bytes the engine runs.
      expect(ENGINE_ESBUILD_CONFIG.banner.js).toContain(ENGINE_REQUEST_BASE_SHIM);
    });

    test("the lifecycle shim is wired in, and FIRST", () => {
      // Order is load-bearing, not cosmetic: the shim's SIGTERM handler has to
      // be registered before upstream's run-progress listener so the flush
      // still runs and then the process actually exits (#491). Unwire this and
      // the engine goes back to ignoring SIGTERM, silently.
      const js = ENGINE_ESBUILD_CONFIG.banner.js;
      expect(js).toContain(ENGINE_LIFECYCLE_SHIM);
      expect(js.indexOf(ENGINE_LIFECYCLE_SHIM)).toBeLessThan(
        js.indexOf(ENGINE_REQUEST_BASE_SHIM),
      );
      // It must also carry the pieces the reaper and the runtime rely on.
      expect(js).toContain("SIGTERM");
      expect(js).toContain(ENGINE_OWNER_PID_ENV);
    });

    test("removing the lifecycle shim would invalidate every cached bundle", () => {
      // The hash has to move when the shim does, or hosts keep serving an
      // engine that ignores SIGTERM from a cache whose name still looks right.
      const digest = (cfg: unknown) =>
        createHash("sha256").update(JSON.stringify(cfg)).digest("hex");
      const withShim = { ...ENGINE_ESBUILD_CONFIG, banner: ENGINE_ESBUILD_CONFIG.banner };
      const withoutShim = {
        ...ENGINE_ESBUILD_CONFIG,
        banner: { js: ENGINE_REQUEST_BASE_SHIM },
      };
      expect(digest(withShim)).not.toBe(digest(withoutShim));
    });

    test("the build config is part of the bundle cache key", () => {
      // A config change that does not move the hash is served stale from every
      // host that already has a bundle -- the same trap PATCHED_VENDOR_SOURCES
      // exists to close. Asserted on the VALUE: two configs differing only in
      // the banner must not hash alike.
      const digest = (cfg: unknown) =>
        createHash("sha256").update(JSON.stringify(cfg)).digest("hex");
      const withBanner = { ...ENGINE_ESBUILD_CONFIG, banner: ENGINE_ESBUILD_CONFIG.banner };
      const withoutBanner = { ...ENGINE_ESBUILD_CONFIG, banner: undefined };
      expect(digest(withBanner)).not.toBe(digest(withoutBanner));
      // And the real key actually consumes it.
      const src = readFileSync(resolve(import.meta.dir, "build.ts"), "utf8");
      const body = src.slice(src.indexOf("export function bundleHash"));
      expect(body.slice(0, body.indexOf("\n}"))).toContain("ENGINE_ESBUILD_CONFIG");
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

    /** A shared root the way a host actually builds one: bundle + manifest. */
    const seedSharedBundle = (root: string, body = "// prebuilt"): { hash: string; bundleDir: string } => {
      const hash = bundleHash();
      const bundleDir = resolve(root, hash);
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(resolve(bundleDir, "main.js"), body);
      writeFileSync(resolve(bundleDir, "main.js.sha256"),
        createHash("sha256").update(body).digest("hex") + "\n");
      return { hash, bundleDir };
    };

    test("a prebuilt shared bundle is found WITHOUT any staging dir precondition", async () => {
      // Multi-tenant hosting seeds the bundle read-only under the shared
      // root; discovery must not require the per-user 47MB staging install.
      //
      // The fixture carries `main.js.sha256` because a shared root without one
      // is no longer a shared root (#624) -- both producers in this tree write
      // it unconditionally (Dockerfile, scripts/build-shared-runtime.ts). The
      // property THIS test pins is unchanged: no staging dir is created and
      // `buildEngineBundle()` still short-circuits. `findSharedBundle requires
      // the manifest` below holds the old fixture shape and asserts the
      // opposite outcome, so neither test can pass vacuously.
      const root = resolve(tmpdir(), `shared-engine-${Date.now()}`);
      const { hash, bundleDir } = seedSharedBundle(root);
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

    /**
     * #624. The shared root is a HOST-owned tree, read-only to the tenant and
     * shared between tenants, and `main.js` out of it is spawned as the
     * workflow engine with the daemon's authority. Verification used to run
     * only `if (existsSync(manifestPath))`, so deleting the manifest was
     * strictly cheaper than forging the digest -- the check was disabled by
     * removing the thing that enabled it.
     *
     * All three refusal shapes now miss, and all three are logged: a silent
     * degradation in a hosted container costs every tenant a ~47 MB staging
     * install and conceals why.
     */
    describe("the shared bundle is never executed unverified (#624)", () => {
      const withWarnings = <T,>(body: () => T): { value: T; warnings: string[] } => {
        const warnings: string[] = [];
        const original = console.warn;
        console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
        try {
          return { value: body(), warnings };
        } finally {
          console.warn = original;
        }
      };

      /**
       * A refusal resolves to NOTHING, not to the per-user copy.
       *
       * `toBe(null)` and not "a path outside the shared root": answering a
       * failed integrity check by adopting `<BUNDLE_ROOT>/<hash>/main.js` would
       * degrade from an unverified HOST-owned bundle to an unverified
       * TENANT-WRITABLE one, which is the wrong direction in the multi-tenant
       * shape this root exists for -- and `bundleHash()` is computable by
       * anyone who can read the install, so the path is predictable. The
       * assertion is also non-vacuous precisely because a developer machine
       * usually HAS a warm per-user cache: before this change these calls
       * returned it.
       */
      const refusedResolvesToNothing = (seed: (bundleDir: string) => void, reason: string) => {
        const root = resolve(tmpdir(), `shared-engine-${reason}-${Date.now()}`);
        const bundleDir = resolve(root, bundleHash());
        mkdirSync(bundleDir, { recursive: true });
        seed(bundleDir);
        try {
          process.env.JARVIS_ENGINE_CACHE_ROOT = root;
          const { value: found, warnings } = withWarnings(() => findCachedBundle());
          expect(found).toBe(null);
          expect(warnings.length).toBe(1);
          expect(warnings[0]).toContain(`reason=${reason}`);
          expect(warnings[0]).toContain(root);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      };

      test("an absent manifest is a REFUSAL, not a pass", () => {
        refusedResolvesToNothing(
          (dir) => writeFileSync(resolve(dir, "main.js"), "// unverified"),
          "manifest_absent");
      });

      test("a manifest that does not match the bytes is a REFUSAL, and says so", () => {
        // Never exercised by this suite before: the old fixture wrote no
        // manifest at all, so the mismatch branch had no coverage either.
        refusedResolvesToNothing((dir) => {
          writeFileSync(resolve(dir, "main.js"), "// swapped after the manifest was written");
          writeFileSync(resolve(dir, "main.js.sha256"),
            createHash("sha256").update("// what the host built").digest("hex") + "\n");
        }, "digest_mismatch");
      });

      test("a manifest naming a digest of the wrong LENGTH does not pass by prefix", () => {
        // A truncated manifest (a half-written file, a bad layer pull) must not
        // satisfy the comparison. Full-string equality is the property; this
        // pins it so a future `startsWith`/`includes` cannot creep in.
        const body = "// prebuilt";
        refusedResolvesToNothing((dir) => {
          writeFileSync(resolve(dir, "main.js"), body);
          writeFileSync(resolve(dir, "main.js.sha256"),
            createHash("sha256").update(body).digest("hex").slice(0, 32) + "\n");
        }, "digest_mismatch");
      });

      test("a refusal warns every time, so a recurrence is not swallowed", () => {
        // A memo keyed on path+reason would print once and then hide exactly
        // the two cases an operator needs: the same failure recurring after a
        // repair, and a tree swapped under a long-lived daemon.
        const root = resolve(tmpdir(), `shared-engine-repeat-${Date.now()}`);
        const bundleDir = resolve(root, bundleHash());
        mkdirSync(bundleDir, { recursive: true });
        writeFileSync(resolve(bundleDir, "main.js"), "// unverified");
        try {
          process.env.JARVIS_ENGINE_CACHE_ROOT = root;
          const { warnings } = withWarnings(() => {
            findCachedBundle(); findCachedBundle(); findCachedBundle();
          });
          expect(warnings.length).toBe(3);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });

      test("a manifest's contents never reach the log line verbatim", () => {
        // The premise of the whole check is that something may have written
        // into this tree, and the refusal is logged. A manifest holding a
        // newline and a forged line must not be able to print one.
        const root = resolve(tmpdir(), `shared-engine-injection-${Date.now()}`);
        const bundleDir = resolve(root, bundleHash());
        mkdirSync(bundleDir, { recursive: true });
        writeFileSync(resolve(bundleDir, "main.js"), "// prebuilt");
        writeFileSync(resolve(bundleDir, "main.js.sha256"),
          "deadbeef\n[engine] shared bundle verified, all good\n");
        try {
          process.env.JARVIS_ENGINE_CACHE_ROOT = root;
          const { value: found, warnings } = withWarnings(() => findCachedBundle());
          if (found) expect(found.bundlePath.startsWith(root)).toBe(false);
          expect(warnings.length).toBe(1);
          expect(warnings[0]).not.toContain("all good");
          expect(warnings[0]).not.toContain("\n");
          expect(warnings[0]).toContain("<not a sha256 digest>");
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });

      test("the per-user cache still needs no manifest", () => {
        // Same uid, locally built: BUNDLE_ROOT is explicitly out of scope, and
        // the fix must not have made the local fallback require a digest it
        // never writes. `buildEngineBundle` writes main.js + main.js.meta.json
        // and no .sha256, so asserting the absence of a manifest writer is the
        // check that keeps this honest.
        const localBuilder = readFileSync(resolve(import.meta.dir, "build.ts"), "utf8");
        expect(localBuilder.includes('bundlePath + ".meta.json"')).toBe(true);
        const manifestWrites = localBuilder.match(/writeFileSync\([^)]*\.sha256/gu);
        expect(manifestWrites).toBe(null);
      });
    });
  });

  test("every daemon source a patched vendor file imports is itself in the bundle hash", () => {
    // A patched vendor file that imports a daemon module compiles that module
    // into the bundle, so the module must be in PATCHED_VENDOR_SOURCES too or
    // editing it serves a stale engine. #512 added one such import
    // (no-op-code-sandbox -> util/subprocess-env); this catches the next.
    const registered = new Set(PATCHED_VENDOR_SOURCES.map((rel) => resolve(ENGINE_BUILD_PATHS.VENDOR_PACKAGES, rel)));
    const missing: string[] = [];
    for (const file of registered) {
      const source = readFileSync(file, "utf8");
      // Static imports and re-exports, side-effect imports, require() and
      // import(). `import type` / `export type` are erased before bundling, so
      // they compile nothing in.
      const specs = [
        ...source.matchAll(/^(?:import|export)\s+(?!type\s)(?:(?!\b(?:import|export)\b)[^;])*?\bfrom\s+['"](\.[^'"]+)['"]/gm),
        ...source.matchAll(/^import\s+['"](\.[^'"]+)['"]/gm),
        ...source.matchAll(/\b(?:require|import)\(\s*['"](\.[^'"]+)['"]\s*\)/g),
      ];
      for (const m of specs) {
        let target = resolve(dirname(file), m[1]!);
        if (!target.endsWith(".ts")) target += ".ts";
        if (target.startsWith(ENGINE_BUILD_PATHS.VENDOR_PACKAGES + "/")) continue;
        if (!registered.has(target)) missing.push(`${file} -> ${target}`);
      }
    }
    expect(missing).toEqual([]);
    expect(registered.has(resolve(ENGINE_BUILD_PATHS.REPO_ROOT, "src/util/subprocess-env.ts"))).toBe(true);
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
