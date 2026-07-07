#!/usr/bin/env bun
/**
 * Guard: enforce expand/contract migration discipline on the per-instance DB
 * DDL, so a rolling brain update stays rollback-safe (UPDATES.md).
 *
 * Per-instance SQLite migrations run on brain boot (idempotent `ALTER TABLE`
 * blocks in the scanned files) and are coupled to the code version. During a
 * rollout the fleet runs TWO versions at once, and a rollback repins an instance
 * to the PREVIOUS version's code on the NEW version's schema. That only works if
 * every migration is additive within the rollback window: a new version may only
 * ADD (nullable columns, new tables) and must still read the old shape; a column
 * is DROP/renamed only a version LATER, once the readers are out of the window.
 *
 * Fails (exit 1) on rollback-hazardous DDL unless the line carries the marker
 * `expand-contract-ok` (in a comment), which is a human's explicit assertion
 * that the prior reader is already out of the rollback window:
 *   1. DROP COLUMN / DROP TABLE / RENAME COLUMN / RENAME TO  -- contracting.
 *   2. ADD COLUMN ... NOT NULL without a DEFAULT             -- breaks existing
 *      rows on apply AND old-version inserts that omit the column.
 *
 * Run via: `bun run scripts/check-migrations.ts`, the pre-commit hook, and CI.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// Per-instance DB DDL sources (the user data whose shape a rollback depends on).
const DDL_FILES = ["src/vault/schema.ts", "src/workflows/db/schema.ts"];

/** A line opts out with this marker in a comment (acknowledged as window-safe). */
export const OK_MARKER = "expand-contract-ok";

interface Violation {
  file: string;
  line: number;
  kind: string;
  text: string;
}

/** Strip line/block comments so a comment word (e.g. "default", or a `// drop
 *  column later` note) can't waive OR falsely trip the DDL detection. */
function stripComments(line: string): string {
  return line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
}

/** Classify a DDL line's rollback hazard, or null if additive/safe. */
export function contractKind(line: string): string | null {
  const l = stripComments(line).toLowerCase();
  if (/\bdrop\s+column\b/.test(l)) return "DROP COLUMN";
  if (/\bdrop\s+table\b/.test(l)) return "DROP TABLE";
  if (/\brename\s+column\b/.test(l)) return "RENAME COLUMN";
  if (/\brename\s+to\b/.test(l)) return "RENAME TABLE";
  // A unique index on an existing table rejects the duplicate rows an older
  // version legally wrote -> contracting (a plain index is additive/fine).
  if (/\bcreate\s+unique\s+index\b/.test(l)) return "CREATE UNIQUE INDEX";
  // ADD COLUMN ... NOT NULL with no DEFAULT on the same statement.
  if (/\badd\s+column\b/.test(l) && /\bnot\s+null\b/.test(l) && !/\bdefault\b/.test(l)) {
    return "ADD COLUMN NOT NULL without DEFAULT";
  }
  return null;
}

/** Scan a DDL file's text for un-acknowledged contracting DDL. */
export function scanContent(file: string, content: string): Violation[] {
  const out: Violation[] = [];
  content.split("\n").forEach((line, i) => {
    const kind = contractKind(line);
    if (!kind) return;
    if (line.includes(OK_MARKER)) return; // acknowledged as rollback-window-safe
    out.push({ file, line: i + 1, kind, text: line.trim() });
  });
  return out;
}

function main(): void {
  const violations: Violation[] = [];
  for (const rel of DDL_FILES) {
    let content: string;
    try {
      content = readFileSync(join(REPO_ROOT, rel), "utf-8");
    } catch {
      // A listed DDL file that's gone (moved/renamed/typo) must FAIL loudly --
      // a silent skip is indistinguishable from "scanned + clean" and would
      // disable the guard. Update DDL_FILES if the schema genuinely moved.
      console.error(`[check-migrations] DDL file not found: ${rel} (update DDL_FILES if it moved)`);
      process.exit(1);
    }
    violations.push(...scanContent(rel, content));
  }

  if (violations.length === 0) {
    console.log("[check-migrations] OK -- no un-acknowledged contracting DDL.");
    return;
  }

  console.error("[check-migrations] Rollback-hazardous DDL found (expand/contract):\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.kind}]`);
    console.error(`    ${v.text}`);
  }
  console.error(
    `\nA rollback repins an instance to the PREVIOUS version's code. The above` +
      `\nchanges would break that version reading the new schema. Either make it` +
      `\nadditive (keep the old shape this version, contract a version later), or` +
      `\n-- if the prior reader is already out of the rollback window -- append a` +
      `\ncomment containing "${OK_MARKER}" to the line to acknowledge it.`,
  );
  process.exit(1);
}

if (import.meta.main) main();
