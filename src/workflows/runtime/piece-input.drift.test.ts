/**
 * Drift test: the `PieceInputType` union is declared in two places --
 * the daemon source of truth at `src/workflows/runtime/piece-input.ts`
 * and the UI mirror at `ui/src/v2/rooms/workflows/useWorkflowEditor.ts`.
 *
 * Keeping them in sync is a contract: the catalog API returns whatever
 * the daemon emits, and the editor's `TypedField` falls through to a
 * default branch for unrecognised types. Adding a variant to one and
 * forgetting the other silently loses the typed-widget behaviour.
 *
 * This test parses the union literals out of both files and asserts
 * they're the same set. Failure means a contributor added a variant
 * to one side without updating the other.
 *
 * Why parse instead of import: the UI bundle isn't part of the daemon
 * test graph and pulling a `.tsx` file across that boundary risks
 * dragging React imports in. Text-level comparison is enough -- both
 * unions are short, declared with one literal per line, in the same
 * order. The parser is small and only runs in this one test.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DAEMON_FILE = resolve(__dirname, "piece-input.ts");
const UI_FILE = resolve(__dirname, "../../../ui/src/v2/rooms/workflows/useWorkflowEditor.ts");

/**
 * Extract the `PieceInputType` union literals from a TypeScript file.
 *
 * Looks for `export type PieceInputType =` followed by a sequence of
 * `| "lit"` lines until the statement terminates with `;`. Only
 * literals on lines that START WITH `|` after whitespace trimming
 * count -- this excludes literals that happen to appear inside
 * comments (`// alternative: "deprecated_kind"`), which would
 * otherwise produce a phantom union member.
 *
 * Returns a sorted array so the comparison ignores declaration order
 * (the two files happen to declare in the same order today; sorting
 * means a future contributor can reorder one side without breaking
 * the test).
 */
function extractInputTypeLiterals(filePath: string): string[] {
  const src = readFileSync(filePath, "utf8");
  const match = /export type PieceInputType =([\s\S]*?);/.exec(src);
  if (!match) {
    throw new Error(`Could not locate \`export type PieceInputType =\` in ${filePath}`);
  }
  const block = match[1]!;
  const literals: string[] = [];
  for (const rawLine of block.split("\n")) {
    // Strip line-comments so a `// "x"` doesn't leak a phantom literal.
    const noComment = rawLine.replace(/\/\/.*$/, "");
    const trimmed = noComment.trim();
    // Only the first union arm has no `|` prefix (it follows `=` on
    // the same line). Capture both: lines starting with `|` AND the
    // single line we already trimmed if it's the leading arm. To
    // keep the parser narrow, require the leading arm to be a bare
    // `"lit"` (the daemon and UI files both follow this convention).
    if (!trimmed.startsWith("|") && !/^"[^"]+"$/.test(trimmed)) continue;
    const m = /"([^"]+)"/.exec(trimmed);
    if (m) literals.push(m[1]!);
  }
  return literals.sort();
}

/** Baseline that every PieceInputType union must always include. */
const PIECE_INPUT_TYPE_BASELINE = [
  "string",
  "long_text",
  "number",
  "boolean",
  "enum",
  "json",
] as const;

describe("PieceInputType drift between daemon and UI", () => {
  test("both files declare exactly the same union members", () => {
    const daemon = extractInputTypeLiterals(DAEMON_FILE);
    const ui = extractInputTypeLiterals(UI_FILE);
    expect(daemon).toEqual(ui);
  });

  test("the daemon union is non-empty and includes the canonical baseline", () => {
    // Sanity guard A: if some future edit replaced the daemon union
    // with an imported alias, the regex would capture no literals
    // and the comparison test above would pass on `[] === []`. Pin
    // the baseline so a daemon-side neuter is caught.
    const daemon = extractInputTypeLiterals(DAEMON_FILE);
    for (const baseline of PIECE_INPUT_TYPE_BASELINE) {
      expect(daemon).toContain(baseline);
    }
  });

  test("the UI mirror is non-empty and includes the canonical baseline", () => {
    // Sanity guard B: mirror of the above, so a UI-side neuter (e.g.
    // someone replaces the union with an alias imported from a
    // shared module) can't slip through with empty equality.
    const ui = extractInputTypeLiterals(UI_FILE);
    for (const baseline of PIECE_INPUT_TYPE_BASELINE) {
      expect(ui).toContain(baseline);
    }
  });
});
