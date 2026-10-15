/**
 * #759. The engine bundle used to leave `bufferutil` and `supports-color` to
 * run-time resolution, so the code it ran was not only `main.js`: a writer of
 * any `node_modules` above the bundle could run code at every engine spawn,
 * and with no `node_modules` above it at all -- the per-user cache -- Bun
 * auto-installed them from the npm registry. The manifest (#624) and the
 * per-spawn pin (#671) both cover `main.js` alone, so neither saw it.
 *
 * These pin the three layers that now close it: the bundle compiles those
 * names out and refuses to build with any other bare run-time name, and the
 * engine is spawned with `ws`'s own switches set and Bun's auto-install off.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  absentModulesPlugin,
  assertSelfContainedBundle,
  buildEngineBundle,
  ENGINE_ABSENT_MODULES,
  ENGINE_BUILD_PATHS,
  ENGINE_ESBUILD_CONFIG,
  findCachedBundle,
  runtimeResolvedModules,
  type EngineMetafile,
} from "./build";
import { engineEnv, spawnEngine } from "./spawn";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `jarvis-759-${tag}-`));
  dirs.push(d);
  return d;
};

const metafileImporting = (...imports: Array<{ path: string; kind?: string; external?: boolean }>): EngineMetafile => ({
  outputs: {
    "main.js": { imports: imports.map((i) => ({ kind: "require-call", external: true, ...i })) },
    "main.js.map": { imports: [] },
  },
});

describe("the build refuses a bundle that resolves code at run time (#759)", () => {
  test("Node builtins, in either spelling, are not run-time resolution", () => {
    expect(runtimeResolvedModules(metafileImporting(
      { path: "fs" }, { path: "node:fs" }, { path: "fs/promises" }, { path: "timers/promises" }, { path: "node:util/types" },
    ))).toEqual([]);
  });

  test("a bare package name left external is reported, and the build refuses it", () => {
    // `supports-color` is the shape that slipped through: never listed in
    // `external`, left external by esbuild on its own because the require sat
    // in a `try`. The guard reads what the OUTPUT still requires, so it does
    // not care how a name got there.
    const metafile = metafileImporting({ path: "http" }, { path: "supports-color" }, { path: "@scope/pkg/sub" });
    expect(runtimeResolvedModules(metafile)).toEqual(["@scope/pkg/sub", "supports-color"]);
    expect(() => assertSelfContainedBundle(metafile)).toThrow(/REFUSED: it would resolve "@scope\/pkg\/sub", "supports-color" at run time/u);
  });

  test("names Bun shadows are run-time resolution too, not builtins", () => {
    // Bun's builtinModules lists these; the bundle targets node, and leaving one
    // external would swap in the runtime's copy (or, off Bun, resolve it from disk).
    expect(runtimeResolvedModules(metafileImporting(
      { path: "ws" }, { path: "undici" }, { path: "bun" }, { path: "bun:sqlite" },
    ))).toEqual(["bun", "bun:sqlite", "undici", "ws"]);
  });

  test("an import that was bundled is not reported, however it is spelled", () => {
    expect(runtimeResolvedModules(metafileImporting({ path: "ws", external: false }))).toEqual([]);
  });

  test("the four optional names are all compiled out", () => {
    expect([...ENGINE_ABSENT_MODULES].sort()).toEqual(["bufferutil", "isolated-vm", "supports-color", "utf-8-validate"]);
  });

  test("what is compiled out is part of the bundle cache key", () => {
    // The plugin is a function, so it cannot ride in ENGINE_ESBUILD_CONFIG's
    // JSON; without this a change to the list or the stub would be served stale
    // from every cache that already holds a bundle for the hash. Same shape as
    // "the build config is part of the bundle cache key" in build.test.ts.
    const src = readFileSync(resolve(import.meta.dir, "build.ts"), "utf8");
    const body = src.slice(src.indexOf("export function bundleHash"));
    const fn = body.slice(0, body.indexOf("\n}"));
    expect(fn).toContain("ENGINE_ABSENT_MODULES");
    expect(fn).toContain("absentModuleSource(name)");
  });
});

/**
 * The stub through REAL esbuild, because its correctness depends on esbuild's
 * CommonJS wrapper: that wrapper memoizes the module record before the body
 * runs, so a stub that merely threw handed its second requirer `{}`. Skipped
 * where the staging install (and so esbuild) is absent; CI's build opt-in has it.
 */
const stagingEsbuild = resolve(ENGINE_BUILD_PATHS.STAGING_DIR, "node_modules/esbuild/lib/main.js");
describe.skipIf(!existsSync(stagingEsbuild))("an absent module throws at every require (#759)", () => {
  test("the second require of a compiled-out name throws MODULE_NOT_FOUND, not an empty object", async () => {
    const dir = scratch("stub");
    const entry = join(dir, "entry.js");
    writeFileSync(entry,
      `const seen = [];\n` +
      `for (const name of ["first", "second", "third"]) {\n` +
      `  try { const m = require("bufferutil"); seen.push(name + ":returned " + typeof m + " " + JSON.stringify(Object.keys(m))); }\n` +
      `  catch (e) { seen.push(name + ":" + e.code); }\n` +
      `}\n` +
      `console.log(JSON.stringify(seen));\n`);
    const esbuild = (await import(stagingEsbuild)) as { build(o: Record<string, unknown>): Promise<unknown> };
    const outfile = join(dir, "out.js");
    await esbuild.build({ ...ENGINE_ESBUILD_CONFIG, banner: undefined, entryPoints: [entry], outfile, plugins: [absentModulesPlugin()], logLevel: "silent" });
    const proc = Bun.spawnSync([process.execPath, outfile], { env: { PATH: process.env.PATH ?? "" } });
    expect(JSON.parse(proc.stdout.toString().trim())).toEqual(["first:MODULE_NOT_FOUND", "second:MODULE_NOT_FOUND", "third:MODULE_NOT_FOUND"]);
  }, 20_000);
});

/**
 * Two builds of one hash must be the same bytes wherever they run from. Since
 * #761 the builder pins its digest, so a rebuild of the same path by a process
 * started in another directory (a script, a second daemon) used to change the
 * bytes under a pinned runtime and refuse every later spawn: esbuild wrote
 * cwd-relative module keys. Real builds, into scratch roots, through the seam.
 */
describe.skipIf(!existsSync(stagingEsbuild))("the build does not depend on the builder's cwd (#761)", () => {
  test("building from two different working directories yields one digest", async () => {
    // Separate PROCESSES, as in the scenario: esbuild's service takes its
    // working directory from the process that starts it, so a chdir inside one
    // test process would not move it and could not see the bug.
    const builder = join(scratch("builder"), "build.ts");
    writeFileSync(builder,
      `import { buildEngineBundle } from ${JSON.stringify(resolve(import.meta.dir, "build.ts"))};\n` +
      `const b = await buildEngineBundle({ force: true, sharedRoot: null, bundleRoot: process.argv[2] });\n` +
      `console.log(b.digest);\n`);
    const digests: string[] = [];
    for (const cwd of [ENGINE_BUILD_PATHS.REPO_ROOT, scratch("elsewhere")]) {
      const proc = Bun.spawnSync([process.execPath, builder, scratch("root")], {
        cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, stderr: "pipe",
      });
      expect({ code: proc.exitCode, stderr: proc.stderr.toString().slice(0, 500) }).toEqual({ code: 0, stderr: "" });
      digests.push(proc.stdout.toString().trim().split("\n").pop() ?? "");
    }
    expect(digests[0]).toMatch(/^[0-9a-f]{64}$/u);
    expect(digests[1]).toBe(digests[0]);
  }, 60_000);
});

/**
 * The bundle actually built for this source state. Skipped when none is
 * cached and the build is not opted into, the same gate the end-to-end
 * suites use; CI opts in.
 */
const buildOptIn = process.env.JARVIS_TEST_ENGINE_BUILD === "1";
const cached = findCachedBundle({ sharedRoot: null });

describe.skipIf(cached === null && !buildOptIn)("the built engine bundle is self-contained (#759)", () => {
  const bundle = async (): Promise<string> => (cached ?? (await buildEngineBundle({ sharedRoot: null }))).bundlePath;

  test("its metafile names no module to resolve at run time", async () => {
    const metafile = JSON.parse(readFileSync((await bundle()) + ".meta.json", "utf8")) as EngineMetafile;
    expect(runtimeResolvedModules(metafile)).toEqual([]);
  });

  test("node_modules planted above it are never loaded, and it still starts", async () => {
    // The issue's attack, done for real: a copy of the bundle with every name
    // it used to resolve planted ABOVE it. Each plant records that it ran and
    // then throws, so a bundle that still required one would both leave a
    // record and take its fallback. Run bare (no SANDBOX_ID), which loads the
    // whole module graph -- `ws` and `debug` included -- and exits 0.
    const root = scratch("planted");
    const marker = join(root, "loaded.log");
    writeFileSync(marker, "");
    for (const name of [...ENGINE_ABSENT_MODULES]) {
      const dir = join(root, "node_modules", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "9.9.9", main: "index.js" }));
      writeFileSync(join(dir, "index.js"),
        `require("fs").appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name)} + "\\n"); throw new Error("planted");\n`);
    }
    const copy = join(root, "engine", "bundle", "main.js");
    mkdirSync(resolve(copy, ".."), { recursive: true });
    copyFileSync(await bundle(), copy);
    const proc = Bun.spawn([process.execPath, copy], {
      env: { PATH: process.env.PATH ?? "", HOME: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect({ code, loaded: readFileSync(marker, "utf8") }).toEqual({ code: 0, loaded: "" });
  }, 20_000);
});

describe("the engine is spawned so nothing is resolved from outside the bundle (#759)", () => {
  const opts = { bundlePath: "/x/main.js", sandboxId: "sb", sandboxWsPort: 1, baseCodeDir: "/tmp" };

  test("ws's native-helper lookups are switched off", () => {
    const env = engineEnv(opts);
    expect(env.WS_NO_BUFFER_UTIL).toBe("1");
    expect(env.WS_NO_UTF_8_VALIDATE).toBe("1");
  });

  test("a caller's env override can neither clear nor change them", () => {
    // The override loop DELETES a name given `undefined`, whatever the name;
    // these are set after it so that cannot reach them.
    const warn = console.warn;
    console.warn = () => {};
    try {
      const env = engineEnv({ ...opts, env: { WS_NO_BUFFER_UTIL: undefined, WS_NO_UTF_8_VALIDATE: "0" } });
      expect(env.WS_NO_BUFFER_UTIL).toBe("1");
      expect(env.WS_NO_UTF_8_VALIDATE).toBe("1");
    } finally {
      console.warn = warn;
    }
  });

  test("the real engine process runs with Bun's auto-install off and the switches set", async () => {
    // A stand-in bundle that reports what the engine process was started with.
    // The default runtime (no `runtime` override) is the path production uses.
    const dir = scratch("argv");
    const bundlePath = join(dir, "main.js");
    writeFileSync(bundlePath,
      `console.log(JSON.stringify({ execArgv: process.execArgv, bu: process.env.WS_NO_BUFFER_UTIL ?? null, u8: process.env.WS_NO_UTF_8_VALIDATE ?? null }));\n`);
    const engine = spawnEngine({ bundlePath, expectedDigest: null, sandboxId: "argv-probe", sandboxWsPort: 1, baseCodeDir: dir });
    let out = "";
    engine.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    engine.stderr?.resume();
    const exit = await engine.exited;
    expect(exit.code).toBe(0);
    const seen = JSON.parse(out.trim()) as { execArgv: string[]; bu: string | null; u8: string | null };
    expect(seen.execArgv).toContain("--no-install");
    expect({ bu: seen.bu, u8: seen.u8 }).toEqual({ bu: "1", u8: "1" });
  }, 20_000);
});
