#!/usr/bin/env bun
/**
 * CLI: audit which installed pieces declare `outputSample` (actions) or
 * `sampleData` (triggers), and which are still picker-blind. Reads from
 * the on-disk piece-metadata cache so it doesn't need to spawn the
 * engine -- just run after the daemon has started once.
 *
 * Usage:
 *   bun run scripts/audit-piece-outputs.ts          # markdown to stdout
 *   bun run scripts/audit-piece-outputs.ts --json   # JSON for tooling
 *
 * What "declared" means here:
 *   - Action: `outputSample` is set to any value (the picker only uses
 *     non-empty objects + non-empty arrays; we count the declaration
 *     itself, not whether the picker can render it).
 *   - Trigger: `sampleData` is set (upstream-native; older AP triggers
 *     have always carried this field).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

interface ActionLike {
  name: string;
  displayName?: string;
  outputSample?: unknown;
  sampleData?: unknown;
}

interface PieceEntry {
  name: string;
  displayName?: string;
  actions?: Record<string, ActionLike>;
  triggers?: Record<string, ActionLike>;
}

const CACHE_FILE = resolve(homedir(), ".jarvis", "cache", "piece-metadata.json");

if (!existsSync(CACHE_FILE)) {
  console.error(
    `Cache file not found at ${CACHE_FILE}.\n` +
      `Start the daemon once (or run \`bun run build:workflows\` then \`bun start\`) to populate the cache.`,
  );
  process.exit(1);
}

let parsed: { entries?: PieceEntry[] };
try {
  parsed = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as { entries?: PieceEntry[] };
} catch (e) {
  console.error(`Failed to parse ${CACHE_FILE}: ${(e as Error).message}`);
  process.exit(1);
}

const pieces = parsed.entries ?? [];
if (pieces.length === 0) {
  console.error("Cache file has no piece entries. Did the engine extract metadata yet?");
  process.exit(1);
}

interface PieceCoverage {
  pieceName: string;
  pieceDisplay: string;
  actions: { name: string; declared: boolean }[];
  triggers: { name: string; declared: boolean }[];
}

const coverage: PieceCoverage[] = [];
let actionDeclared = 0;
let actionTotal = 0;
let triggerDeclared = 0;
let triggerTotal = 0;

for (const piece of pieces) {
  const pieceCov: PieceCoverage = {
    pieceName: piece.name,
    pieceDisplay: piece.displayName ?? piece.name,
    actions: [],
    triggers: [],
  };
  for (const a of Object.values(piece.actions ?? {})) {
    const declared = a.outputSample !== undefined;
    pieceCov.actions.push({ name: a.displayName ?? a.name, declared });
    actionTotal++;
    if (declared) actionDeclared++;
  }
  for (const t of Object.values(piece.triggers ?? {})) {
    // Triggers carry the upstream-native `sampleData`. Some authors also
    // set `outputSample`; either counts.
    const declared = t.sampleData !== undefined || t.outputSample !== undefined;
    pieceCov.triggers.push({ name: t.displayName ?? t.name, declared });
    triggerTotal++;
    if (declared) triggerDeclared++;
  }
  coverage.push(pieceCov);
}

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        actionDeclared,
        actionTotal,
        triggerDeclared,
        triggerTotal,
        pieces: coverage,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

/* --------------------------------------------------------------- markdown */

const pct = (n: number, d: number): string =>
  d === 0 ? "n/a" : `${((n / d) * 100).toFixed(0)}%`;

console.log("# Piece output-declaration coverage\n");
console.log(`- Actions:  ${actionDeclared} / ${actionTotal} declared (${pct(actionDeclared, actionTotal)})`);
console.log(`- Triggers: ${triggerDeclared} / ${triggerTotal} declared (${pct(triggerDeclared, triggerTotal)})`);
console.log(`- Pieces total: ${coverage.length}`);
console.log("");

// Group pieces by whether they're fully covered, partially covered, or
// fully blind. Fully covered pieces are the boring case -- mention the
// count and skip details. Partially / fully blind get listed with their
// gaps so contributors can target what's missing.
const fullyCovered: PieceCoverage[] = [];
const partial: PieceCoverage[] = [];
const fullyBlind: PieceCoverage[] = [];
for (const p of coverage) {
  const subs = [...p.actions, ...p.triggers];
  if (subs.length === 0) continue;
  const declared = subs.filter((s) => s.declared).length;
  if (declared === subs.length) fullyCovered.push(p);
  else if (declared === 0) fullyBlind.push(p);
  else partial.push(p);
}

console.log(`## Fully covered (${fullyCovered.length})\n`);
if (fullyCovered.length === 0) {
  console.log("_(none yet)_\n");
} else {
  for (const p of fullyCovered) {
    console.log(`- **${p.pieceDisplay}** (${p.pieceName})`);
  }
  console.log("");
}

console.log(`## Partially covered (${partial.length})\n`);
if (partial.length === 0) {
  console.log("_(none)_\n");
} else {
  for (const p of partial) {
    console.log(`### ${p.pieceDisplay} (${p.pieceName})\n`);
    for (const a of p.actions) {
      console.log(`- ${a.declared ? "[x]" : "[ ]"} action: ${a.name}`);
    }
    for (const t of p.triggers) {
      console.log(`- ${t.declared ? "[x]" : "[ ]"} trigger: ${t.name}`);
    }
    console.log("");
  }
}

console.log(`## Fully blind (${fullyBlind.length})\n`);
if (fullyBlind.length === 0) {
  console.log("_(none)_\n");
} else {
  console.log("These pieces have no declared output anywhere. The variable picker shows `(output)` until a successful run captures sample data.\n");
  for (const p of fullyBlind) {
    const counts: string[] = [];
    if (p.actions.length > 0) counts.push(`${p.actions.length} action${p.actions.length === 1 ? "" : "s"}`);
    if (p.triggers.length > 0) counts.push(`${p.triggers.length} trigger${p.triggers.length === 1 ? "" : "s"}`);
    console.log(`- **${p.pieceDisplay}** (${p.pieceName}) -- ${counts.join(", ")}`);
  }
}
