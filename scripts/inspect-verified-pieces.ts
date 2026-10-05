#!/usr/bin/env bun
/**
 * The `inspect` job of the catalog sync: read the action manifests of the
 * verified-piece versions the sync may need, and write them as JSON for the
 * writing job. RUNS PIECE CODE. In CI it runs in a job with a read-only token
 * that is never placed in an environment and no git credentials on disk; see
 * `scripts/lib/piece-manifest.ts` and `.github/workflows/sync-pieces-catalog.yml`.
 *
 * Usage: bun run scripts/inspect-verified-pieces.ts <out.json>
 */
import { writeFileSync } from "node:fs";
import { CATALOG } from "../src/workflows/pieces-library/catalog";
import {
  VERIFIED,
  VERIFIED_UPGRADE_REVIEWED,
  VERSION_PIN,
} from "../src/workflows/pieces-library/catalog-overrides";
import { VERIFIED_MANIFESTS } from "../src/workflows/pieces-library/verified-manifests-generated";
import { createNpmClient } from "./lib/npm-latest";
import { inspectVerified } from "./lib/verified-inspect";

const out = process.argv[2];
if (!out || out.startsWith("--")) {
  console.error("usage: inspect-verified-pieces.ts <out.json>");
  process.exit(2);
}

const pieces = CATALOG.filter((e) => VERIFIED.has(e.id)).map((e) => ({
  id: e.id,
  npmPackage: e.npmPackage,
  installed: e.vettedVersion,
}));
const inspection = await inspectVerified({
  pieces,
  policy: { committed: VERIFIED_MANIFESTS, pins: VERSION_PIN, reviewed: VERIFIED_UPGRADE_REVIEWED },
  npm: createNpmClient(),
  log: (msg) => console.log(`[inspect-verified-pieces] ${msg}`),
});
writeFileSync(out, JSON.stringify(inspection));
console.log(`[inspect-verified-pieces] wrote ${inspection.manifests.length} manifest result(s) to ${out}`);
