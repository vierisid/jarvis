/**
 * #835: a pinned engine bundle must not be executed from a transpiled copy the
 * digest pin never checked.
 *
 * Bun runs a large file from its runtime transpiler cache, by default
 * `$HOME/.bun/install/cache/@t@/<hash>.pile`. These tests spawn a real child
 * through `spawnEngine` with a scratch HOME and look for that file, so they
 * hold the behaviour (no cache entry under a tenant-writable HOME), not just
 * the variable. The unpinned control proves the harness sees an entry when one
 * is written, so the pinned assertion cannot pass by looking in the wrong place.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineTranspilerCache, isHostOwnedReadOnly, spawnEngine, TRANSPILER_CACHE_ENV, type CacheDirProbe } from "./spawn";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    try {
      chmodSync(r, 0o755);
    } catch {
      /* gone */
    }
    rmSync(r, { recursive: true, force: true });
  }
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-tcache-"));
  roots.push(dir);
  return dir;
}

/** Every file under `dir`, recursively, as paths relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort();
}

/**
 * A stand-in bundle large enough for Bun to cache (it skips small files), that
 * reports the cache setting it was given and exits.
 */
function fakeBundle(dir: string): { path: string; digest: string } {
  const filler = Array.from({ length: 20_000 }, (_, i) => `function f${i}(a){return a+${i}}`).join("\n");
  const src = `${filler}\nprocess.stdout.write(JSON.stringify(process.env.${TRANSPILER_CACHE_ENV} ?? null));\n`;
  const path = join(dir, "main.js");
  writeFileSync(path, src);
  return { path, digest: createHash("sha256").update(src).digest("hex") };
}

async function runFake(opts: {
  expectedDigest: string | null;
  bundle: { path: string };
  home: string;
  env?: Record<string, string>;
  warmTranspilerCache?: boolean;
}): Promise<string> {
  const saved = { HOME: process.env.HOME, [TRANSPILER_CACHE_ENV]: process.env[TRANSPILER_CACHE_ENV] };
  process.env.HOME = opts.home;
  delete process.env[TRANSPILER_CACHE_ENV];
  try {
    const engine = spawnEngine({
      bundlePath: opts.bundle.path,
      expectedDigest: opts.expectedDigest,
      sandboxId: "tcache-test",
      sandboxWsPort: 1,
      baseCodeDir: join(opts.home, "codes"),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.warmTranspilerCache ? { warmTranspilerCache: true } : {}),
    });
    let out = "";
    engine.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    const { code } = await engine.exited;
    expect(code).toBe(0);
    return out;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("a pinned engine never runs from a transpiler cache under HOME (#835)", () => {
  test("control: an unpinned spawn writes a cache entry under HOME, so the check below can see one", async () => {
    const root = scratch();
    const home = join(root, "home");
    mkdirSync(home);
    const bundle = fakeBundle(root);
    expect(await runFake({ expectedDigest: null, bundle, home })).toBe("null");
    expect(filesUnder(home).some((f) => f.endsWith(".pile"))).toBe(true);
  }, 30_000);

  test("a pinned spawn disables the cache and leaves nothing under HOME", async () => {
    const root = scratch();
    const home = join(root, "home");
    mkdirSync(home);
    const bundle = fakeBundle(root);
    expect(await runFake({ expectedDigest: bundle.digest, bundle, home })).toBe(JSON.stringify("0"));
    expect(filesUnder(home)).toEqual([]);
  }, 30_000);

  test("a caller override pointing a pinned engine at a writable directory is not honoured", async () => {
    const root = scratch();
    const home = join(root, "home");
    const cache = join(root, "tenant-cache");
    mkdirSync(home);
    mkdirSync(cache);
    const bundle = fakeBundle(root);
    const out = await runFake({ expectedDigest: bundle.digest, bundle, home, env: { [TRANSPILER_CACHE_ENV]: cache } });
    expect(out).toBe(JSON.stringify("0"));
    expect(filesUnder(cache)).toEqual([]);
  }, 30_000);

  test("the build-time warm-up still writes the cache it was pointed at", async () => {
    const root = scratch();
    const home = join(root, "home");
    const cache = join(root, "host-cache");
    mkdirSync(home);
    mkdirSync(cache);
    const bundle = fakeBundle(root);
    const out = await runFake({
      expectedDigest: bundle.digest,
      bundle,
      home,
      env: { [TRANSPILER_CACHE_ENV]: cache },
      warmTranspilerCache: true,
    });
    expect(out).toBe(JSON.stringify(cache));
    expect(filesUnder(cache).some((f) => f.endsWith(".pile"))).toBe(true);
    expect(filesUnder(home)).toEqual([]);
  }, 30_000);
});

describe("engineTranspilerCache", () => {
  const yes = () => true;
  const no = () => false;
  test("pinned: disabled unless the configured directory is protected", () => {
    expect(engineTranspilerCache(undefined, true, yes)).toBe("0");
    expect(engineTranspilerCache("", true, yes)).toBe("0");
    expect(engineTranspilerCache("0", true, yes)).toBe("0");
    expect(engineTranspilerCache("/srv/host-cache", true, no)).toBe("0");
    expect(engineTranspilerCache("/srv/host-cache", true, yes)).toBe("/srv/host-cache");
  });
  test("unpinned: left exactly as configured", () => {
    expect(engineTranspilerCache(undefined, false, no)).toBeUndefined();
    expect(engineTranspilerCache("/home/u/.cache/t", false, no)).toBe("/home/u/.cache/t");
  });
});

describe("isHostOwnedReadOnly", () => {
  const isRoot = process.getuid?.() === 0;
  const posix = process.platform !== "win32";

  /**
   * A fake filesystem: `nodes` maps a path to its owner, mode and kind, and
   * `writable` lists what this uid could write. The real one has no fixture a
   * test can rely on for the ACCEPTING case: it needs a root-owned directory of
   * root-owned regular files.
   */
  const fakeFs = (nodes: Record<string, { uid?: number; mode?: number; dir?: boolean; link?: string }>, writable: string[] = []): CacheDirProbe => ({
    lstat: (p) => {
      const n = nodes[p];
      if (!n) throw new Error(`ENOENT ${p}`);
      return { uid: n.uid ?? 0, mode: n.mode ?? 0o755, isDirectory: () => n.dir === true, isFile: () => !n.dir && !n.link };
    },
    realpath: (p) => nodes[p]?.link ?? p,
    readdir: (p) => Object.keys(nodes).filter((k) => k !== p && k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/")).map((k) => k.slice(p.length + 1)),
    writable: (p) => writable.includes(p),
  });
  const ME = 1000;
  const hostCache = () => ({
    "/": { dir: true },
    "/srv": { dir: true },
    "/srv/tcache": { dir: true, mode: 0o555 },
    "/srv/tcache/9bd3a5297ed0f6ce.pile": {},
  });

  test("a root-owned, read-only cache of root-owned files is accepted", () => {
    expect(isHostOwnedReadOnly("/srv/tcache", fakeFs(hostCache()), ME)).toBe(true);
  });

  test.each([
    ["owned by this uid", { "/srv/tcache": { dir: true, uid: ME } }, []],
    // Review finding: "not this uid" admitted a neighbouring tenant's uid.
    ["owned by another unprivileged uid", { "/srv/tcache": { dir: true, uid: 1001 } }, []],
    ["an entry owned by another unprivileged uid", { "/srv/tcache/9bd3a5297ed0f6ce.pile": { uid: 1001 } }, []],
    ["an ancestor owned by another unprivileged uid", { "/srv": { dir: true, uid: 1001 } }, []],
    ["writable by this uid", {}, ["/srv/tcache"]],
    ["an entry writable by this uid", {}, ["/srv/tcache/9bd3a5297ed0f6ce.pile"]],
    ["an ancestor writable and not sticky", {}, ["/srv"]],
    ["an entry that is a subdirectory", { "/srv/tcache/sub": { dir: true } }, []],
    ["an entry that is a symlink", { "/srv/tcache/x.pile": { link: "/home/t/x.pile" } }, []],
    ["reached through a symlink", { "/srv/tcache": { dir: true, link: "/home/t/cache" } }, []],
  ] as const)("refused: %s", (_label, over, writable) => {
    expect(isHostOwnedReadOnly("/srv/tcache", fakeFs({ ...hostCache(), ...over }, [...writable]), ME)).toBe(false);
  });

  test("a writable but sticky ancestor (like /tmp) does not by itself refuse", () => {
    const fs = fakeFs({ ...hostCache(), "/srv": { dir: true, mode: 0o1777 } }, ["/srv"]);
    expect(isHostOwnedReadOnly("/srv/tcache", fs, ME)).toBe(true);
  });

  // Review finding: `resolve()` collapsed `..` lexically, the check ran on the
  // collapsed path, and the raw value -- which the kernel resolves through
  // symlinks first -- was what got forwarded.
  test.each(["/srv/link-to-tenant/../tcache", "/srv/tcache/", "/srv/./tcache", "srv/tcache"])(
    "a path not exactly as it would be judged is refused: %s",
    (value) => {
      expect(isHostOwnedReadOnly(value, fakeFs(hostCache()), ME)).toBe(false);
    },
  );

  test("a process running as root trusts nothing", () => {
    expect(isHostOwnedReadOnly("/srv/tcache", fakeFs(hostCache()), 0)).toBe(false);
  });

  // The real filesystem, for the refusing cases it can always produce.
  test.skipIf(!posix)("a directory this uid owns is refused, even read-only", () => {
    const dir = scratch();
    expect(isHostOwnedReadOnly(dir)).toBe(false);
    chmodSync(dir, 0o555);
    expect(isHostOwnedReadOnly(dir)).toBe(false);
  });

  // A regression guard only: in a scratch dir this uid owns, the ownership
  // check refuses these before the symlink check is reached. The symlink check
  // itself is held by the fake-filesystem case "reached through a symlink".
  test.skipIf(!posix || isRoot)("a path through a real symlink in a dir this uid owns is refused", () => {
    const root = scratch();
    symlinkSync("/usr/bin", join(root, "direct"));
    symlinkSync("/usr", join(root, "parent"));
    expect(isHostOwnedReadOnly(join(root, "direct"))).toBe(false);
    expect(isHostOwnedReadOnly(join(root, "parent", "bin"))).toBe(false);
  });

  test("missing and non-directory paths are refused", () => {
    expect(isHostOwnedReadOnly(join(scratch(), "missing"))).toBe(false);
    expect(isHostOwnedReadOnly("/etc/hostname")).toBe(false);
  });
});
