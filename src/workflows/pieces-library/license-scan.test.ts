/**
 * The installed-tree scan (#971): every package on disk is decided, in every
 * layout bun writes, with the chain that put a denied one there, and the
 * notices list what shipped.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeViolations, MAX_PACKAGE_DEPTH, renderNotices, scanInstalledTree } from "./license-scan";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(): string {
  const d = mkdtempSync(join(tmpdir(), "jarvis-license-scan-"));
  made.push(d);
  return d;
}

function pkg(dir: string, json: Record<string, unknown>, files: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(json));
  for (const [n, text] of Object.entries(files)) writeFileSync(join(dir, n), text);
}

const ids = (xs: Array<{ name: string; version: string }>) => xs.map((p) => `${p.name}@${p.version}`).sort();

describe("scanInstalledTree", () => {
  test("hoisted and nested node_modules: every package is decided, denied ones carry their chain", () => {
    const root = tree();
    pkg(root, { name: "shared", private: true, dependencies: { "@activepieces/piece-a": "^1.0.0", ok: "1" } });
    const nm = join(root, "node_modules");
    pkg(join(nm, "@activepieces/piece-a"), { name: "@activepieces/piece-a", version: "1.2.0", dependencies: { mid: "1" } });
    pkg(join(nm, "mid"), { name: "mid", version: "1.0.0", license: "MIT", dependencies: { bad: "1", lgpl: "1" } });
    // Nested: a second copy of `bad` under mid, which Node resolves first.
    pkg(join(nm, "mid/node_modules/bad"), { name: "bad", version: "2.0.0", license: "AGPL-3.0-only" });
    pkg(join(nm, "bad"), { name: "bad", version: "1.0.0", license: "MIT" });
    pkg(join(nm, "lgpl"), { name: "lgpl", version: "1.0.0", license: "LGPL-3.0-or-later" });
    pkg(join(nm, "ok"), { name: "ok", version: "1.0.0", licenses: [{ type: "ISC" }] });
    pkg(join(nm, "nolicense"), { name: "nolicense", version: "0.1.0" });

    const scan = scanInstalledTree(root, { catalogPackages: new Set(["@activepieces/piece-a"]), reviewed: {} });
    expect(ids(scan.packages)).toEqual(
      ["@activepieces/piece-a@1.2.0", "bad@1.0.0", "bad@2.0.0", "lgpl@1.0.0", "mid@1.0.0", "nolicense@0.1.0", "ok@1.0.0"].sort(),
    );
    expect(ids(scan.violations)).toEqual(["bad@2.0.0", "nolicense@0.1.0"]);
    const bad = scan.violations.find((p) => p.name === "bad")!;
    expect(bad.chain).toEqual(["@activepieces/piece-a@1.2.0", "mid@1.0.0", "bad@2.0.0"]);
    expect(bad.path).toBe(join("node_modules", "mid", "node_modules", "bad"));
    // Unreachable from the root, still on disk, still checked.
    expect(scan.violations.find((p) => p.name === "nolicense")!.chain).toEqual([]);
    const lines = describeViolations(scan);
    expect(lines.some((l) => l.includes("AGPL-3.0-only") && l.includes("@activepieces/piece-a@1.2.0 > mid@1.0.0 > bad@2.0.0"))).toBe(true);
    expect(lines.some((l) => l.startsWith("nolicense@0.1.0") && l.includes("no dependency path"))).toBe(true);
  });

  test("the reviewed list clears an unlicensed release, and an unused entry is reported", () => {
    const root = tree();
    pkg(root, { name: "shared", dependencies: { nolicense: "0.1.0" } });
    pkg(join(root, "node_modules/nolicense"), { name: "nolicense", version: "0.1.0" });
    const reviewed = {
      "nolicense@0.1.0": { declared: null, license: "MIT", reason: "ships the MIT text" },
      "gone@1.0.0": { declared: null, license: "MIT", reason: "no longer installed" },
    };
    const scan = scanInstalledTree(root, { reviewed });
    expect(scan.violations).toEqual([]);
    expect(scan.unusedReviewed).toEqual(["gone@1.0.0"]);
  });

  test("bun's isolated layout: the .bun store is scanned and links are followed once", () => {
    const root = tree();
    pkg(root, { name: "shared", dependencies: { top: "1" } });
    const store = join(root, "node_modules/.bun");
    pkg(join(store, "top@1.0.0/node_modules/top"), { name: "top", version: "1.0.0", license: "MIT", dependencies: { dep: "1" } });
    pkg(join(store, "dep@1.0.0/node_modules/dep"), { name: "dep", version: "1.0.0", license: "GPL-3.0-only" });
    symlinkSync(join(store, "dep@1.0.0/node_modules/dep"), join(store, "top@1.0.0/node_modules/dep"));
    symlinkSync(join(store, "top@1.0.0/node_modules/top"), join(root, "node_modules/top"));

    const scan = scanInstalledTree(root, { reviewed: {} });
    expect(ids(scan.packages)).toEqual(["dep@1.0.0", "top@1.0.0"]);
    expect(scan.violations.map((p) => p.chain)).toEqual([["top@1.0.0", "dep@1.0.0"]]);
  });

  test("a link out of the tree is a problem, not a package to trust", () => {
    const root = tree();
    const outside = tree();
    pkg(outside, { name: "elsewhere", version: "1.0.0", license: "MIT" });
    pkg(root, { name: "shared", dependencies: { elsewhere: "1" } });
    mkdirSync(join(root, "node_modules"));
    symlinkSync(outside, join(root, "node_modules/elsewhere"));
    const scan = scanInstalledTree(root, { reviewed: {} });
    expect(scan.packages).toEqual([]);
    expect(scan.errors.length).toBe(1);
    expect(scan.errors[0]).toContain("links outside the tree");
    expect(describeViolations(scan)).toEqual(scan.errors);
  });

  test("a link cycle through directories that are not packages ends", () => {
    const root = tree();
    pkg(join(root, "node_modules/a"), { name: "a", version: "1.0.0", license: "MIT" });
    mkdirSync(join(root, "node_modules/hollow/node_modules"), { recursive: true });
    symlinkSync(join(root, "node_modules/hollow"), join(root, "node_modules/hollow/node_modules/loop"));
    const scan = scanInstalledTree(root, { reviewed: {} });
    expect(ids(scan.packages)).toEqual(["a@1.0.0"]);
  });

  test("a node_modules that is a link is a problem, at the root or inside a package", () => {
    const root = tree();
    const outside = tree();
    pkg(join(outside, "gpl"), { name: "gpl", version: "1.0.0", license: "GPL-3.0-only" });
    symlinkSync(outside, join(root, "node_modules"));
    let scan = scanInstalledTree(root, { reviewed: {} });
    expect(scan.packages).toEqual([]);
    expect(scan.errors.some((e) => e.includes("is a link"))).toBe(true);

    const root2 = tree();
    pkg(join(root2, "node_modules/a"), { name: "a", version: "1.0.0", license: "MIT" });
    symlinkSync(outside, join(root2, "node_modules/a/node_modules"));
    scan = scanInstalledTree(root2, { reviewed: {} });
    expect(scan.errors.some((e) => e.includes(join("a", "node_modules")) && e.includes("is a link"))).toBe(true);
  });

  test("a .bun store that is a link, a scope that is a link, and a hidden directory are problems", () => {
    const root = tree();
    const outside = tree();
    mkdirSync(join(root, "node_modules"));
    symlinkSync(outside, join(root, "node_modules/.bun"));
    symlinkSync(outside, join(root, "node_modules/@scope"));
    mkdirSync(join(root, "node_modules/.hidden/x"), { recursive: true });
    mkdirSync(join(root, "node_modules/.bin"));
    const scan = scanInstalledTree(root, { reviewed: {} });
    expect(scan.errors.some((e) => e.includes(".bun is not a directory"))).toBe(true);
    expect(scan.errors.some((e) => e.includes("@scope is a link"))).toBe(true);
    expect(scan.errors.some((e) => e.includes(".hidden is a hidden directory"))).toBe(true);
    expect(scan.errors.some((e) => e.includes(".bin"))).toBe(false);
  });

  test("a node_modules a package ships below its root is scanned, with no upstream presumption", () => {
    const root = tree();
    pkg(root, { name: "shared", dependencies: { carrier: "1" } });
    pkg(join(root, "node_modules/carrier"), { name: "carrier", version: "1.0.0", license: "MIT" });
    pkg(join(root, "node_modules/carrier/lib/node_modules/gpl"), { name: "gpl", version: "1.0.0", license: "GPL-3.0-only" });
    pkg(join(root, "node_modules/carrier/cli/node_modules/@activepieces/shared"), { name: "@activepieces/shared", version: "1.0.0" });
    const scan = scanInstalledTree(root, { reviewed: {} });
    expect(ids(scan.violations)).toEqual(["@activepieces/shared@1.0.0", "gpl@1.0.0"]);
    expect(scan.violations.find((p) => p.name === "gpl")!.chain).toEqual(["carrier@1.0.0", "gpl@1.0.0 (bundled)"]);
  });

  test("a node_modules that is a link below a package root is a problem", () => {
    const root = tree();
    pkg(join(root, "node_modules/a"), { name: "a", version: "1.0.0", license: "MIT" });
    pkg(join(root, "node_modules/a/hidden/gpl"), { name: "gpl", version: "1.0.0", license: "GPL-3.0-only" });
    mkdirSync(join(root, "node_modules/a/lib"));
    symlinkSync(join(root, "node_modules/a/hidden"), join(root, "node_modules/a/lib/node_modules"));
    const scan = scanInstalledTree(root, { reviewed: {} });
    expect(scan.errors.some((e) => e.includes(join("a", "lib", "node_modules")) && e.includes("is a link"))).toBe(true);
  });

  test("bundleDependencies are bundled copies: no bun.lock entry needed, no upstream presumption", () => {
    const root = tree();
    pkg(root, { name: "shared", dependencies: { a: "1" } });
    pkg(join(root, "node_modules/a"), { name: "a", version: "1.0.0", license: "MIT", bundleDependencies: ["@activepieces/shared", "plain"] });
    pkg(join(root, "node_modules/a/node_modules/@activepieces/shared"), { name: "@activepieces/shared", version: "1.0.0" });
    pkg(join(root, "node_modules/a/node_modules/plain"), { name: "plain", version: "1.0.0", license: "MIT" });
    writeFileSync(join(root, "bun.lock"), '{"lockfileVersion":1,"packages":{"a":["a@1.0.0","",{},"sha512-x"],},}');
    const scan = scanInstalledTree(root, { reviewed: {} });
    expect(scan.errors).toEqual([]);
    expect(ids(scan.violations)).toEqual(["@activepieces/shared@1.0.0"]);
    expect(scan.violations[0]!.chain).toEqual(["a@1.0.0", "@activepieces/shared@1.0.0 (bundled)"]);
  });

  test("a reviewed bundled copy is bound to its carrier and path", () => {
    const root = tree();
    pkg(join(root, "node_modules/protobufjs"), { name: "protobufjs", version: "6.11.6", license: "BSD-3-Clause" });
    pkg(join(root, "node_modules/protobufjs/cli/node_modules/taffydb"), { name: "taffydb", version: "2.6.2" });
    pkg(join(root, "node_modules/evil"), { name: "evil", version: "1.0.0", license: "MIT" });
    pkg(join(root, "node_modules/evil/lib/node_modules/taffydb"), { name: "taffydb", version: "2.6.2" });
    const reviewed = {
      "taffydb@2.6.2": { declared: null, license: "BSD-1-Clause", reason: "r", bundledAt: "protobufjs@6.11.6:cli/node_modules/taffydb" },
    };
    const scan = scanInstalledTree(root, { reviewed });
    expect(scan.violations.map((p) => p.path)).toEqual([join("node_modules", "evil", "lib", "node_modules", "taffydb")]);
  });

  test("a package nested past the depth limit says what happened and what to do", () => {
    const root = tree();
    pkg(join(root, "node_modules/deep"), { name: "deep", version: "1.0.0", license: "MIT" });
    const parts = Array.from({ length: MAX_PACKAGE_DEPTH + 2 }, (_, i) => `d${i}`);
    mkdirSync(join(root, "node_modules/deep", ...parts), { recursive: true });
    const scan = scanInstalledTree(root, { reviewed: {} });
    expect(scan.errors).toHaveLength(1);
    expect(scan.errors[0]).toContain(`more than ${MAX_PACKAGE_DEPTH} directories below its package root`);
    expect(scan.errors[0]).toContain("raise MAX_PACKAGE_DEPTH in license-scan.ts, otherwise leave its piece out with SHARED_BUILD_EXCLUDED");
  });

  test("isolated layout: a store entry bun.lock does not resolve is a problem", () => {
    const root = tree();
    pkg(root, { name: "shared", dependencies: { top: "1" } });
    const store = join(root, "node_modules/.bun");
    pkg(join(store, "top@1.0.0/node_modules/top"), { name: "top", version: "1.0.0", license: "MIT" });
    pkg(join(store, "ghost@2.0.0/node_modules/ghost"), { name: "ghost", version: "2.0.0", license: "MIT" });
    writeFileSync(join(root, "bun.lock"), '{"lockfileVersion":1,"packages":{"top":["top@1.0.0","",{},"sha512-x"],},}');
    const scan = scanInstalledTree(root, { reviewed: {} });
    expect(scan.errors).toEqual([join("node_modules", ".bun", "ghost@2.0.0", "node_modules", "ghost") + " is ghost@2.0.0, which bun.lock does not resolve"]);
    expect(ids(scan.packages)).toEqual(["top@1.0.0"]);
  });

  test("an alias is a problem for a bundled copy and in a tree with no bun.lock", () => {
    const root = tree();
    pkg(join(root, "node_modules/carrier"), { name: "carrier", version: "1.0.0", license: "MIT" });
    pkg(join(root, "node_modules/carrier/lib/node_modules/sw-cjs"), { name: "string-width", version: "4.2.3", license: "MIT" });
    pkg(join(root, "node_modules/sw-cjs"), { name: "string-width", version: "4.2.3", license: "MIT" });
    // No bun.lock: nothing vouches for either alias.
    let scan = scanInstalledTree(root, { reviewed: {} });
    expect(scan.errors.filter((e) => e.includes("claims to be string-width, but bun installed it as sw-cjs"))).toHaveLength(2);
    // With one: the top-level alias is what the lock resolved, the bundled one still is not vouched for.
    writeFileSync(
      join(root, "bun.lock"),
      '{"lockfileVersion":1,"packages":{"carrier":["carrier@1.0.0","",{},"sha512-x"],"sw-cjs":["string-width@4.2.3","",{},"sha512-x"],},}',
    );
    scan = scanInstalledTree(root, { reviewed: {} });
    expect(scan.errors).toEqual([join("node_modules", "carrier", "lib", "node_modules", "sw-cjs") + " claims to be string-width, but bun installed it as sw-cjs"]);
  });

  test("a package whose directory and name disagree, or with no valid name or version, is a problem", () => {
    const root = tree();
    pkg(join(root, "node_modules/evil"), { name: "@activepieces/shared", version: "1.0.0" });
    pkg(join(root, "node_modules/badname"), { name: "bad\nname", version: "1.0.0", license: "MIT" });
    pkg(join(root, "node_modules/badver"), { name: "badver", version: "1.0.0\n::x", license: "MIT" });
    const scan = scanInstalledTree(root, { reviewed: {} });
    expect(scan.packages).toEqual([]);
    expect(scan.errors.some((e) => e.includes("claims to be @activepieces/shared, but bun installed it as evil"))).toBe(true);
    expect(scan.errors.filter((e) => e.includes("no valid npm name and semver version"))).toHaveLength(2);
  });

  test("a package.json that is a link, or too large, is a problem", () => {
    const root = tree();
    const outside = tree();
    writeFileSync(join(outside, "p.json"), JSON.stringify({ name: "linked", version: "1.0.0", license: "MIT" }));
    mkdirSync(join(root, "node_modules/linked"), { recursive: true });
    symlinkSync(join(outside, "p.json"), join(root, "node_modules/linked/package.json"));
    mkdirSync(join(root, "node_modules/huge"), { recursive: true });
    writeFileSync(join(root, "node_modules/huge/package.json"), JSON.stringify({ name: "huge", version: "1.0.0", license: "MIT", pad: "x".repeat(5 * 1024 * 1024) }));
    const scan = scanInstalledTree(root, { reviewed: {} });
    expect(scan.packages).toEqual([]);
    expect(scan.errors.filter((e) => e.includes("is unreadable: not a regular file of sane size"))).toHaveLength(2);
  });

  test("an unreadable package.json is a problem", () => {
    const root = tree();
    mkdirSync(join(root, "node_modules/broken"), { recursive: true });
    writeFileSync(join(root, "node_modules/broken/package.json"), "{nope");
    const scan = scanInstalledTree(root, { reviewed: {} });
    expect(scan.errors.some((e) => e.includes("broken/package.json is unreadable"))).toBe(true);
  });
});

describe("renderNotices", () => {
  test("lists every allowed release once, weak copyleft on its own, and the license texts", () => {
    const root = tree();
    pkg(root, { name: "shared", dependencies: { a: "1", lgpl: "1" } });
    const nm = join(root, "node_modules");
    pkg(join(nm, "a"), { name: "a", version: "1.0.0", license: "MIT" }, { LICENSE: "MIT License\n\nCopyright (c) A\n" });
    pkg(join(nm, "a/node_modules/a"), { name: "a", version: "1.0.0", license: "MIT" }, { LICENSE: "MIT License\n\nCopyright (c) A\n" });
    pkg(join(nm, "lgpl"), { name: "lgpl", version: "2.0.0", license: "LGPL-3.0+" }, { "COPYING.LESSER": "GNU LESSER ```" });
    const scan = scanInstalledTree(root, { reviewed: {} });
    const text = renderNotices(root, scan, "Notices");

    const weak = text.slice(text.indexOf("## Weak-copyleft"), text.indexOf("## All packages"));
    expect(weak).toContain("- lgpl@2.0.0 -- LGPL-3.0+");
    expect(weak).not.toContain("a@1.0.0");
    expect(text.match(/^- a@1\.0\.0 -- MIT$/gm)?.length).toBe(1);
    expect(text).toContain("Copyright (c) A");
    // A backtick run in a license file cannot close the fence around it.
    expect(text).toContain("````\nGNU LESSER ```\n````");
  });

  test("a license file that is a link is not read into the notices", () => {
    const root = tree();
    const outside = tree();
    writeFileSync(join(outside, "secret"), "HOST SECRET");
    pkg(join(root, "node_modules/a"), { name: "a", version: "1.0.0", license: "MIT" });
    symlinkSync(join(outside, "secret"), join(root, "node_modules/a/LICENSE"));
    const text = renderNotices(root, scanInstalledTree(root, { reviewed: {} }), "Notices");
    expect(text).toContain("- a@1.0.0 -- MIT");
    expect(text).not.toContain("HOST SECRET");
  });

  test("a license file left out is said to be left out", () => {
    const root = tree();
    const files: Record<string, string> = { LICENSE: "x".repeat(300 * 1024) };
    for (let i = 0; i < 9; i++) files[`LICENSE-${i}`] = `text ${i}`;
    pkg(join(root, "node_modules/a"), { name: "a", version: "1.0.0", license: "MIT" }, files);
    const text = renderNotices(root, scanInstalledTree(root, { reviewed: {} }), "Notices");
    expect(text).toMatch(/LICENSE:\n\n`+\n\(not reproduced: \d+ bytes, over 262144\)/);
    expect(text).toContain("LICENSE-8:");
    expect(text).toContain("(not reproduced: more than 8 license files in this package)");
  });

  test("a denied package is not listed as shipped", () => {
    const root = tree();
    pkg(join(root, "node_modules/bad"), { name: "bad", version: "1.0.0", license: "GPL-3.0-only" });
    const text = renderNotices(root, scanInstalledTree(root, { reviewed: {} }), "Notices");
    expect(text).not.toContain("bad@1.0.0");
  });
});
