#!/usr/bin/env bun
/**
 * CLI: build every Jarvis-authored piece into its `dist/` layout so the
 * activepieces engine subprocess can load them via dev-pieces mode.
 *
 * Usage:
 *   bun run scripts/build-pieces.ts          # build only stale pieces
 *   bun run scripts/build-pieces.ts --force  # rebuild every piece
 */

import { buildAllJarvisPieces } from "../src/workflows/runner/engine-runtime/build-pieces";

const force = process.argv.includes("--force");

const start = Date.now();
const results = await buildAllJarvisPieces({ force });
const elapsed = Date.now() - start;

if (results.length === 0) {
  console.log("No Jarvis pieces found under packages/pieces/jarvis/.");
  process.exit(0);
}

let builtCount = 0;
let cachedCount = 0;
for (const r of results) {
  const tag = r.cached ? "cached" : "built";
  console.log(`  ${tag} ${r.packageName}@${r.pieceVersion}`);
  console.log(`    bundle: ${r.bundlePath}`);
  if (r.cached) cachedCount++; else builtCount++;
}
console.log(
  `\n${builtCount} rebuilt, ${cachedCount} cached (total ${results.length} piece(s)) in ${elapsed} ms.`,
);
