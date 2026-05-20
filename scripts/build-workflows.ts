#!/usr/bin/env bun
/**
 * CLI: build the workflow runtime in one go -- every Jarvis piece's
 * `dist/src/index.js` AND the activepieces engine bundle. Both are
 * needed for catalog metadata extraction to see fresh source: the
 * engine reads compiled pieces via dev-pieces mode, and the engine
 * itself bundles the framework that interprets piece declarations
 * (`outputSample`, `sampleData`, etc.).
 *
 * Easy to forget step 2 after editing the framework, so this script
 * exists to make a single command always do the right thing.
 *
 * Usage:
 *   bun run scripts/build-workflows.ts          # build whatever is stale
 *   bun run scripts/build-workflows.ts --force  # rebuild both unconditionally
 *
 * After this finishes, restart the daemon -- the piece-catalog cache
 * key hashes every piece's compiled output + the engine bundle, so a
 * fresh extraction runs on boot.
 */

import { statSync } from "node:fs";
import { buildAllJarvisPieces } from "../src/workflows/runner/engine-runtime/build-pieces";
import { buildEngineBundle } from "../src/workflows/runner/engine-runtime/build";

const force = process.argv.includes("--force");

console.log("Building Jarvis pieces...");
const piecesStart = Date.now();
const pieces = await buildAllJarvisPieces({ force });
const piecesElapsed = Date.now() - piecesStart;
if (pieces.length === 0) {
  console.log("  (no Jarvis pieces found)");
} else {
  let builtCount = 0;
  let cachedCount = 0;
  for (const r of pieces) {
    const tag = r.cached ? "cached" : "built";
    console.log(`  ${tag} ${r.packageName}@${r.pieceVersion}`);
    if (r.cached) cachedCount++; else builtCount++;
  }
  console.log(
    `  ${pieces.length} piece(s) in ${piecesElapsed} ms (${builtCount} rebuilt, ${cachedCount} cached)`,
  );
}

console.log("\nBuilding engine bundle...");
const engineStart = Date.now();
const bundle = await buildEngineBundle({ force });
const engineElapsed = Date.now() - engineStart;
const sizeMb = (statSync(bundle.bundlePath).size / 1024 / 1024).toFixed(1);
console.log(`  bundle: ${bundle.bundlePath}`);
console.log(`  hash:   ${bundle.hash}`);
console.log(`  size:   ${sizeMb} MB`);
console.log(`  built:  ${engineElapsed} ms`);

console.log(
  "\nDone. Restart the daemon so the piece-catalog cache is rebuilt against the new artifacts.",
);
