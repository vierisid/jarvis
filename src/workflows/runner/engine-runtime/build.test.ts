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
  buildStagingPackageJson,
  bundleHash,
  findCachedBundle,
  ENGINE_BUILD_PATHS,
  ENGINE_ESBUILD_CONFIG,
  ENGINE_REQUEST_BASE_SHIM,
  PATCHED_VENDOR_SOURCES,
} from "./build";
import { ENGINE_LIFECYCLE_SHIM, ENGINE_OWNER_PID_ENV } from "./engine-lifecycle";
import { BundleIntegrityError, __resetBundlePinsForTest } from "./bundle-integrity";
import { spawnEngine } from "./spawn";

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
      // Unconditional since #673: with `bundleRoot` pointing at a fixture the
      // answer no longer depends on whether the developer machine happens to
      // have a warm `~/.jarvis/cache/engine`, which is what used to force an
      // `if (found)` around the only assertion.
      const root = resolve(tmpdir(), `shared-engine-miss-${Date.now()}`);
      const bundleRoot = resolve(tmpdir(), `user-engine-miss-${Date.now()}`);
      try {
        mkdirSync(root, { recursive: true });
        mkdirSync(resolve(bundleRoot, bundleHash()), { recursive: true });
        process.env.JARVIS_ENGINE_CACHE_ROOT = root;
        // Nothing per-user either: nothing at all.
        expect(findCachedBundle({ bundleRoot })).toBe(null);
        // A per-user build: the miss falls through to it.
        writeFileSync(resolve(bundleRoot, bundleHash(), "main.js"), "// built locally");
        expect(findCachedBundle({ bundleRoot })?.bundlePath).toBe(resolve(bundleRoot, bundleHash(), "main.js"));
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(bundleRoot, { recursive: true, force: true });
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

      /**
       * The two shapes a publisher actually writes both verify.
       *
       * Reviewed as the likeliest operational failure of #624: the comparison
       * required bare lowercase hex, so `sha256sum main.js > main.js.sha256` --
       * the obvious command, and the one anything publishing a shared root by
       * rsync or tarball will use -- produced `<hash>  main.js` and refused with
       * `manifest says <not a sha256 digest>`. An operator reads that as
       * corruption, not as a format mistake, and since #624 the consequence is
       * every tenant on the host losing its shared bundle at once.
       *
       * These accept nothing a strict reading would not: the first
       * whitespace-delimited token is compared full-string against the real
       * hash, and hex is case-insensitive by definition.
       */
      test("a manifest in sha256sum's own two-field form verifies (#624)", () => {
        const body = "// prebuilt";
        const root = resolve(tmpdir(), `shared-engine-twofield-${Date.now()}`);
        const bundleDir = resolve(root, bundleHash());
        mkdirSync(bundleDir, { recursive: true });
        writeFileSync(resolve(bundleDir, "main.js"), body);
        writeFileSync(resolve(bundleDir, "main.js.sha256"),
          `${createHash("sha256").update(body).digest("hex")}  main.js\n`);
        try {
          process.env.JARVIS_ENGINE_CACHE_ROOT = root;
          const { value: found, warnings } = withWarnings(() => findCachedBundle());
          expect(warnings).toEqual([]);
          expect(found?.bundlePath).toBe(resolve(bundleDir, "main.js"));
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });

      test("an UPPERCASE hex digest verifies, being the same number (#624)", () => {
        const body = "// prebuilt";
        const root = resolve(tmpdir(), `shared-engine-upper-${Date.now()}`);
        const bundleDir = resolve(root, bundleHash());
        mkdirSync(bundleDir, { recursive: true });
        writeFileSync(resolve(bundleDir, "main.js"), body);
        writeFileSync(resolve(bundleDir, "main.js.sha256"),
          createHash("sha256").update(body).digest("hex").toUpperCase() + "\n");
        try {
          process.env.JARVIS_ENGINE_CACHE_ROOT = root;
          const { value: found, warnings } = withWarnings(() => findCachedBundle());
          expect(warnings).toEqual([]);
          expect(found?.bundlePath).toBe(resolve(bundleDir, "main.js"));
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });

      test("the leniency stops at the format: a WRONG digest in the two-field form still refuses", () => {
        // The direction that must not have been widened. Taking the first token
        // must not have turned into taking a prefix or a substring.
        refusedResolvesToNothing((dir) => {
          writeFileSync(resolve(dir, "main.js"), "// swapped");
          writeFileSync(resolve(dir, "main.js.sha256"),
            `${createHash("sha256").update("// what the host built").digest("hex")}  main.js\n`);
        }, "digest_mismatch");
      });

      test("a manifest naming TWO digests refuses, rather than matching on the first that fits", () => {
        // `cat a.sha256 b.sha256 > main.js.sha256` is a plausible slip, and the
        // whitespace split must not turn it into "any of these will do".
        const body = "// prebuilt";
        refusedResolvesToNothing((dir) => {
          writeFileSync(resolve(dir, "main.js"), body);
          writeFileSync(resolve(dir, "main.js.sha256"),
            createHash("sha256").update("// something else").digest("hex") + "\n"
            + createHash("sha256").update(body).digest("hex") + "\n");
        }, "digest_mismatch");
      });

      test("an empty manifest refuses, and does not read as an empty digest matching nothing", () => {
        // A half-written file: zero bytes, or whitespace only. The split yields
        // "" and the comparison must refuse rather than throw.
        for (const contents of ["", "\n", "   \t\n  "]) {
          const root = resolve(tmpdir(), `shared-engine-empty-${Date.now()}-${contents.length}`);
          const bundleDir = resolve(root, bundleHash());
          mkdirSync(bundleDir, { recursive: true });
          writeFileSync(resolve(bundleDir, "main.js"), "// prebuilt");
          writeFileSync(resolve(bundleDir, "main.js.sha256"), contents);
          try {
            process.env.JARVIS_ENGINE_CACHE_ROOT = root;
            const { value: found, warnings } = withWarnings(() => findCachedBundle());
            expect(found).toBe(null);
            expect(warnings[0]).toContain("reason=digest_mismatch");
            expect(warnings[0]).toContain("<not a sha256 digest>");
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        }
      });

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
          // `toBe(null)`, not a conditional: a refusal always resolves to
          // nothing, so `if (found)` made this assertion dead. The same shape is
          // justified in the pre-existing "no matching hash" test above, where a
          // developer machine may genuinely have a warm per-user cache; here the
          // refusal is the whole point.
          expect(found).toBe(null);
          expect(warnings.length).toBe(1);
          expect(warnings[0]).not.toContain("all good");
          expect(warnings[0]).not.toContain("\n");
          expect(warnings[0]).toContain("<not a sha256 digest>");
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });

      test("the per-user cache still needs no manifest", () => {
        // Same uid, locally built: BUNDLE_ROOT is explicitly out of #624's
        // scope, and `buildEngineBundle` writes main.js + main.js.meta.json and
        // no .sha256. So the property is that `findCachedBundle()` still RETURNS
        // a per-user bundle with no manifest beside it -- the one an over-broad
        // extension of the shared-root check to every root would break.
        //
        // BEHAVIOURAL since #673. This used to assert on build.ts's SOURCE TEXT
        // (no `.sha256` writer), because BUNDLE_ROOT had no test seam and the
        // alternative was seeding the developer's real cache. That proxy could
        // not see the failure that matters: a manifest REQUIREMENT added to the
        // per-user branch, with no writer anywhere, passed it. `bundleRoot`
        // mirrors `sharedRoot`, so the claim is now tested as stated.
        const bundleRoot = resolve(tmpdir(), `user-engine-nomanifest-${Date.now()}`);
        const bundleDir = resolve(bundleRoot, bundleHash());
        try {
          // Exactly what `buildEngineBundle` leaves behind: no main.js.sha256.
          mkdirSync(bundleDir, { recursive: true });
          writeFileSync(resolve(bundleDir, "main.js"), "// built locally");
          writeFileSync(resolve(bundleDir, "main.js.meta.json"), "{}");
          // No shared root at all, so only the per-user branch can answer.
          const { value: found, warnings } = withWarnings(() => findCachedBundle({ sharedRoot: null, bundleRoot }));
          expect(found).toEqual({ bundlePath: resolve(bundleDir, "main.js"), hash: bundleHash() });
          // Not refused quietly and not refused loudly either.
          expect(warnings).toEqual([]);
        } finally {
          rmSync(bundleRoot, { recursive: true, force: true });
        }
      });

      /**
       * Both in-tree producers must keep writing the manifest, because #624
       * made it load-bearing for THEM and not only for an outside host.
       *
       * The Docker image sets `JARVIS_ENGINE_CACHE_ROOT=/app/engine-cache`, so a
       * Dockerfile that staged `main.js` without its digest would now refuse its
       * own prebuild: the container would fall back to a ~47 MB staging install
       * on a layer it cannot write, and the piece path has no fallback at all
       * (#613). The image already catches that -- the post-`USER jarvis`
       * assertion requires `findCachedBundle()` to resolve from under
       * `/app/engine-cache` -- but that verdict costs a full image build and
       * arrives only on a CI leg with a `paths:` filter. These two assertions
       * are the same claim at `bun test` speed.
       *
       * Asserted as "the producer writes a digest beside the bundle it stages",
       * not by pattern-matching one command: `sha256sum` could legitimately
       * become `openssl dgst`. What may not change is that a staged bundle
       * leaves without a manifest.
       */
      test("both shipped producers write the manifest beside the bundle (#624)", () => {
        const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..");
        const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile"), "utf8");
        // Staging line and digest line, in that order, in the same RUN.
        expect(dockerfile).toContain('/out/engine/$hash/main.js"');
        expect(dockerfile).toMatch(/>\s*"\/out\/engine\/\$hash\/main\.js\.sha256"/u);
        expect(dockerfile.indexOf("main.js.sha256")).toBeGreaterThan(
          dockerfile.indexOf('cp "$bundle/main.js"'));
        // And the image is a shared-root consumer, which is what makes the
        // above load-bearing rather than decorative.
        expect(dockerfile).toContain("ENV JARVIS_ENGINE_CACHE_ROOT=/app/engine-cache");

        const sharedRuntime = readFileSync(resolve(repoRoot, "scripts", "build-shared-runtime.ts"), "utf8");
        expect(sharedRuntime).toContain('"main.js.sha256"');
        expect(sharedRuntime).toMatch(/createHash\("sha256"\)/u);
      });
    });
  });

  /**
   * #761. `buildEngineBundle` had no seam -- BUNDLE_ROOT and STAGING_DIR were
   * module constants -- so none of its own branches could be asserted without
   * building into the developer's real cache. With `bundleRoot` and a staging
   * dir seeded with a stand-in esbuild, each branch is held on behaviour: the
   * stand-in records every build, so "built" and "adopted" are told apart by
   * whether it ran, not by guessing from file contents.
   */
  describe("buildEngineBundle's own branches (#761)", () => {
    const made: string[] = [];
    afterEach(() => {
      __resetBundlePinsForTest();
      for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
    });
    const tmp = (tag: string): string => {
      const d = resolve(tmpdir(), `jarvis-761-${tag}-${process.pid}-${Date.now()}-${made.length}`);
      mkdirSync(d, { recursive: true });
      made.push(d);
      return d;
    };

    const BUILT = "// built by the stand-in esbuild\n";

    /**
     * A staging dir `ensureStagingInstalled` accepts as already installed --
     * its package.json is exactly the one it would write, and node_modules
     * exists -- so no `bun install` runs. Its esbuild writes BUILT to the
     * outfile and logs the call.
     */
    const seededStaging = (): { stagingDir: string; builds: () => number } => {
      const stagingDir = tmp("staging");
      const log = resolve(stagingDir, "builds.log");
      writeFileSync(log, "");
      writeFileSync(resolve(stagingDir, "package.json"), buildStagingPackageJson());
      const lib = resolve(stagingDir, "node_modules", "esbuild", "lib");
      mkdirSync(lib, { recursive: true });
      writeFileSync(resolve(lib, "main.js"),
        `const fs = require("fs");\n` +
        `exports.build = async (o) => {\n` +
        `  fs.appendFileSync(${JSON.stringify(log)}, o.outfile + "\\n");\n` +
        `  fs.writeFileSync(o.outfile, ${JSON.stringify(BUILT)});\n` +
        `  return { metafile: { inputs: {}, outputs: { [o.outfile]: { imports: [] } } } };\n` +
        `};\n`);
      return { stagingDir, builds: () => readFileSync(log, "utf8").split("\n").filter(Boolean).length };
    };

    /** A shared root whose bundle is REFUSED: main.js with no manifest. */
    const refusedSharedRoot = (): string => {
      const root = tmp("shared-refused");
      mkdirSync(resolve(root, bundleHash()), { recursive: true });
      writeFileSync(resolve(root, bundleHash(), "main.js"), "// published without its manifest\n");
      return root;
    };

    const quietly = async <T,>(body: () => Promise<T>): Promise<{ value: T; warnings: string[] }> => {
      const warnings: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
      try {
        return { value: await body(), warnings };
      } finally {
        console.warn = original;
      }
    };

    /** `/bin/true` as the runtime: a spawn that is real but runs nothing from the bundle. */
    const spawnOpts = (bundlePath: string) => ({
      bundlePath,
      sandboxId: "761-probe",
      sandboxWsPort: 1,
      baseCodeDir: tmp("code"),
      runtime: "/bin/true",
    });

    test("a bundle the daemon builds itself is pinned: bytes changed afterwards are refused at spawn", async () => {
      // The path #761 is about: the shared bundle is refused, so the daemon
      // builds its own into the tenant-writable cache -- and then used to
      // spawn whatever that file held for the rest of its life.
      const { stagingDir, builds } = seededStaging();
      const bundleRoot = tmp("user");
      const { value: built } = await quietly(() =>
        buildEngineBundle({ sharedRoot: refusedSharedRoot(), bundleRoot, stagingDir }));
      expect(builds()).toBe(1);
      expect(built.bundlePath).toBe(resolve(bundleRoot, bundleHash(), "main.js"));

      writeFileSync(built.bundlePath, "// swapped after the build\n");
      let thrown: unknown;
      try {
        spawnEngine(spawnOpts(built.bundlePath));
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(BundleIntegrityError);
      expect((thrown as BundleIntegrityError).reason).toBe("changed_since_verification");
    });

    test("an unchanged self-built bundle spawns", async () => {
      const { stagingDir } = seededStaging();
      const built = await buildEngineBundle({ sharedRoot: null, bundleRoot: tmp("user"), stagingDir });
      const engine = spawnEngine(spawnOpts(built.bundlePath));
      engine.stdout?.resume();
      engine.stderr?.resume();
      expect((await engine.exited).code).toBe(0);
    });

    test("a refused shared bundle is answered by a BUILD, never by adopting the per-user copy (#624)", async () => {
      // The per-user cache already holds a main.js for this hash -- planted,
      // as `bundleHash()` makes its path predictable. Adopting it would answer
      // a failed integrity check with a bundle nobody verified.
      const { stagingDir, builds } = seededStaging();
      const bundleRoot = tmp("user");
      mkdirSync(resolve(bundleRoot, bundleHash()), { recursive: true });
      writeFileSync(resolve(bundleRoot, bundleHash(), "main.js"), "// planted in the per-user cache\n");
      const { value: built, warnings } = await quietly(() =>
        buildEngineBundle({ sharedRoot: refusedSharedRoot(), bundleRoot, stagingDir }));
      expect(builds()).toBe(1);
      expect(readFileSync(built.bundlePath, "utf8")).toBe(BUILT);
      expect(warnings.some((w) => w.includes("reason=manifest_absent"))).toBe(true);
    });

    test("an ordinary per-user bundle is ADOPTED with no manifest beside it, and nothing is built", async () => {
      // The over-broad-fix hazard #673 was filed about, on the builder's side:
      // the per-user cache has no manifest by design (same uid, built locally,
      // and this function writes none). A manifest requirement added to the
      // adoption branch would turn every warm start into a rebuild -- or, on a
      // host whose staging install cannot run, into no engine at all.
      const { stagingDir, builds } = seededStaging();
      const bundleRoot = tmp("user");
      const bundleDir = resolve(bundleRoot, bundleHash());
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(resolve(bundleDir, "main.js"), "// built locally, earlier\n");
      writeFileSync(resolve(bundleDir, "main.js.meta.json"), "{}");
      const { value: built, warnings } = await quietly(() =>
        buildEngineBundle({ sharedRoot: null, bundleRoot, stagingDir }));
      expect(built).toEqual({ bundlePath: resolve(bundleDir, "main.js"), hash: bundleHash(), bundleDir });
      expect(builds()).toBe(0);
      expect(readFileSync(built.bundlePath, "utf8")).toBe("// built locally, earlier\n");
      expect(warnings).toEqual([]);
    });

    test("force rebuilds over an existing per-user bundle", async () => {
      const { stagingDir, builds } = seededStaging();
      const bundleRoot = tmp("user");
      mkdirSync(resolve(bundleRoot, bundleHash()), { recursive: true });
      writeFileSync(resolve(bundleRoot, bundleHash(), "main.js"), "// stale\n");
      const built = await buildEngineBundle({ force: true, sharedRoot: null, bundleRoot, stagingDir });
      expect(builds()).toBe(1);
      expect(readFileSync(built.bundlePath, "utf8")).toBe(BUILT);
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
