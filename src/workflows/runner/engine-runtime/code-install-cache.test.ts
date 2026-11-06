/**
 * #1154: CODE-step installs use a Bun install cache of their own, bounded by
 * an LRU budget, and a refused install leaves none of its downloads behind.
 *
 * The installer is injected and writes the cache the way bun 1.3.8 was
 * measured to (see code-install-cache.ts), so no test here needs the registry.
 * That the real installer hands Bun this cache is pinned in
 * code-step-packages.test.ts.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODE_STEP_MAX_INSTALL_BYTES, materializeCodeActions } from "./code-materialize";
import {
  boundCacheAfterInstall,
  CODE_INSTALL_CACHE_MAX_BYTES,
  CODE_INSTALL_CACHE_MAX_ENTRIES,
  CODE_INSTALL_CACHE_REMEASURE_MS,
  codeInstallCacheDir,
  forgetCacheSizes,
  snapshotCache,
  listCacheEntries,
  markInstalledPackagesUsed,
  trimCodeInstallCache,
} from "./code-install-cache";
import type { UpstreamFlowVersion } from "./flow-version-adapter";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-code-cache-"));
  roots.push(dir);
  return dir;
}

function version(id: string, deps: Record<string, string>): UpstreamFlowVersion {
  return {
    id,
    trigger: {
      name: "trigger",
      type: "EMPTY",
      nextAction: {
        name: "compute",
        type: "CODE",
        settings: { sourceCode: { packageJson: JSON.stringify({ dependencies: deps }), code: "exports.code = async () => 1;" }, input: {} },
      },
    },
  } as unknown as UpstreamFlowVersion;
}

/** A package as Bun caches it: the extracted dir, its symlink and a manifest. */
function cachePackage(cache: string, name: string, ver: string, bytes = 10): void {
  const holder = join(cache, name);
  const entry = join(cache, `${name}@${ver}@@@1`);
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, "index.js"), "x".repeat(bytes));
  mkdirSync(holder, { recursive: true });
  symlinkSync(entry, join(holder, `${ver}@@@1`));
  writeFileSync(join(cache, `${Buffer.from(name).toString("hex").slice(0, 16)}.npm`), "{}");
}

/** What `bun install` does: fill the cache, then the tree. */
const bunLike = (pkgs: Array<[string, string, number?]>, after?: (dir: string) => void) =>
  async (dir: string, opts: { cacheDir: string }) => {
    for (const [name, ver, bytes] of pkgs) cachePackage(opts.cacheDir, name, ver, bytes);
    writeFileSync(join(dir, "bun.lock"), "{}");
    for (const [name, ver] of pkgs) {
      mkdirSync(join(dir, "node_modules", name), { recursive: true });
      writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, version: ver }));
    }
    after?.(dir);
  };

const names = (cache: string) => readdirSync(cache).sort();
const bytes = (maxBytes: number) => ({ maxBytes, maxEntries: Number.MAX_SAFE_INTEGER });
const unbounded = bytes(Number.MAX_SAFE_INTEGER);

beforeEach(() => forgetCacheSizes());

describe("the CODE-step install cache (#1154)", () => {
  test("lives in the code directory, and is about 1 GB", () => {
    expect(codeInstallCacheDir("/x/workflow-codes")).toBe("/x/workflow-codes/.install-cache");
    expect(CODE_INSTALL_CACHE_MAX_BYTES).toBe(1024 ** 3);
  });

  test("a successful install keeps its downloads", async () => {
    const base = scratch();
    await materializeCodeActions(version("v_ok", { a: "1.0.0" }), base, { install: bunLike([["a", "1.0.0"]]) });
    const cache = codeInstallCacheDir(base);
    expect(names(cache)).toEqual(["a", "a@1.0.0@@@1", `${Buffer.from("a").toString("hex")}.npm`].sort());
  });

  test("a refused install has its downloads removed, and what was cached before stays", async () => {
    const base = scratch();
    const cache = codeInstallCacheDir(base);
    await materializeCodeActions(version("v_ok", { kept: "1.0.0" }), base, { install: bunLike([["kept", "1.0.0"]]) });
    const before = names(cache);
    // Over the step cap after the install: refused by the measurement after it.
    const huge = bunLike([["huge", "2.0.0"], ["@scope/dep", "3.0.0"]], (dir) => {
      writeFileSync(join(dir, "node_modules", "huge", "blob"), "");
      truncateSync(join(dir, "node_modules", "huge", "blob"), CODE_STEP_MAX_INSTALL_BYTES + 1);
    });
    const err = await materializeCodeActions(version("v_big", { huge: "2.0.0", "@scope/dep": "3.0.0" }), base, { install: huge })
      .then(() => null, (e: Error) => e.message);
    expect(err).toContain("more than one step may take");
    expect(names(cache)).toEqual(before);
  });

  test("an install that fails outright has its downloads removed too", async () => {
    const base = scratch();
    const cache = codeInstallCacheDir(base);
    const failing = async (_dir: string, opts: { cacheDir: string }) => {
      cachePackage(opts.cacheDir, "partial", "1.0.0");
      mkdirSync(join(opts.cacheDir, ".tmp-abc"), { recursive: true });
      throw new Error("bun install of a CODE step's dependencies exited with code 1");
    };
    const err = await materializeCodeActions(version("v_fail", { partial: "1.0.0" }), base, { install: failing })
      .then(() => null, (e: Error) => e.message);
    expect(err).toContain("exited with code 1");
    expect(existsSync(cache) ? names(cache) : []).toEqual([]);
  });

  test("the cache is trimmed to its budget after an install, least recently used first", async () => {
    const base = scratch();
    const cache = codeInstallCacheDir(base);
    const old = new Date(Date.now() - 3_600_000);
    // Two packages already cached, 4 KiB each, used an hour ago; `reused` is
    // what the next install needs again.
    for (const name of ["stale", "reused"]) {
      cachePackage(cache, name, "1.0.0", 4096);
      utimesSync(join(cache, `${name}@1.0.0@@@1`), old, old);
    }
    // `reused` is the OLDER of the two, so only the install marking it used
    // keeps it.
    utimesSync(join(cache, "reused@1.0.0@@@1"), new Date(old.getTime() - 1000), new Date(old.getTime() - 1000));
    const budget = (await trimCodeInstallCache(cache, unbounded)).before.bytes + 4096;
    await materializeCodeActions(version("v_new", { reused: "1.0.0", fresh: "1.0.0" }), base, {
      install: bunLike([["fresh", "1.0.0", 4096]], (dir) => {
        mkdirSync(join(dir, "node_modules", "reused"), { recursive: true });
        writeFileSync(join(dir, "node_modules", "reused", "package.json"), JSON.stringify({ name: "reused", version: "1.0.0" }));
      }),
      installCacheLimit: bytes(budget),
    });
    // `reused` was marked used by the install, so `stale` was the least recently used.
    expect(existsSync(join(cache, "stale@1.0.0@@@1"))).toBe(false);
    expect(existsSync(join(cache, "stale"))).toBe(false); // its symlink holder went with it
    expect(existsSync(join(cache, "reused@1.0.0@@@1"))).toBe(true);
    expect(existsSync(join(cache, "fresh@1.0.0@@@1"))).toBe(true);
  });

  test("scoped packages are entries, marked used and trimmed like the rest", async () => {
    const cache = join(scratch(), "cache");
    cachePackage(cache, "@s/one", "1.0.0", 4096);
    cachePackage(cache, "@s/two", "1.0.0", 4096);
    const paths = (await listCacheEntries(cache)).map((e) => e.path.slice(cache.length + 1)).sort();
    expect(paths).toContain("@s/one@1.0.0@@@1");
    expect(paths).toContain("@s/one/1.0.0@@@1");
    const old = new Date(Date.now() - 3_600_000);
    for (const n of ["one", "two"]) utimesSync(join(cache, "@s", `${n}@1.0.0@@@1`), old, old);
    const nm = join(scratch(), "node_modules");
    mkdirSync(join(nm, "@s", "two"), { recursive: true });
    writeFileSync(join(nm, "@s", "two", "package.json"), JSON.stringify({ name: "@s/two", version: "1.0.0" }));
    await markInstalledPackagesUsed(cache, nm);
    const total = (await trimCodeInstallCache(cache, unbounded)).before.bytes;
    const { removed } = await trimCodeInstallCache(cache, bytes(total - 1));
    expect(removed.map((p) => p.slice(cache.length + 1))).toContain("@s/one@1.0.0@@@1");
    expect(existsSync(join(cache, "@s", "two@1.0.0@@@1"))).toBe(true);
    expect(existsSync(join(cache, "@s", "one"))).toBe(false);
  });

  // Review of #1154: a registry other than npm's puts its host in the name.
  test("an entry from another registry is marked used too", async () => {
    const cache = join(scratch(), "cache");
    // `hosted` is the older, so only being marked used keeps it.
    for (const [name, ageMs] of [["hosted", 7_200_000], ["other", 3_600_000]] as const) {
      const entry = join(cache, `${name}@1.0.0@@registry.example.com@@@1`);
      mkdirSync(entry, { recursive: true });
      writeFileSync(join(entry, "index.js"), "x".repeat(4096));
      utimesSync(entry, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
    }
    const nm = join(scratch(), "node_modules");
    mkdirSync(join(nm, "hosted", "node_modules", "nested"), { recursive: true });
    writeFileSync(join(nm, "hosted", "package.json"), JSON.stringify({ name: "hosted", version: "1.0.0" }));
    await markInstalledPackagesUsed(cache, nm);
    const total = (await trimCodeInstallCache(cache, unbounded)).before.bytes;
    await trimCodeInstallCache(cache, bytes(total - 1));
    expect(existsSync(join(cache, "hosted@1.0.0@@registry.example.com@@@1"))).toBe(true);
    expect(existsSync(join(cache, "other@1.0.0@@registry.example.com@@@1"))).toBe(false);
  });

  test("a package installed nested under another is marked used", async () => {
    const cache = join(scratch(), "cache");
    cachePackage(cache, "inner", "2.0.0", 4096);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(cache, "inner@2.0.0@@@1"), old, old);
    const nm = join(scratch(), "node_modules");
    mkdirSync(join(nm, "outer", "node_modules", "inner"), { recursive: true });
    writeFileSync(join(nm, "outer", "package.json"), JSON.stringify({ name: "outer", version: "1.0.0" }));
    writeFileSync(join(nm, "outer", "node_modules", "inner", "package.json"), JSON.stringify({ name: "inner", version: "2.0.0" }));
    await markInstalledPackagesUsed(cache, nm);
    expect(Date.now() - (await import("node:fs")).statSync(join(cache, "inner@2.0.0@@@1")).mtimeMs).toBeLessThan(60_000);
  });

  test("the cache is held to an entry budget as well as a byte budget", async () => {
    expect(CODE_INSTALL_CACHE_MAX_ENTRIES).toBe(2 * 65_536);
    const cache = join(scratch(), "cache");
    // Many empty files: next to no bytes, many inodes.
    const entry = join(cache, "empty@1.0.0@@@1");
    mkdirSync(entry, { recursive: true });
    for (let i = 0; i < 50; i++) writeFileSync(join(entry, `f${i}`), "");
    const { removed } = await trimCodeInstallCache(cache, { maxBytes: Number.MAX_SAFE_INTEGER, maxEntries: 10 });
    expect(removed.map((p) => p.slice(cache.length + 1))).toEqual(["empty@1.0.0@@@1"]);
  });

  test("between full measures an install only measures what it added, and still trims when that goes over", async () => {
    const cache = join(scratch(), "cache");
    cachePackage(cache, "first", "1.0.0", 4096);
    const t0 = Date.now();
    // A full measure: under budget, nothing removed, the size remembered.
    const budget = bytes((await trimCodeInstallCache(cache, unbounded)).before.bytes + 6000);
    expect(await boundCacheAfterInstall(cache, await snapshotCache(cache), budget, t0)).not.toBeNull();
    // A small addition within the window: carried forward, no full measure.
    let before = await snapshotCache(cache);
    cachePackage(cache, "small", "1.0.0", 100);
    expect(await boundCacheAfterInstall(cache, before, budget, t0 + 1000)).toBeNull();
    // One that takes it over: measured in full and trimmed.
    before = await snapshotCache(cache);
    cachePackage(cache, "big", "1.0.0", 8192);
    const trimmed = await boundCacheAfterInstall(cache, before, budget, t0 + 2000);
    expect(trimmed?.removed.length).toBeGreaterThan(0);
    // And past the window, measured in full whatever was added.
    expect(await boundCacheAfterInstall(cache, await snapshotCache(cache), budget, t0 + 2000 + CODE_INSTALL_CACHE_REMEASURE_MS))
      .not.toBeNull();
  });

  test("under budget, nothing is removed", async () => {
    const cache = join(scratch(), "cache");
    cachePackage(cache, "a", "1.0.0");
    const { removed } = await trimCodeInstallCache(cache);
    expect(removed).toEqual([]);
    expect(names(cache).length).toBe(3);
  });

  // Review of #1154: the layout above is what bun 1.3.8 was measured to write.
  // This holds it against the Bun actually running, through the real
  // installer, against a registry on loopback (no network): what it caches is
  // in the install cache and nowhere else, the entries are ones this module
  // recognises, and the install marks them used.
  test.skipIf(process.platform === "win32")("the real installer fills the install cache with entries this module recognises", async () => {
    const tgz = tarGz({ "package/package.json": JSON.stringify({ name: "jarvis-probe-dep", version: "1.2.3", main: "index.js" }),
      "package/index.js": "module.exports = 42;" });
    const sha1 = new Bun.CryptoHasher("sha1").update(tgz).digest("hex");
    const integrity = "sha512-" + new Bun.CryptoHasher("sha512").update(tgz).digest("base64");
    const server: ReturnType<typeof Bun.serve> = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req): Response {
        const path = new URL(req.url).pathname;
        if (path === "/jarvis-probe-dep") {
          return Response.json({ name: "jarvis-probe-dep", "dist-tags": { latest: "1.2.3" }, versions: { "1.2.3": {
            name: "jarvis-probe-dep", version: "1.2.3",
            dist: { tarball: `http://127.0.0.1:${server.port}/jarvis-probe-dep/-/jarvis-probe-dep-1.2.3.tgz`, shasum: sha1, integrity },
          } } });
        }
        if (path === "/jarvis-probe-dep/-/jarvis-probe-dep-1.2.3.tgz") return new Response(new Blob([tgz as Uint8Array<ArrayBuffer>]));
        return new Response("not found", { status: 404 });
      },
    });
    const base = scratch();
    const userCache = join(base, "users-own-cache");
    const saved = { reg: process.env.NPM_CONFIG_REGISTRY, cache: process.env.BUN_INSTALL_CACHE_DIR };
    process.env.NPM_CONFIG_REGISTRY = `http://127.0.0.1:${server.port}/`;
    process.env.BUN_INSTALL_CACHE_DIR = userCache;
    try {
      const codes = join(base, "codes");
      await materializeCodeActions(version("v_real", { "jarvis-probe-dep": "1.2.3" }), codes);
      const cache = codeInstallCacheDir(codes);
      const entries = await listCacheEntries(cache);
      const pkg = entries.find((e) => !e.link && /^jarvis-probe-dep@1\.2\.3@@/.test(e.path.slice(cache.length + 1)));
      expect(pkg).toBeDefined();
      expect(existsSync(userCache)).toBe(false);
      // Marked used by the install: an old mtime comes back fresh.
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(pkg!.path, old, old);
      await markInstalledPackagesUsed(cache, join(codes, "v_real", "compute", "node_modules"));
      expect(Date.now() - (await import("node:fs")).statSync(pkg!.path).mtimeMs).toBeLessThan(60_000);
    } finally {
      for (const [k, v] of [["NPM_CONFIG_REGISTRY", saved.reg], ["BUN_INSTALL_CACHE_DIR", saved.cache]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      server.stop(true);
    }
  }, 60_000);
});

/** A gzipped ustar archive of `files` (path -> text). Enough for `bun install`. */
function tarGz(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const [name, text] of Object.entries(files)) {
    const body = enc.encode(text);
    const header = new Uint8Array(512);
    const put = (off: number, len: number, value: string) => header.set(enc.encode(value).slice(0, len), off);
    put(0, 100, name);
    put(100, 8, "0000644\0");
    put(108, 8, "0000000\0");
    put(116, 8, "0000000\0");
    put(124, 12, body.length.toString(8).padStart(11, "0") + "\0");
    put(136, 12, "00000000000\0");
    put(148, 8, "        ");
    put(156, 1, "0");
    put(257, 6, "ustar\0");
    put(263, 2, "00");
    let sum = 0;
    for (const b of header) sum += b;
    put(148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
    blocks.push(header, body, new Uint8Array((512 - (body.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const tar = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    tar.set(b, off);
    off += b.length;
  }
  return Bun.gzipSync(tar) as Uint8Array<ArrayBuffer>;
}
