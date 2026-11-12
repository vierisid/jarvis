/**
 * Third-party notices for the code Jarvis compiles into its own bundles
 * (#1166, #1278).
 *
 * A bundle copies third-party source into a file of ours and drops the
 * license and notice files that sat next to it in node_modules (measured: the
 * UI bundle `bun build` writes keeps no license comment at all). Three such
 * bundle sets ship:
 *
 *   - the web UI (`ui/dist`, in the npm package and the Docker image), built
 *     from the brain's own install by `bun run build:ui`;
 *   - the vendored pieces (`src/workflows/activepieces/packages/pieces/{jarvis,core}/<name>/dist`,
 *     built by `prepublishOnly` into the npm package and by the Docker image)
 *     and the engine bundle (the Docker image's `engine-cache`), all compiled
 *     from the engine staging install that `engine-staging.lock` pins. Among
 *     them are LGPL `openpgp` (core crypto piece) and MPL-2.0 `exifreader`
 *     (core image helper).
 *
 * Each set gets a committed, generated notices file at the repository root
 * (`THIRD_PARTY_NOTICES-ui.md`, `THIRD_PARTY_NOTICES-engine.md`), listed in
 * the npm `files` and copied into the Docker image. Tests regenerate them and
 * fail when they differ, so a dependency cannot go into a bundle without its
 * notice:
 *   - the UI one from a real build's metafile, on every run;
 *   - the engine one against the staging lock's package list on every run,
 *     and byte for byte from the installed staging tree on the engine-build run.
 *
 *   bun run scripts/third-party-notices.ts [--check] [ui|engine ...]
 */

import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { packageLicenseTexts, renderNotices, scanInstalledTree, type LicenseScan, type ScannedPackage } from "./license-scan";

export const UI_NOTICES_FILE = "THIRD_PARTY_NOTICES-ui.md";
export const ENGINE_NOTICES_FILE = "THIRD_PARTY_NOTICES-engine.md";

/** The entry points `bun run build:ui` builds (package.json). */
export const UI_ENTRYPOINTS = ["ui/index.html", "ui/pebble.html", "ui/notch.html"] as const;

/**
 * The staging install's build tools: in the staging tree to run the build,
 * never compiled into a bundle (esbuild and its per-platform binaries).
 */
export function isStagingBuildTool(name: string): boolean {
  return name === "esbuild" || name.startsWith("@esbuild/");
}

/**
 * The package directory (relative to the root, as `ScannedPackage.path`) a
 * bundle input path sits in, or null for a file outside any node_modules.
 * The innermost `node_modules/<name>` wins, so a nested copy is told apart.
 */
export function packageDirOfInput(input: string): string | null {
  const parts = input.split(/[\\/]/);
  let at = -1;
  for (let i = 0; i < parts.length - 1; i++) if (parts[i] === "node_modules") at = i;
  if (at < 0) return null;
  const name = parts[at + 1]!;
  const len = name.startsWith("@") ? 2 : 1;
  if (parts.length < at + 1 + len) return null;
  return parts.slice(0, at + 1 + len).join(sep);
}

export interface SelectedPackages {
  packages: ScannedPackage[];
  /** Inputs under a node_modules directory the scan has no package for. */
  unmatched: string[];
}

/** The scanned packages a bundle's inputs come from. */
export function packagesForInputs(scan: LicenseScan, inputs: readonly string[]): SelectedPackages {
  const byPath = new Map(scan.packages.map((p) => [p.path, p] as const));
  const picked = new Map<string, ScannedPackage>();
  const unmatched: string[] = [];
  for (const input of inputs) {
    const dir = packageDirOfInput(input);
    if (dir === null) continue;
    const p = byPath.get(dir);
    if (p) picked.set(p.path, p);
    else unmatched.push(input);
  }
  return { packages: sortPackages([...picked.values()]), unmatched };
}

function sortPackages(packages: ScannedPackage[]): ScannedPackage[] {
  const key = (p: ScannedPackage) => `${p.name}@${p.version}\u0000${p.path}`;
  return packages.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export interface BundleNotices {
  text: string;
  packages: ScannedPackage[];
  /** Why the notices cannot be trusted; empty when they can. */
  problems: string[];
}

/** Render notices for `packages` of `scan`; exported for tests. */
export function renderBundleNotices(root: string, scan: LicenseScan, packages: ScannedPackage[], title: string, intro: string): BundleNotices {
  const problems: string[] = [];
  for (const p of packages) {
    if (!p.verdict.allowed) problems.push(`${p.name}@${p.version} at ${p.path} is compiled in but the license policy denies it: ${p.verdict.license}: ${p.verdict.reason}`);
  }
  for (const p of packages) {
    if (packageLicenseTexts(root, p.path, p.name).length === 0) {
      problems.push(`${p.name}@${p.version} at ${p.path} is compiled in but has no license text: no license file, no License section in its README and no entry in LICENSE_TEXT_FALLBACKS (license-text-fallbacks.ts)`);
    }
  }
  const text = renderNotices(root, { ...scan, packages, violations: [] }, title, { intro });
  return { text, packages, problems };
}

/**
 * Notices for the UI bundle, from the repository's own install. `inputs` is
 * every module the UI build compiled in, relative to `repoRoot`, from its
 * metafile (scripts/third-party-notices.ts runs the build).
 */
export function uiBundleNotices(repoRoot: string, inputs: readonly string[]): BundleNotices {
  const root = realpathSync(repoRoot);
  const scan = scanInstalledTree(root, { lockfile: "required" });
  const { packages, unmatched } = packagesForInputs(scan, inputs);
  const notices = renderBundleNotices(
    root,
    scan,
    packages,
    "Third-Party Notices: web UI bundle",
    "The web UI (`ui/dist`, built by `bun run build:ui`) compiles in the packages below. Generated from that build's module list by `bun run scripts/third-party-notices.ts ui`; a test fails when it is out of date.",
  );
  for (const u of unmatched) notices.problems.push(`the UI build compiles in ${u}, which no scanned package holds`);
  if (packages.length === 0) notices.problems.push("the UI build compiled in no package at all, so the build or the scan is broken");
  return notices;
}

/** Notices for everything compiled from the engine staging install. */
export function engineBundleNotices(stagingDir: string): BundleNotices {
  const root = realpathSync(stagingDir);
  const scan = scanInstalledTree(root, { lockfile: "required" });
  const packages = sortPackages(scan.packages.filter((p) => !isStagingBuildTool(p.name)));
  const notices = renderBundleNotices(
    root,
    scan,
    packages,
    "Third-Party Notices: engine and vendored piece bundles",
    "The workflow engine bundle and the vendored pieces' bundles (`src/workflows/activepieces/packages/pieces/{jarvis,core}/*/dist`) compile their third-party code from the engine staging install (`src/workflows/runner/engine-runtime/engine-staging.lock`). Every package that install holds is listed below, except the esbuild build tool; a bundle uses a subset. Generated by `bun run scripts/third-party-notices.ts engine`; a test fails when it is out of date. The LGPL and MPL packages are used unmodified, and their source is the npm release named. The source of the works that combine them ships with these bundles (the npm package and the Docker image carry `src/`, including each piece's source and `src/workflows/runner/engine-runtime/build-pieces.ts`, which builds the bundles from the staging install), so a recipient can rebuild a bundle against a modified copy of one of these libraries.",
  );
  for (const e of scan.errors) notices.problems.push(e);
  return notices;
}

/** `name@version` of every package in the staging lock that a bundle can compile in. */
export function stagingLockPackages(lockText: string): string[] {
  const parsed = Bun.JSONC.parse(lockText) as { packages?: Record<string, unknown> };
  const out = new Set<string>();
  for (const entry of Object.values(parsed.packages ?? {})) {
    const id = Array.isArray(entry) ? entry[0] : null;
    if (typeof id !== "string") continue;
    const at = id.lastIndexOf("@");
    if (at <= 0) continue;
    if (!isStagingBuildTool(id.slice(0, at))) out.add(id);
  }
  return [...out].sort();
}

/** `name@version` of every package a generated notices file lists. */
export function listedPackages(noticesText: string): string[] {
  const all = noticesText.split("\n## All packages\n")[1]?.split("\n## ")[0] ?? "";
  const out = new Set<string>();
  for (const m of all.matchAll(/^- (\S+) -- /gm)) out.add(m[1]!);
  return [...out].sort();
}

/**
 * A file `copy:models` (package.json) copies out of a dependency into
 * `ui/public`, which ships in the npm package and the Docker image and is
 * served to the browser.
 */
export interface ShippedAsset {
  /** Path under ui/public. */
  file: string;
  /** Where copy:models takes it from, relative to the repository root. */
  from: string;
  /** SPDX expression. */
  license: string;
  /** Where that license is stated. */
  source: string;
}

export const UI_PUBLIC_ASSETS: readonly ShippedAsset[] = [
  { file: "ort/ort-wasm-simd-threaded.jsep.wasm", from: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm", license: "MIT", source: "onnxruntime-web package.json" },
  { file: "ort/ort-wasm-simd-threaded.wasm", from: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", license: "MIT", source: "onnxruntime-web package.json" },
  { file: "ort/ort-wasm-simd-threaded.jsep.mjs", from: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs", license: "MIT", source: "onnxruntime-web package.json" },
  { file: "ort/ort-wasm-simd-threaded.mjs", from: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs", license: "MIT", source: "onnxruntime-web package.json" },
];

/** Files `copy:models` copies that this table does not list. */
export const UNLISTED_ASSET_SOURCES: readonly string[] = ["node_modules/openwakeword-wasm-browser/models/"];

/**
 * Every `<from> -> ui/public/<file>` pair a `copy:models` script copies:
 * each `cp <src...> <destdir>/` command in it.
 */
export function copiedAssets(copyModelsScript: string): Array<{ from: string; file: string }> {
  const out: Array<{ from: string; file: string }> = [];
  for (const cmd of copyModelsScript.split("&&").map((c) => c.trim())) {
    const words = cmd.split(/\s+/);
    if (words[0] !== "cp") continue;
    const args = words.slice(1).filter((w) => !w.startsWith("-"));
    const dest = args.pop();
    if (!dest) continue;
    const dir = dest.replace(/\/+$/, "");
    if (!dir.startsWith("ui/public/")) continue;
    for (const from of args) out.push({ from, file: `${dir.slice("ui/public/".length)}/${from.split("/").pop()}` });
  }
  return out;
}
