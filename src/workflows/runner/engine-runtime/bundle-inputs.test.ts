/**
 * #836: everything the engine bundle compiles in comes from what
 * `bundleHash()` covers, so two builders of one hash produce one set of bytes.
 *
 * Before: packages the daemon also depends on were compiled from the daemon's
 * own `node_modules` (from a worktree, the main checkout's) at whatever version
 * that tree held -- undici 6.21.3 for the engine's pinned 7.24.6 -- the staging
 * install floated on ranges with no lockfile, and the bytes named the
 * builder's directory layout. Since #761/#762 pin the built bytes per spawn, any
 * of those turns a second builder into refused spawns.
 *
 * Three layers, each held here: the staging install is the committed lockfile
 * (and only a completed install counts), our sources resolve packages from
 * staging alone, and the bundle's bytes do not depend on where the repo or the
 * staging dir is. The real-build tests need the staging esbuild and skip
 * without it, like the other real-build suites; CI's build opt-in has it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertInputsFromStaging,
  assertInputsResolveInside,
  buildEngineBundle,
  buildStagingPackageJson,
  bundleHash,
  ENGINE_BUILD_PATHS,
  ensureStagingInstalled,
  STAGING_INSTALL_ARGS,
  STAGING_INSTALLED_MARKER,
  stagingInstallStamp,
  stagingLockfile,
  stagingResolutionPlugin,
  type EngineMetafile,
} from "./build";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function scratch(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `jarvis-836-${tag}-`));
  roots.push(d);
  return d;
}

/** bun.lock is JSONC: trailing commas. */
const parseLock = (text: string) =>
  JSON.parse(text.replace(/,(\s*[}\]])/gu, "$1")) as {
    workspaces: Record<string, { dependencies?: Record<string, string> }>;
    overrides?: Record<string, string>;
    packages: Record<string, unknown>;
  };

describe("the staging install is the committed lockfile (#836)", () => {
  test("the committed lockfile is the lockfile for the package.json the build synthesizes", () => {
    // Fails after an upstream sync or a SECURITY_FLOOR change until the lock is
    // regenerated: bun run scripts/update-engine-staging-lock.ts
    const pkg = JSON.parse(buildStagingPackageJson()) as { dependencies: Record<string, string>; overrides?: Record<string, string> };
    const lock = parseLock(stagingLockfile());
    expect(lock.workspaces[""]?.dependencies).toEqual(pkg.dependencies);
    expect(lock.overrides ?? {}).toEqual(pkg.overrides ?? {});
    // Every package carries an integrity hash, so a registry cannot swap bytes.
    for (const [name, entry] of Object.entries(lock.packages)) {
      const integrity = (entry as unknown[])[3];
      // "" is the default registry; a URL here means it was resolved behind a
      // mirror, and every other builder would fetch from that mirror.
      expect({ name, registry: (entry as unknown[])[1] }).toEqual({ name, registry: "" });
      expect({ name, integrity: typeof integrity === "string" && integrity.startsWith("sha512-") }).toEqual({ name, integrity: true });
    }
  });

  test("the bundle cache key moves with the lockfile, so a dependency bump is a new bundle", () => {
    const lock = stagingLockfile();
    expect(bundleHash({ stagingLock: lock })).toBe(bundleHash());
    expect(bundleHash({ stagingLock: lock.replace('"ai@6.', '"ai@7.') })).not.toBe(bundleHash());
  });

  test("the install is frozen to it", () => {
    expect(STAGING_INSTALL_ARGS).toContain("--frozen-lockfile");
    expect(STAGING_INSTALL_ARGS).toContain("--ignore-scripts");
  });

  const seed = (dir: string, opts: { lock?: string; marker?: string | null }) => {
    writeFileSync(join(dir, "package.json"), buildStagingPackageJson());
    if (opts.lock !== undefined) writeFileSync(join(dir, "bun.lock"), opts.lock);
    mkdirSync(join(dir, "node_modules", "left-over"), { recursive: true });
    if (opts.marker) writeFileSync(join(dir, "node_modules", STAGING_INSTALLED_MARKER), opts.marker);
  };

  test("a staging tree resolved for another lockfile is reinstalled from scratch, frozen to the committed one", async () => {
    // The shape every existing developer cache has: the same package.json, a
    // lockfile from whenever it was first resolved.
    const dir = scratch("stale");
    seed(dir, { lock: "{ stale }", marker: null });
    const calls: Array<{ args: readonly string[]; lock: string; leftOver: boolean }> = [];
    await ensureStagingInstalled(dir, async (d, args) => {
      calls.push({ args, lock: readFileSync(join(d, "bun.lock"), "utf8"), leftOver: existsSync(join(d, "node_modules", "left-over")) });
    });
    expect(calls).toEqual([{ args: STAGING_INSTALL_ARGS, lock: stagingLockfile(), leftOver: false }]);
    expect(readFileSync(join(dir, "node_modules", STAGING_INSTALLED_MARKER), "utf8")).toBe(stagingInstallStamp());
  });

  test("a completed install for the committed lockfile is not redone", async () => {
    const dir = scratch("current");
    seed(dir, { lock: stagingLockfile(), marker: stagingInstallStamp() });
    let calls = 0;
    await ensureStagingInstalled(dir, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });

  test("an install that died half way is not mistaken for a finished one", async () => {
    const dir = scratch("torn");
    seed(dir, { lock: stagingLockfile(), marker: null });
    await expect(ensureStagingInstalled(dir, async () => {
      throw new Error("network");
    })).rejects.toThrow("network");
    expect(existsSync(join(dir, "node_modules", STAGING_INSTALLED_MARKER))).toBe(false);
    let calls = 0;
    await ensureStagingInstalled(dir, async () => {
      calls++;
    });
    expect(calls).toBe(1);
  });
});

describe("the staging layout is the hoisted one the build resolves through (#836, review)", () => {
  test("the install asks for the hoisted linker whatever a bunfig says", () => {
    expect(STAGING_INSTALL_ARGS).toContain("--linker=hoisted");
  });

  test("a tree with a symlinked package (the isolated linker's layout) is refused and not marked installed", async () => {
    const dir = scratch("isolated");
    await expect(ensureStagingInstalled(dir, async (d) => {
      mkdirSync(join(d, "node_modules", ".bun", "debug@4.4.3", "node_modules", "debug"), { recursive: true });
      symlinkSync(".bun/debug@4.4.3/node_modules/debug", join(d, "node_modules", "debug"));
      mkdirSync(join(d, "node_modules", "@scope", ".x"), { recursive: true });
    })).rejects.toThrow(/REFUSED: debug is a symlink/u);
    expect(existsSync(join(dir, "node_modules", STAGING_INSTALLED_MARKER))).toBe(false);
  });

  test("a symlinked scoped package is refused too", async () => {
    const dir = scratch("isolated-scoped");
    await expect(ensureStagingInstalled(dir, async (d) => {
      mkdirSync(join(d, "node_modules", "@ai-sdk"), { recursive: true });
      mkdirSync(join(d, "elsewhere"), { recursive: true });
      symlinkSync(join(d, "elsewhere"), join(d, "node_modules", "@ai-sdk", "provider"));
    })).rejects.toThrow(/@ai-sdk\/provider is a symlink/u);
  });
});

describe("assertInputsResolveInside", () => {
  /** A build view over a scratch repo and staging, as buildEngineBundle makes one. */
  const view = () => {
    const root = scratch("view");
    const repo = join(root, "repo-real");
    const staging = join(root, "staging-real");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(staging, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repo, "src", "main.ts"), "");
    writeFileSync(join(staging, "node_modules", "pkg", "index.js"), "");
    writeFileSync(join(root, "outside.js"), "");
    const v = join(root, "view");
    mkdirSync(v);
    symlinkSync(repo, join(v, "repo"));
    symlinkSync(staging, join(v, "staging"));
    return { root, repo, staging, v };
  };
  const meta = (...keys: string[]): EngineMetafile => ({ outputs: {}, inputs: Object.fromEntries(keys.map((k) => [k, {}])) });

  test("inputs that really are our sources and staging files pass", () => {
    const { repo, staging, v } = view();
    expect(() => assertInputsResolveInside(meta("repo/src/main.ts", "staging/node_modules/pkg/index.js", "jarvis-absent-module:x"), v, staging, repo))
      .not.toThrow();
  });

  test("a staging file that is a link out of staging is refused, though its name is acceptable", () => {
    const { root, repo, staging, v } = view();
    symlinkSync(join(root, "outside.js"), join(staging, "node_modules", "pkg", "evil.js"));
    expect(() => assertInputsResolveInside(meta("staging/node_modules/pkg/evil.js"), v, staging, repo)).toThrow(/REFUSED.*#836/u);
    // And the name check alone would have let it through.
    expect(() => assertInputsFromStaging(meta("staging/node_modules/pkg/evil.js"))).not.toThrow();
  });

  test("a source file that is a link out of src is refused", () => {
    const { root, repo, staging, v } = view();
    symlinkSync(join(root, "outside.js"), join(repo, "src", "evil.ts"));
    expect(() => assertInputsResolveInside(meta("repo/src/evil.ts"), v, staging, repo)).toThrow(/REFUSED.*#836/u);
  });
});

describe("assertInputsFromStaging", () => {
  const meta = (...keys: string[]): EngineMetafile => ({ outputs: {}, inputs: Object.fromEntries(keys.map((k) => [k, {}])) });

  test("accepts our sources, the staging install and compiled-out stubs", () => {
    expect(() => assertInputsFromStaging(meta(
      "repo/src/workflows/activepieces/packages/server/engine/src/main.ts",
      "staging/node_modules/undici/index.js",
      "staging/node_modules/engine.io-client/node_modules/ws/index.js",
      "jarvis-absent-module:bufferutil",
    ))).not.toThrow();
  });

  test.each([
    ["the daemon's node_modules, from the main checkout", "node_modules/undici/index.js"],
    ["the main checkout's node_modules, from a worktree", "../../../node_modules/undici/index.js"],
    ["a node_modules inside the repo", "repo/node_modules/undici/index.js"],
    ["a node_modules below src", "repo/src/x/node_modules/y/index.js"],
    ["a walk out of staging", "staging/node_modules/../../evil.js"],
    ["a walk out of the repo", "repo/src/../../evil.js"],
    ["an absolute path", "/etc/passwd"],
    ["another namespace", "other-plugin:thing"],
  ])("refuses %s", (_label, key) => {
    expect(() => assertInputsFromStaging(meta("repo/src/main.ts", key))).toThrow(/REFUSED.*#836/u);
  });
});

const stagingEsbuild = resolve(ENGINE_BUILD_PATHS.STAGING_DIR, "node_modules/esbuild/lib/main.js");

describe.skipIf(!existsSync(stagingEsbuild))("our sources resolve packages from staging alone (#836)", () => {
  /**
   * A miniature of the real layout: a source tree with a `node_modules` above
   * it (the daemon's own) and a separate staging install, the same package in
   * both at different versions.
   */
  const layout = () => {
    const root = scratch("layout");
    const pkg = (dir: string, name: string, value: string) => {
      mkdirSync(join(dir, "node_modules", name), { recursive: true });
      writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
      writeFileSync(join(dir, "node_modules", name, "index.js"), `module.exports = ${JSON.stringify(value)};`);
    };
    const repo = join(root, "repo");
    const staging = join(root, "staging");
    mkdirSync(join(repo, "src"), { recursive: true });
    pkg(repo, "dep", "from the daemon's node_modules");
    pkg(repo, "only-in-daemon", "daemon");
    pkg(staging, "dep", "from staging");
    return { root, repo, staging };
  };
  const esbuild = async () => (await import(stagingEsbuild)) as {
    build(o: Record<string, unknown>): Promise<{ outputFiles: Array<{ text: string }> }>;
  };

  test("a package in both trees is compiled from staging", async () => {
    const { root, repo, staging } = layout();
    writeFileSync(join(repo, "src", "entry.js"), `console.log(require("dep"));`);
    const out = await (await esbuild()).build({
      entryPoints: [join(repo, "src", "entry.js")], bundle: true, platform: "node", format: "cjs", write: false,
      absWorkingDir: root, logLevel: "silent", plugins: [stagingResolutionPlugin(staging)],
    });
    const file = join(root, "out.js");
    writeFileSync(file, out.outputFiles[0]!.text);
    const run = Bun.spawnSync([process.execPath, file]);
    // Before #836 this printed "from the daemon's node_modules".
    expect(run.stdout.toString().trim()).toBe("from staging");
  });

  test("a package only the daemon has fails the build, naming it", async () => {
    const { root, repo, staging } = layout();
    writeFileSync(join(repo, "src", "entry.js"), `console.log(require("only-in-daemon"));`);
    const err = await (await esbuild()).build({
      entryPoints: [join(repo, "src", "entry.js")], bundle: true, platform: "node", format: "cjs", write: false,
      absWorkingDir: root, logLevel: "silent", plugins: [stagingResolutionPlugin(staging)],
    }).then(() => null, (e: Error) => e.message);
    expect(err).toContain('"only-in-daemon" is not in the engine staging install');
  });
});

describe.skipIf(!existsSync(stagingEsbuild))("the real engine build (#836)", () => {
  /**
   * A COPY of the developer's staging install, brought up to the committed
   * lockfile there. Never the real one: that tree is shared by every checkout
   * and daemon of this user, and bringing it current would wipe it under them.
   */
  const realStagingCopy = async (at: string): Promise<string> => {
    cpSync(ENGINE_BUILD_PATHS.STAGING_DIR, at, { recursive: true });
    await ensureStagingInstalled(at);
    return at;
  };

  test("compiles in nothing from outside staging and our own sources", async () => {
    const staging = await realStagingCopy(join(scratch("real-staging"), "staging"));
    const b = await buildEngineBundle({ force: true, sharedRoot: null, bundleRoot: scratch("real"), stagingDir: staging });
    const inputs = Object.keys((JSON.parse(readFileSync(b.bundlePath + ".meta.json", "utf8")) as EngineMetafile).inputs ?? {});
    expect(inputs.filter((k) => k.startsWith("staging/node_modules/undici/")).length).toBeGreaterThan(0);
    expect(inputs.filter((k) => !k.startsWith("staging/node_modules/") && !k.startsWith("repo/src/") && !k.startsWith("jarvis-absent-module:")))
      .toEqual([]);
    // The version the engine declares, not whatever the daemon's tree holds.
    const undici = JSON.parse(readFileSync(resolve(staging, "node_modules/undici/package.json"), "utf8")) as { version: string };
    expect(undici.version).toBe(JSON.parse(buildStagingPackageJson()).dependencies.undici);
  }, 120_000);

  test("a staging file swapped for a link out of staging refuses the build", async () => {
    const staging = await realStagingCopy(join(scratch("linked"), "staging"));
    const victim = join(staging, "node_modules", "ms", "index.js");
    const outside = join(scratch("outside"), "index.js");
    cpSync(victim, outside);
    rmSync(victim);
    symlinkSync(outside, victim);
    await expect(buildEngineBundle({ force: true, sharedRoot: null, bundleRoot: scratch("out"), stagingDir: staging }))
      .rejects.toThrow(/links to files outside the staging install/u);
  }, 120_000);

  test("one hash is one set of bytes, wherever the staging install is", async () => {
    // Two staging dirs at different depths stand in for two builders' layouts
    // (a worktree and the main checkout differ in exactly this: where the
    // install sits relative to the repo). Before #836 the bundle named the
    // staging path relative to the repo, so these two digests differed.
    const near = await realStagingCopy(join(scratch("near"), "staging"));
    const far = join(scratch("far"), "a", "b", "c", "staging");
    cpSync(near, far, { recursive: true });
    const digests: Array<string | null> = [];
    for (const stagingDir of [near, far]) {
      digests.push((await buildEngineBundle({ force: true, sharedRoot: null, bundleRoot: scratch("out"), stagingDir })).digest);
    }
    expect(digests[0]).toMatch(/^[0-9a-f]{64}$/u);
    expect(digests[1]).toBe(digests[0]);
  }, 120_000);
});
