/**
 * The hosted shared build's license gate (#971): a denied package fails the
 * build before any piece runs, a passing tree gets its notices, and the build
 * installs exactly the shared-build catalog.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CATALOG, sharedBuildCatalog, sharedBuildExclusions, type CatalogEntry } from "./catalog";
import { EXCLUDED, SHARED_BUILD_EXCLUDED } from "./catalog-overrides";
import { checkSharedTreeLicenses, PROBLEMS_MAX_LINE_CHARS, PROBLEMS_MAX_LINES, problemsFileText, sharedPiecesPackageJson } from "./shared-build";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function pkg(dir: string, json: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(json));
}

const entry = (npmPackage: string): CatalogEntry =>
  ({ id: npmPackage.replace(/^@activepieces\/piece-/, ""), npmPackage, versionRange: "^1.0.0" }) as CatalogEntry;

/** A bun.lock as bun writes it (trailing commas included): key -> [resolution, registry, info, integrity]. */
function lockFile(dir: string, packages: Record<string, string>): void {
  const rows = Object.entries(packages).map(([k, v]) => `    "${k}": ["${v}", "", {}, "sha512-x"],`);
  writeFileSync(join(dir, "bun.lock"), `{\n  "lockfileVersion": 1,\n  "packages": {\n${rows.join("\n")}\n  },\n}\n`);
}

function sharedTree(depLicense: string): { dir: string; catalog: CatalogEntry[] } {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-shared-licenses-"));
  made.push(dir);
  const catalog = [entry("@activepieces/piece-a")];
  writeFileSync(join(dir, "package.json"), sharedPiecesPackageJson(catalog));
  pkg(join(dir, "node_modules/@activepieces/piece-a"), { name: "@activepieces/piece-a", version: "1.0.0", dependencies: { dep: "1" } });
  pkg(join(dir, "node_modules/dep"), { name: "dep", version: "1.0.0", license: depLicense });
  lockFile(dir, { "@activepieces/piece-a": "@activepieces/piece-a@1.0.0", dep: "dep@1.0.0" });
  return { dir, catalog };
}

describe("checkSharedTreeLicenses", () => {
  test("a denied dependency fails the tree, names the chain, and renders no notices", () => {
    const { dir, catalog } = sharedTree("AGPL-3.0-or-later");
    const r = checkSharedTreeLicenses(dir, catalog);
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("dep@1.0.0");
    expect(r.problems[0]).toContain("@activepieces/piece-a@1.0.0 > dep@1.0.0");
    expect(r.notices).toBeNull();
  });

  test("an LGPL dependency passes and is named in the notices and the result", () => {
    const { dir, catalog } = sharedTree("LGPL-3.0-only");
    const r = checkSharedTreeLicenses(dir, catalog);
    expect(r.ok).toBe(true);
    expect(r.weakCopyleft).toEqual(["dep@1.0.0 (LGPL-3.0-only)"]);
    const text = r.notices!;
    expect(text.slice(text.indexOf("## Weak-copyleft"), text.indexOf("## All packages"))).toContain("dep@1.0.0 -- LGPL-3.0-only");
    // The catalog piece, published with no license field, ships as upstream
    // MIT, and that license text is in the notices once.
    expect(text).toContain("- @activepieces/piece-a@1.0.0 -- MIT (catalog piece");
    expect(text).toContain("## Activepieces monorepo license");
    expect(text).toContain("Copyright (c) 2020-2024 Activepieces Inc.");
    expect(text).toContain("The above copyright notice and this permission notice shall be included");
  });

  test("a tree with no bun.lock fails: nothing ties a package to what bun resolved", () => {
    const { dir, catalog } = sharedTree("MIT");
    rmSync(join(dir, "bun.lock"));
    const r = checkSharedTreeLicenses(dir, catalog);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes("bun.lock is missing"))).toBe(true);
  });

  test("a dependency calling itself @activepieces/shared does not get upstream MIT", () => {
    const { dir, catalog } = sharedTree("MIT");
    // Installed as `evil`, claiming the Activepieces name, with no license.
    pkg(join(dir, "node_modules/evil"), { name: "@activepieces/shared", version: "0.0.1" });
    const r = checkSharedTreeLicenses(dir, catalog);
    expect(r.ok).toBe(false);
    // Refused as an identity problem: bun.lock does not vouch for the claim.
    expect(r.problems).toEqual(["node_modules/evil claims to be @activepieces/shared@0.0.1 under the name evil, but bun.lock resolves evil to nothing"]);
  });

  test("an npm alias in the Activepieces name's place is caught by bun.lock", () => {
    const { dir, catalog } = sharedTree("MIT");
    // `"@activepieces/shared": "npm:evil@1.0.0"`: the right directory, a
    // package.json that claims the name, and a lock that says what it is.
    pkg(join(dir, "node_modules/@activepieces/shared"), { name: "@activepieces/shared", version: "1.0.0" });
    lockFile(dir, {
      "@activepieces/piece-a": "@activepieces/piece-a@1.0.0",
      dep: "dep@1.0.0",
      "@activepieces/shared": "evil@1.0.0",
    });
    const r = checkSharedTreeLicenses(dir, catalog);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes("bun.lock resolves @activepieces/shared to evil@1.0.0"))).toBe(true);
  });

  test("a legitimate npm alias passes, judged under its real name (glob>=10 via @isaacs/cliui)", () => {
    const { dir, catalog } = sharedTree("MIT");
    // `"string-width-cjs": "npm:string-width@^4.2.0"`: bun installs it under
    // the alias, its package.json and bun.lock both say string-width.
    pkg(join(dir, "node_modules/string-width-cjs"), { name: "string-width", version: "4.2.3", license: "MIT" });
    pkg(join(dir, "node_modules/agpl-cjs"), { name: "agpl-real", version: "1.0.0", license: "AGPL-3.0-only" });
    lockFile(dir, {
      "@activepieces/piece-a": "@activepieces/piece-a@1.0.0",
      dep: "dep@1.0.0",
      "string-width-cjs": "string-width@4.2.3",
      "agpl-cjs": "agpl-real@1.0.0",
    });
    const r = checkSharedTreeLicenses(dir, catalog);
    expect(r.problems.filter((p) => p.includes("string-width"))).toEqual([]);
    // An alias does not launder a license: the real package is judged.
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("agpl-real@1.0.0 at node_modules/agpl-cjs -- AGPL-3.0-only");
  });

  test("an alias whose real name is an Activepieces one gets no upstream MIT through the alias directory", () => {
    const { dir, catalog } = sharedTree("MIT");
    // Installed under the Activepieces name, but really `evil`: judged as evil.
    pkg(join(dir, "node_modules/@activepieces/shared"), { name: "evil", version: "1.0.0" });
    lockFile(dir, {
      "@activepieces/piece-a": "@activepieces/piece-a@1.0.0",
      dep: "dep@1.0.0",
      "@activepieces/shared": "evil@1.0.0",
    });
    const r = checkSharedTreeLicenses(dir, catalog);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.startsWith("evil@1.0.0 at node_modules/@activepieces/shared -- (none): no license declared"))).toBe(true);
  });

  test("a piece the catalog lists but the tree lacks fails, and so does an empty tree", () => {
    const { dir, catalog } = sharedTree("MIT");
    const r = checkSharedTreeLicenses(dir, [...catalog, entry("@activepieces/piece-missing")]);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.startsWith("@activepieces/piece-missing was to be installed"))).toBe(true);
    rmSync(join(dir, "node_modules"), { recursive: true });
    expect(checkSharedTreeLicenses(dir, catalog).ok).toBe(false);
  });

  test("problem lines carry no newline or workflow command from a license field", () => {
    const { dir, catalog } = sharedTree("GPL-3.0\n::warning title=x::forged");
    const r = checkSharedTreeLicenses(dir, catalog);
    expect(r.ok).toBe(false);
    for (const p of r.problems) {
      expect(p).not.toContain("\n");
      expect(p).not.toContain("::");
    }
  });

  test("only an empty catalog (--pieces 0) may skip bun.lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-shared-empty-"));
    made.push(dir);
    writeFileSync(join(dir, "package.json"), sharedPiecesPackageJson([]));
    mkdirSync(join(dir, "node_modules"));
    expect(checkSharedTreeLicenses(dir, []).ok).toBe(false);
    expect(checkSharedTreeLicenses(dir, [], { lockfile: "if-present" }).ok).toBe(true);
    const { dir: real, catalog } = sharedTree("MIT");
    rmSync(join(real, "bun.lock"));
    expect(() => checkSharedTreeLicenses(real, catalog, { lockfile: "if-present" })).toThrow(/only be relaxed for an empty catalog/);
  });

  test("a piece the tree holds but the catalog does not list gets no upstream MIT", () => {
    const { dir } = sharedTree("MIT");
    expect(checkSharedTreeLicenses(dir, []).ok).toBe(false);
  });
});

describe("problemsFileText (the catalog PR body section)", () => {
  test("one line per problem, empty when there are none", () => {
    expect(problemsFileText([])).toBe("");
    expect(problemsFileText(["a", "b"])).toBe("a\nb\n");
  });

  test("drops line separators and bidi controls", () => {
    const bad = "x\u2028y\u2029z\u202ereversed\u2066i\u2069\u200f";
    expect(problemsFileText([bad])).toBe("xyzreversedi\n");
  });

  test("caps each line and the number of lines, so the verdict below is never cut off", () => {
    const long = "p".repeat(PROBLEMS_MAX_LINE_CHARS * 3);
    const out = problemsFileText([long]).trimEnd();
    expect(out.length).toBe(PROBLEMS_MAX_LINE_CHARS);
    expect(out.endsWith("...")).toBe(true);
    const many = Array.from({ length: 700 }, (_, i) => `problem ${i} ` + "q".repeat(1000));
    const lines = problemsFileText(many).trimEnd().split("\n");
    expect(lines.length).toBe(PROBLEMS_MAX_LINES);
    expect(lines.at(-1)).toBe(`... and ${700 - (PROBLEMS_MAX_LINES - 1)} more problem(s); see the licenses job in the run`);
    expect(lines.every((l) => l.length <= PROBLEMS_MAX_LINE_CHARS)).toBe(true);
    expect(problemsFileText(many).length).toBeLessThan(20_000);
    // Exactly the cap is not truncated.
    expect(problemsFileText(many.slice(0, PROBLEMS_MAX_LINES)).trimEnd().split("\n").length).toBe(PROBLEMS_MAX_LINES);
    expect(problemsFileText(many.slice(0, PROBLEMS_MAX_LINES))).not.toContain("more problem(s)");
  });
});

describe("the shared-build catalog", () => {
  test("every exclusion names a real catalog piece and says why", () => {
    const ids = new Set(CATALOG.map((e) => e.id));
    for (const [id, reason] of Object.entries(SHARED_BUILD_EXCLUDED)) {
      expect({ id, inCatalog: ids.has(id) }).toEqual({ id, inCatalog: true });
      expect(reason.trim().length).toBeGreaterThan(20);
    }
  });

  test("is the catalog minus the exclusions, in catalog order", () => {
    expect(sharedBuildCatalog()).toEqual(CATALOG.filter((e) => !Object.hasOwn(SHARED_BUILD_EXCLUDED, e.id)));
  });

  test("actualbudget is left out, and reported: its @actual-app/core pulls GPL-3.0 hyperformula and AGPL-3.0 ua-parser-js", () => {
    // Excluded everywhere now (owner decision 2026-10-23), so it is in
    // neither catalog, and the shared build still names it as left out.
    expect(Object.hasOwn(EXCLUDED, "actualbudget")).toBe(true);
    expect(sharedBuildCatalog().some((e) => e.id === "actualbudget")).toBe(false);
    expect(CATALOG.some((e) => e.id === "actualbudget")).toBe(false);
    expect(sharedBuildExclusions()["actualbudget"]).toBe(EXCLUDED["actualbudget"]!);
    expect(EXCLUDED["actualbudget"]).toMatch(/hyperformula@3\.5\.0 \(GPL-3\.0-only\).*ua-parser-js@2\.0\.10\s+\(AGPL-3\.0-or-later\)/s);
  });

  test("the reported exclusions are exactly both lists, so the hosted-only one still reports", () => {
    // The hosted-only list is empty today; a stand-in shows it still lands in
    // the report alongside the everywhere list, through the same function.
    expect(Object.keys(sharedBuildExclusions()).sort()).toEqual(
      [...new Set([...Object.keys(EXCLUDED), ...Object.keys(SHARED_BUILD_EXCLUDED)])].sort(),
    );
    const hostedOnly = SHARED_BUILD_EXCLUDED as Record<string, string>;
    hostedOnly["stand-in"] = "a hosted-only reason for this test";
    try {
      expect(sharedBuildExclusions()["stand-in"]).toBe("a hosted-only reason for this test");
      expect(sharedBuildExclusions()["actualbudget"]).toBe(EXCLUDED["actualbudget"]!);
    } finally {
      delete hostedOnly["stand-in"];
    }
  });
});

describe("scripts/build-shared-runtime.ts", () => {
  const script = readFileSync(resolve(import.meta.dir, "../../../scripts/build-shared-runtime.ts"), "utf8");

  test("installs the shared-build catalog, not the whole CATALOG", () => {
    expect(script).toContain("const fullCatalog = sharedBuildCatalog();");
    expect(script).toContain("sharedPiecesPackageJson(catalog)");
    expect(script).not.toMatch(/\bCATALOG\b/);
  });

  test("gates the installed tree after the install and before any piece runs, and exits on a violation", () => {
    const install = script.indexOf('spawnSync(process.execPath, ["install"');
    const gate = script.indexOf('checkSharedTreeLicenses(piecesDir, catalog, { lockfile: piecesLimit === 0 ? "if-present" : "required" });');
    const engine = script.indexOf("new EngineRuntime(");
    const extract = script.indexOf("buildPieceCatalog(");
    expect(install).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(install);
    expect(engine).toBeGreaterThan(gate);
    expect(extract).toBeGreaterThan(gate);
    const after = script.slice(gate, engine);
    expect(after).toMatch(/\n {2}if \(!licenses\.ok\) \{\n(?: {4}.*\n)*? {4}process\.exit\(1\);\n {2}\}\n/);
    // The notices are written after the pieces ran, from what was rendered
    // before, by exclusive create so a link planted meanwhile is not followed.
    expect(script.indexOf('writeFileSync(noticesPath, licenses.notices!, { flag: "wx" });')).toBeGreaterThan(script.indexOf("}, handOutDigest);"));
    expect(script).toContain('const noticesPath = resolve(out, "pieces", "THIRD_PARTY_NOTICES.md");');
  });

  test("an exclusive create refuses a link planted at the notices path, and leaves its target alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-notices-wx-"));
    made.push(dir);
    writeFileSync(join(dir, "main.js"), "engine");
    symlinkSync(join(dir, "main.js"), join(dir, "THIRD_PARTY_NOTICES.md"));
    expect(() => writeFileSync(join(dir, "THIRD_PARTY_NOTICES.md"), "notices", { flag: "wx" })).toThrow(/EEXIST/);
    expect(readFileSync(join(dir, "main.js"), "utf8")).toBe("engine");
  });

  test("the summary and the log name what the hosted tree leaves out", () => {
    expect(script).toMatch(/\n {6}excluded: sharedBuildExclusions\(\),\n/);
    expect(script).toContain("for (const [id, why] of Object.entries(sharedBuildExclusions())) log(`licenses: left out of the shared tree: ${id} (${why})`);");
  });

  test("the scan the weekly sync runs installs the same tree the same way", () => {
    const check = readFileSync(resolve(import.meta.dir, "../../../scripts/check-piece-licenses.ts"), "utf8");
    expect(check).toContain("const catalog = sharedBuildCatalog();");
    expect(check).toContain("sharedPiecesPackageJson(catalog)");
    expect(check).toContain('["install", "--silent", "--ignore-scripts"]');
    expect(script).toContain('["install", "--silent", "--ignore-scripts"]');
    expect(check).toContain("checkSharedTreeLicenses(dir, catalog);");
  });
});
