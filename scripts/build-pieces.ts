#!/usr/bin/env bun
/**
 * CLI: build every Jarvis-authored piece into its `dist/` layout so the
 * activepieces engine subprocess can load them via dev-pieces mode.
 *
 * Usage:
 *   bun run scripts/build-pieces.ts
 */

import { buildAllJarvisPieces } from "../src/workflows/runner/engine-runtime/build-pieces";

const start = Date.now();
const results = await buildAllJarvisPieces();
const elapsed = Date.now() - start;

if (results.length === 0) {
  console.log("No Jarvis pieces found under packages/pieces/jarvis/.");
  process.exit(0);
}

for (const r of results) {
  console.log(`  built ${r.packageName}@${r.pieceVersion}`);
  console.log(`    bundle: ${r.bundlePath}`);
}
console.log(`\nBuilt ${results.length} piece(s) in ${elapsed} ms.`);
