/**
 * #1166: the notices for the third-party code compiled into the bundles Jarvis
 * ships cannot drift from what the bundles compile in.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  ENGINE_NOTICES_FILE,
  UI_NOTICES_FILE,
  UI_PUBLIC_ASSETS,
  UNLISTED_ASSET_SOURCES,
  copiedAssets,
  listedPackages,
  packageDirOfInput,
  packagesForInputs,
  renderBundleNotices,
  stagingLockPackages,
} from "./bundle-notices";
import { scanInstalledTree } from "./license-scan";

const ROOT = resolve(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the committed bundle notices", () => {
  test("the engine notices list exactly the packages the staging lock pins, esbuild aside", () => {
    const pinned = stagingLockPackages(read("src/workflows/runner/engine-runtime/engine-staging.lock"));
    expect(pinned).toContain("openpgp@6.3.2");
    expect(pinned.some((p) => p.startsWith("esbuild@") || p.startsWith("@esbuild/"))).toBe(false);
    expect(listedPackages(read(ENGINE_NOTICES_FILE))).toEqual(pinned);
  });

  test("the engine notices name the weak-copyleft packages and carry the GPL text the LGPL refers to", () => {
    const text = read(ENGINE_NOTICES_FILE);
    const weak = text.slice(text.indexOf("## Weak-copyleft"), text.indexOf("## All packages"));
    expect(weak).toMatch(/^- openpgp@[\d.]+ -- LGPL-3\.0\+ -- https:\/\/www\.npmjs\.com\/package\/openpgp\//m);
    expect(weak).toMatch(/^- exifreader@[\d.]+ -- MPL-2\.0 -- /m);
    expect(text).toContain("## GNU General Public License, version 3");
  });
});

describe("matching bundle inputs to packages", () => {
  test("the innermost node_modules package holds an input; scoped names keep their scope", () => {
    expect(packageDirOfInput("node_modules/react/index.js")).toBe(["node_modules", "react"].join(sep));
    expect(packageDirOfInput("node_modules/@xyflow/react/dist/esm/index.js")).toBe(["node_modules", "@xyflow", "react"].join(sep));
    expect(packageDirOfInput("node_modules/a/node_modules/@s/b/x.js")).toBe(["node_modules", "a", "node_modules", "@s", "b"].join(sep));
    expect(packageDirOfInput("ui/src/app.tsx")).toBeNull();
  });

  test("a nested copy is picked, not the hoisted one, and an input no package holds is reported", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-bundle-notices-"));
    made.push(root);
    const pkg = (dir: string, json: Record<string, unknown>) => {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "package.json"), JSON.stringify(json));
    };
    pkg(".", { name: "x", dependencies: { a: "1", b: "1" } });
    pkg("node_modules/a", { name: "a", version: "1.0.0", license: "MIT" });
    pkg("node_modules/b", { name: "b", version: "1.0.0", license: "MIT" });
    pkg("node_modules/b/node_modules/a", { name: "a", version: "2.0.0", license: "ISC" });
    const scan = scanInstalledTree(root, { reviewed: {} });
    const { packages, unmatched } = packagesForInputs(scan, [
      "node_modules/b/node_modules/a/index.js",
      "node_modules/b/index.js",
      "node_modules/ghost/index.js",
      "ui/src/app.tsx",
    ]);
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual(["a@2.0.0", "b@1.0.0"]);
    expect(unmatched).toEqual(["node_modules/ghost/index.js"]);
  });
});

describe("a compiled-in package without a license text", () => {
  test("is a problem, so the notices for it cannot be generated", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-bundle-notices-"));
    made.push(root);
    const pkg = (dir: string, json: Record<string, unknown>, files: Record<string, string> = {}) => {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "package.json"), JSON.stringify(json));
      for (const [n, t] of Object.entries(files)) writeFileSync(join(root, dir, n), t);
    };
    pkg(".", { name: "x", dependencies: { a: "1", bare: "1" } });
    pkg("node_modules/a", { name: "a", version: "1.0.0", license: "MIT" }, { LICENSE: "MIT License\n\nCopyright (c) A" });
    pkg("node_modules/bare", { name: "bare", version: "1.0.0", license: "MIT" });
    const scan = scanInstalledTree(root, { reviewed: {} });
    const both = renderBundleNotices(root, scan, scan.packages, "T", "I");
    expect(both.problems).toEqual([expect.stringContaining("bare@1.0.0 at node_modules/bare is compiled in but has no license text")]);
    expect(renderBundleNotices(root, scan, scan.packages.filter((p) => p.name === "a"), "T", "I").problems).toEqual([]);
  });
});

describe("ui/public assets", () => {
  test("every file copy:models copies is recorded with its license, and nothing else is", () => {
    const script = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts["copy:models"]!;
    const listed = (a: { from: string }) => !UNLISTED_ASSET_SOURCES.some((prefix) => a.from.startsWith(prefix));
    const copied = copiedAssets(script).filter(listed).map((a) => `${a.from} -> ${a.file}`).sort();
    expect(copied.length).toBeGreaterThan(0);
    expect(copied).toEqual(UI_PUBLIC_ASSETS.map((a) => `${a.from} -> ${a.file}`).sort());
  });

  test("the Docker build copies the same files", () => {
    const dockerfile = read("Dockerfile").replace(/\\\n\s*/g, " ");
    const run = /^RUN (mkdir -p ui\/public\/.*)$/m.exec(dockerfile)?.[1] ?? "";
    const listed = (a: { from: string }) => !UNLISTED_ASSET_SOURCES.some((prefix) => a.from.startsWith(prefix));
    expect(copiedAssets(run).filter(listed).map((a) => a.file).sort()).toEqual(UI_PUBLIC_ASSETS.map((a) => a.file).sort());
  });

  test("THIRD_PARTY_NOTICES.md lists each one with the license recorded for it", () => {
    const text = read("THIRD_PARTY_NOTICES.md");
    const section = text.slice(text.indexOf("## Web UI assets"), text.indexOf("\n## ", text.indexOf("## Web UI assets") + 1));
    for (const a of UI_PUBLIC_ASSETS) {
      const row = section.split("\n").find((l) => l.startsWith("| ") && l.includes(`\`${a.file}\``));
      expect(row ?? `no row for ${a.file}`).toMatch(new RegExp(`\\| ${a.license.replace(/[.+]/g, "\\$&")}( \\(.*\\))? \\|$`));
    }
  });
});
