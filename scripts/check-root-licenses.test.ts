/**
 * #1166: the brain's own install is held to the license policy, like the
 * hosted pieces tree, self-managed piece installs and the engine staging
 * install. Dev dependencies count: the Docker image ships the whole
 * node_modules.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkRootLicenses, KNOWN_ROOT_VIOLATIONS } from "./check-root-licenses";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function pkg(dir: string, json: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(json));
}

/** A repo-shaped tree: `prod` -> `deep` in dependencies, `devtool` in devDependencies only. */
function repo(licenses: { deep?: string; devtool?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-root-licenses-"));
  made.push(root);
  pkg(root, { name: "brain", version: "0.0.0", dependencies: { prod: "1" }, devDependencies: { devtool: "1" } });
  const nm = join(root, "node_modules");
  pkg(join(nm, "prod"), { name: "prod", version: "1.0.0", license: "MIT", dependencies: { deep: "1" } });
  pkg(join(nm, "deep"), { name: "deep", version: "1.0.0", license: licenses.deep ?? "MIT" });
  pkg(join(nm, "devtool"), { name: "devtool", version: "1.0.0", license: licenses.devtool ?? "MIT" });
  writeFileSync(
    join(root, "bun.lock"),
    '{"lockfileVersion":1,"packages":{"prod":["prod@1.0.0","",{},"sha512-x"],"deep":["deep@1.0.0","",{},"sha512-x"],"devtool":["devtool@1.0.0","",{},"sha512-x"],},}',
  );
  return root;
}

const none = {};
const catalog = new Set<string>();

describe("checkRootLicenses", () => {
  test("a clean tree passes and counts every installed package", () => {
    const r = checkRootLicenses(repo(), { known: none, catalogPackages: catalog });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.packages).toBe(3);
  });

  test("a denied package a production dependency reaches fails, with its chain", () => {
    const r = checkRootLicenses(repo({ deep: "GPL-3.0-only" }), { known: none, catalogPackages: catalog });
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("deep@1.0.0");
    expect(r.problems[0]).toContain("via prod@1.0.0 > deep@1.0.0");
  });

  test("a denied dev dependency fails too: the Docker image ships it", () => {
    const r = checkRootLicenses(repo({ devtool: "AGPL-3.0-only" }), { known: none, catalogPackages: catalog });
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("devtool@1.0.0");
  });

  test("a tree that is not installed cannot pass as clean", () => {
    const root = repo();
    rmSync(join(root, "node_modules"), { recursive: true });
    const r = checkRootLicenses(root, { known: none, catalogPackages: catalog });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      "prod is a dependency of the root package.json but is not installed",
      "devtool is a dependency of the root package.json but is not installed",
    ]);
  });

  test("a missing transitive dependency fails", () => {
    const root = repo();
    rmSync(join(root, "node_modules", "deep"), { recursive: true });
    const r = checkRootLicenses(root, { known: none, catalogPackages: catalog });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(["deep is a dependency of prod@1.0.0 but is not installed"]);
  });

  test("a known violation is reported, not failed, while it matches exactly", () => {
    const known = { "deep@1.0.0": { license: "AGPL-3.0", reason: "pending" } };
    const r = checkRootLicenses(repo({ deep: "AGPL-3.0" }), { known, catalogPackages: catalog });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.known).toHaveLength(1);
    expect(r.known[0]).toContain("deep@1.0.0");
  });

  test("a known violation whose declared license changed fails", () => {
    const known = { "deep@1.0.0": { license: "AGPL-3.0", reason: "pending" } };
    const r = checkRootLicenses(repo({ deep: "SSPL-1.0" }), { known, catalogPackages: catalog });
    expect(r.ok).toBe(false);
    expect(r.problems.some((l) => l.startsWith("deep@1.0.0"))).toBe(true);
  });

  test("a known violation that matches nothing any more fails, so the list cannot go stale", () => {
    const known = { "deep@1.0.0": { license: "AGPL-3.0", reason: "pending" } };
    const r = checkRootLicenses(repo(), { known, catalogPackages: catalog });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      "KNOWN_ROOT_VIOLATIONS lists deep@1.0.0, but no installed package matches it any more: remove the entry",
    ]);
  });

  test("a tree with no bun.lock cannot be vouched for", () => {
    const root = repo();
    rmSync(join(root, "bun.lock"));
    const r = checkRootLicenses(root, { known: none, catalogPackages: catalog });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("bun.lock");
  });
});

describe("the repository's own production dependencies", () => {
  test("pass the license policy, apart from the listed known violations", () => {
    const r = checkRootLicenses(resolve(import.meta.dir, ".."));
    expect(r.problems).toEqual([]);
    expect(r.known).toHaveLength(Object.keys(KNOWN_ROOT_VIOLATIONS).length);
  });
});
