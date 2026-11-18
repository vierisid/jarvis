import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sealViolations, sharedBuildPhase, type SealProbe } from "./shared-build-phases";

describe("sharedBuildPhase (#862)", () => {
  const argv = (...flags: string[]) => ["bun", "build-shared-runtime.ts", "--out", "/o", ...flags];

  test("no phase flag is the one pass, and each phase flag picks its run", () => {
    expect(sharedBuildPhase(argv())).toEqual({ phase: "all" });
    expect(sharedBuildPhase(argv("--install-only", "--seed-lock", "/l", "--digest-fd", "3"))).toEqual({ phase: "install" });
    expect(sharedBuildPhase(argv("--extract-only", "--from", "/sealed"))).toEqual({ phase: "extract" });
  });

  test("flags that do not fit the run are refused, not ignored", () => {
    const errorOf = (...flags: string[]) => {
      const r = sharedBuildPhase(argv(...flags));
      return "error" in r ? r.error : null;
    };
    expect(errorOf("--install-only", "--extract-only", "--from", "/s")).toContain("pass one");
    expect(errorOf("--extract-only")).toContain("needs --from");
    expect(errorOf("--extract-only", "--from", "/s", "--seed-lock", "/l")).toContain("--seed-lock");
    expect(errorOf("--extract-only", "--from", "/s", "--digest-fd", "3")).toContain("--digest-fd");
    expect(errorOf("--from", "/s")).toContain("only read by --extract-only");
    expect(errorOf("--install-only", "--from", "/s")).toContain("only read by --extract-only");
  });
});

/** An in-memory tree: path -> { uid, mode, kind, writable }. */
function fakeTree(entries: Record<string, { uid?: number; mode?: number; kind?: "dir" | "file" | "link"; writable?: boolean }>): SealProbe {
  const at = (path: string) => {
    const e = entries[path];
    if (!e) throw new Error(`ENOENT ${path}`);
    return e;
  };
  return {
    lstat: (path) => {
      const e = at(path);
      const kind = e.kind ?? "dir";
      return { uid: e.uid ?? 0, mode: e.mode ?? 0o755, isDirectory: () => kind === "dir", isSymbolicLink: () => kind === "link" };
    },
    readdir: (path) => {
      at(path);
      const prefix = path === "/" ? "/" : path + "/";
      return Object.keys(entries)
        .filter((p) => p.startsWith(prefix) && p.length > prefix.length && !p.slice(prefix.length).includes("/"))
        .map((p) => p.slice(prefix.length));
    },
    writable: (path) => at(path).writable ?? false,
  };
}

const SEALED = {
  "/": {},
  "/var": {},
  "/var/tmp": { mode: 0o1777, writable: true },
  "/var/tmp/s": {},
  "/var/tmp/s/out": {},
  "/var/tmp/s/out/pieces": {},
  "/var/tmp/s/out/pieces/package.json": { kind: "file" as const, mode: 0o644 },
  "/var/tmp/s/out/pieces/node_modules": {},
  "/var/tmp/s/out/pieces/node_modules/.bin": {},
  "/var/tmp/s/out/pieces/node_modules/.bin/x": { kind: "link" as const, mode: 0o777 },
};

describe("sealViolations (#862)", () => {
  const ROOT = ["/var/tmp/s/out/pieces"];

  test("a root-owned tree nothing here can write is sealed, under a sticky world-writable ancestor", () => {
    expect(sealViolations(ROOT, 1001, fakeTree(SEALED))).toEqual([]);
  });

  test("an entry this uid, or any account but root, owns is not sealed", () => {
    for (const uid of [1001, 1002]) {
      const tree = fakeTree({ ...SEALED, "/var/tmp/s/out/pieces/node_modules": { uid } });
      expect(sealViolations(ROOT, 1001, tree)).toEqual([`/var/tmp/s/out/pieces/node_modules: owned by uid ${uid}, not root`]);
    }
  });

  test("a root-owned entry this process can still write is not sealed", () => {
    const tree = fakeTree({ ...SEALED, "/var/tmp/s/out/pieces/package.json": { kind: "file", writable: true } });
    expect(sealViolations(ROOT, 1001, tree)).toEqual(["/var/tmp/s/out/pieces/package.json: writable by this process"]);
  });

  test("a link is judged by its owner, not by what it points at", () => {
    const tree = fakeTree({ ...SEALED, "/var/tmp/s/out/pieces/node_modules/.bin/x": { kind: "link", uid: 1001 } });
    expect(sealViolations(ROOT, 1001, tree)).toHaveLength(1);
    // Root's link: link modes are always 0777 and mean nothing, so no finding.
    expect(sealViolations(ROOT, 1001, fakeTree(SEALED))).toEqual([]);
  });

  test("an ancestor that could rename the tree away is not sealed, unless sticky and root's", () => {
    const writableParent = fakeTree({ ...SEALED, "/var/tmp/s": { writable: true } });
    expect(sealViolations(ROOT, 1001, writableParent)[0]).toContain("/var/tmp/s: an ancestor");
    const foreignParent = fakeTree({ ...SEALED, "/var/tmp/s": { uid: 1001 } });
    expect(sealViolations(ROOT, 1001, foreignParent)[0]).toContain("owned by uid 1001");
  });

  test("root itself, a missing tree and a file in place of the tree all refuse", () => {
    expect(sealViolations(ROOT, 0, fakeTree(SEALED))[0]).toContain("running as root");
    expect(sealViolations(["/var/tmp/s/out/engine"], 1001, fakeTree(SEALED))[0]).toContain("cannot be read");
    expect(sealViolations(["/var/tmp/s/out/pieces/package.json"], 1001, fakeTree(SEALED))[0]).toContain("is not a directory");
  });

  test("stops at the limit", () => {
    const many: Parameters<typeof fakeTree>[0] = { ...SEALED };
    for (let i = 0; i < 20; i++) many[`/var/tmp/s/out/pieces/f${i}`] = { uid: 1001, kind: "file" };
    expect(sealViolations(ROOT, 1001, fakeTree(many), 3)).toHaveLength(3);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a real tree this uid owns is not sealed", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-seal-"));
    try {
      mkdirSync(join(dir, "pieces"));
      const found = sealViolations([join(dir, "pieces")]);
      expect(found.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scripts/build-shared-runtime.ts phases (#862)", () => {
  const script = resolve(import.meta.dir, "../../../../scripts/build-shared-runtime.ts");
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--no-env-file", script, ...args], { encoding: "utf8", timeout: 60_000 });

  // The script's imports alone take a few seconds on a cold machine.
  test("refuses flags that do not fit together before doing anything", () => {
    const r = run("--out", "/nonexistent/out", "--install-only", "--extract-only", "--from", "/x");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("pass one");
  }, 60_000);

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "--extract-only refuses a tree this uid can write, before it writes or runs anything",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "jarvis-extract-"));
      made.push(dir);
      mkdirSync(join(dir, "from", "engine"), { recursive: true });
      mkdirSync(join(dir, "from", "pieces"), { recursive: true });
      writeFileSync(join(dir, "from", "pieces", "package.json"), "{}");
      const out = join(dir, "out");
      const r = run("--extract-only", "--from", join(dir, "from"), "--out", out);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("REFUSING to extract");
      expect(r.stderr).toContain("not sealed");
      expect(existsSync(out)).toBe(false);
    },
    60_000,
  );
});
