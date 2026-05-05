#!/usr/bin/env bun
/**
 * Guard: forbid Activepieces Enterprise-licensed code from entering the repo.
 *
 * The Activepieces project is dual-licensed. Files under any `/ee/` path
 * (e.g. `packages/ee/**`, `packages/server/api/src/app/ee/**`) are covered by
 * the Activepieces Enterprise License, which forbids redistribution without a
 * paid per-seat subscription. Jarvis only vendors the MIT-licensed subset, so
 * any `/ee/` path or `/ee/` import in this repo is a license violation.
 *
 * Fails (exit 1) on:
 *   1. Any file path under `src/workflows/activepieces/` containing an `/ee/` segment.
 *   2. Any source file (anywhere in the repo) importing from a path with an `/ee/` segment
 *      that resolves into the activepieces vendor tree.
 *
 * Run via:
 *   - `bun run scripts/check-no-ee-imports.ts`
 *   - The pre-commit hook (.githooks/pre-commit)
 *   - CI (.github/workflows/test.yml)
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const VENDOR_DIR = join(REPO_ROOT, "src/workflows/activepieces");
const SCAN_DIRS = ["src", "ui/src", "scripts", "bin"];
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "ui/dist",
]);

const EE_SEGMENT = /(^|\/)ee(\/|$)/;
// Matches: import ... from "...activepieces.../ee/..."
//          require("...activepieces.../ee/...")
//          import("...activepieces.../ee/...")
const EE_IMPORT_RE =
  /(?:from|require\(|import\()\s*["']([^"']*activepieces[^"']*\/ee\/[^"']*)["']/g;

type Violation = { kind: "vendored-ee-path" | "ee-import"; file: string; detail: string };

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIR_NAMES.has(name)) continue;
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(full, out);
    else out.push(full);
  }
}

function checkVendoredPaths(violations: Violation[]): void {
  const files: string[] = [];
  walk(VENDOR_DIR, files);
  for (const f of files) {
    const rel = relative(REPO_ROOT, f);
    if (EE_SEGMENT.test(rel)) {
      violations.push({
        kind: "vendored-ee-path",
        file: rel,
        detail: "Path contains an `/ee/` segment -- Activepieces Enterprise License forbids redistribution.",
      });
    }
  }
}

const SELF = join(REPO_ROOT, "scripts/check-no-ee-imports.ts");

function checkSourceImports(violations: Violation[]): void {
  for (const root of SCAN_DIRS) {
    const abs = join(REPO_ROOT, root);
    const files: string[] = [];
    walk(abs, files);
    for (const f of files) {
      if (!SOURCE_EXT.test(f)) continue;
      if (f === SELF) continue;
      let body: string;
      try {
        body = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      EE_IMPORT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = EE_IMPORT_RE.exec(body)) !== null) {
        violations.push({
          kind: "ee-import",
          file: relative(REPO_ROOT, f),
          detail: `Imports from EE-licensed path: ${m[1]}`,
        });
      }
    }
  }
}

const violations: Violation[] = [];
checkVendoredPaths(violations);
checkSourceImports(violations);

if (violations.length === 0) {
  console.log("[check-no-ee-imports] OK -- no Activepieces EE-licensed code found.");
  process.exit(0);
}

console.error("[check-no-ee-imports] FAILED -- Activepieces Enterprise-licensed code detected:\n");
for (const v of violations) {
  console.error(`  [${v.kind}] ${v.file}`);
  console.error(`           ${v.detail}`);
}
console.error(
  "\nThe Activepieces Enterprise License forbids redistribution. Remove the EE path or import before committing.",
);
console.error("See: src/workflows/activepieces/UPSTREAM.md");
process.exit(1);
