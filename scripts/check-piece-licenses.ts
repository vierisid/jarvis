#!/usr/bin/env bun
/**
 * License-check what the hosted shared build would install (#971).
 *
 * Installs the shared-build catalog exactly as scripts/build-shared-runtime.ts
 * does (same package.json, `bun install --silent --ignore-scripts`, so no
 * package code runs), then applies the same gate. The weekly catalog sync runs
 * this, so a piece release or a dependency that the policy denies fails that
 * run first, a week before the next hosted build would.
 *
 *   bun run scripts/check-piece-licenses.ts --install <empty dir>
 *   bun run scripts/check-piece-licenses.ts --dir <an installed tree>
 *     [--notices PATH]      write the generated notices (only when it passes)
 *     [--summary-md PATH]   append a Markdown report (e.g. $GITHUB_STEP_SUMMARY)
 *     [--problems PATH]     write one line per problem (empty when it passes), for
 *                           the catalog PR body; a failed install writes its reason
 *
 * Exit 0 when every package is allowed, 1 on any violation, 2 on bad usage
 * or a failed install.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sharedBuildCatalog } from "../src/workflows/pieces-library/catalog";
import { checkSharedTreeLicenses, problemsFileText, sharedPiecesPackageJson } from "../src/workflows/pieces-library/shared-build";
import { sanitizedEnv } from "../src/util/subprocess-env";

function flagValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const installDir = flagValue("--install");
const scanDir = flagValue("--dir");
const noticesPath = flagValue("--notices");
const summaryMd = flagValue("--summary-md");
const problemsPath = flagValue("--problems");
if ((installDir === null) === (scanDir === null)) {
  console.error(
    "usage: check-piece-licenses (--install <empty dir> | --dir <installed tree>) [--notices PATH] [--summary-md PATH] [--problems PATH]",
  );
  process.exit(2);
}

// --notices and --problems may name a directory nothing has created yet (the
// catalog sync passes $RUNNER_TEMP/license-problems/...): create it, or the
// write throws ENOENT after the scan and the run reports a crash, not the scan.
function writeCreatingDir(path: string, text: string): void {
  const p = resolve(path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

const catalog = sharedBuildCatalog();
let dir: string;
if (installDir !== null) {
  dir = resolve(installDir);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    console.error(`--install ${dir} exists and is not empty; pass a fresh directory`);
    process.exit(2);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "package.json"), sharedPiecesPackageJson(catalog));
  console.error(`[licenses] installing ${catalog.length} pieces into ${dir}`);
  // Same flags as the shared build; process.execPath, never a bun from PATH.
  const install = spawnSync(process.execPath, ["install", "--silent", "--ignore-scripts"], {
    cwd: dir,
    stdio: ["ignore", "inherit", "inherit"],
    env: sanitizedEnv(),
  });
  if (install.status !== 0) {
    console.error(`bun install failed (exit ${install.status})`);
    if (problemsPath) writeCreatingDir(problemsPath, `bun install of the shared pieces tree failed (exit ${install.status}), so nothing was scanned\n`);
    process.exit(2);
  }
} else {
  dir = resolve(scanDir!);
}

const result = checkSharedTreeLicenses(dir, catalog);
if (noticesPath && result.notices !== null) writeCreatingDir(noticesPath, result.notices);
if (problemsPath) writeCreatingDir(problemsPath, problemsFileText(result.problems));
const annotate = process.env.GITHUB_ACTIONS === "true";
// Every line below is already oneLine()d by the gate: no `::`, no newlines.
for (const line of result.problems) {
  console.error(annotate ? `::error::license policy (#971): ${line}` : `DENIED ${line}`);
}
for (const k of result.unusedReviewed) console.error(`[licenses] reviewed entry ${k} matched nothing in this tree`);
console.error(
  `[licenses] ${result.packages} package(s), ${result.problems.length} problem(s), ` +
    `weak copyleft: ${result.weakCopyleft.join(", ") || "none"}, reviewed: ${result.reviewed.join(", ") || "none"}`,
);

if (summaryMd) {
  const code = (s: string) => "`" + s.replace(/`/g, "'").replace(/[\r\n]+/g, " ") + "`";
  const md: string[] = ["## License scan of the shared pieces tree (#971)", ""];
  md.push(`${result.packages} packages installed from ${catalog.length} catalog pieces.`, "");
  if (result.ok) md.push("Every package is allowed by the policy.", "");
  else {
    md.push(`**${result.problems.length} problem(s). The next hosted shared build will refuse this tree.**`, "");
    for (const line of result.problems) md.push(`- ${code(line)}`);
    md.push("");
  }
  md.push(`Weak copyleft (allowed, listed in the notices): ${result.weakCopyleft.map(code).join(", ") || "none"}`, "");
  if (result.unusedReviewed.length > 0) md.push(`Reviewed entries nothing used: ${result.unusedReviewed.map(code).join(", ")}`, "");
  appendFileSync(summaryMd, md.join("\n") + "\n");
}

process.exit(result.ok ? 0 : 1);
