/**
 * Drift detection between the "Source tree map" in
 * docs/WORKFLOW_AUTOMATION.md and the files it names (#698).
 *
 * The map decayed file by file -- a `jarvis-pieces/` block listing files that
 * lived in `adapters/`, names that no longer existed -- and nothing noticed,
 * because a wrong file name in prose breaks no test. #654 corrected it; this
 * keeps the names honest from here.
 *
 * What this test DOES check (drift that leaves the map pointing at nothing):
 *   - Every entry in the section's bare fenced blocks names a path that
 *     exists: a name ending in `/` a directory, any other name a file,
 *     resolved against the entries it is indented under. So a renamed, moved
 *     or deleted file or directory fails here with the map line that names it.
 *   - Every line of those blocks is either a continuation at the description
 *     column, or an entry that is a top-level directory or sits exactly one
 *     level (two columns) below its directory, with its description (if any)
 *     starting at the description column. A line that is neither -- a
 *     continuation that slid left, with or without words after its first, a
 *     mangled name, the shape a broken edit leaves behind -- fails as
 *     malformed instead of being read as an entry or skipped. (A continuation
 *     that slid to EXACTLY an entry's position, whose first word is a real
 *     file or directory name, and whose next word, if any, happens to start
 *     at the description column, is indistinguishable from an entry and is
 *     checked as one.)
 *   - The section has no fence this parser would not read (`~~~`, an indented
 *     one, or one of four or more backticks), so a block cannot drop out of
 *     the check unnoticed.
 *   - The parser actually walked the map (known entries were seen), so a
 *     reformat cannot turn this into a test of nothing; a renamed heading
 *     throws before any test runs.
 *
 * What it does NOT check:
 *   - Descriptions. "Fastify" where the code uses `Bun.serve`, or a wrong
 *     account of what `config.ts` holds, passes: this reads names, not prose.
 *   - Paths mentioned INSIDE a description (e.g. `src/lib/cron-scheduler.ts`
 *     in the `cron.ts` line), prose between the blocks, a fence with an info
 *     string (```` ```bash ````, skipped as an example rather than a tree),
 *     and the Architecture diagram above the map.
 *   - Anything past the first name on an entry line, except the second name of
 *     an `a.ts + b.ts` pair.
 *   - Completeness. A file the map never listed, or a map line deleted
 *     outright, is invisible to it -- which is how #654's own editing pass lost
 *     lines (a Perl interpolation bug, per #698). It proves every name present
 *     is real, not that every real file is present.
 *   - The git index. Existence is checked on the working tree, so an untracked
 *     file left on disk satisfies it locally and a clean checkout does not.
 *   - Case, on a case-insensitive file system (macOS, Windows): there a
 *     case-only rename passes locally. CI runs on Linux and catches it.
 *
 * Where it runs: `bun test src/workflows/` and CI. The pre-commit hook runs
 * only staged tests and the siblings of staged sources, so a doc-only edit or
 * a source rename does not run this locally -- CI is the gate for those.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const DOC = join(REPO_ROOT, "docs/WORKFLOW_AUTOMATION.md");
const SECTION = "## Source tree map";
/** Where a description starts, and so where its continuation lines sit. */
const DESCRIPTION_COLUMN = 32;

type Entry = { line: number; text: string; path: string; isDir: boolean };
type Block = { start: number; lines: string[] };

/**
 * The bare (` ``` `) fenced blocks between `SECTION` and the next `## `
 * heading, plus any fence in that section this parser would not read.
 */
function sectionBlocks(markdown: string): { blocks: Block[]; unreadFences: string[] } {
  const all = markdown.split("\n");
  const at = all.findIndex((l) => l.trim() === SECTION);
  if (at < 0) throw new Error(`${SECTION} heading not found in ${DOC}`);
  const blocks: Block[] = [];
  const unreadFences: string[] = [];
  // `open` is the block being read; `skipping` is an info-string block.
  let open: Block | null = null;
  let skipping = false;
  for (let i = at + 1; i < all.length; i++) {
    const l = all[i]!;
    if (!open && !skipping && l.startsWith("## ")) break;
    // A fence of four or more backticks would be misread as an info-string
    // fence below and its block skipped, so it is reported instead.
    if (!open && !skipping && /^````/.test(l)) {
      unreadFences.push(`line ${i + 1}: ${JSON.stringify(l)}`);
      continue;
    }
    if (l.startsWith("```")) {
      if (open) {
        blocks.push(open);
        open = null;
      } else if (skipping) {
        skipping = false;
      } else if (l.trimEnd() === "```") {
        open = { start: i + 2, lines: [] }; // 1-based number of the first content line
      } else {
        skipping = true;
      }
      continue;
    }
    if (!open && !skipping && (/^\s*~~~/.test(l) || /^\s+```/.test(l))) {
      unreadFences.push(`line ${i + 1}: ${JSON.stringify(l)}`);
    }
    if (open) open.lines.push(l);
  }
  if (open || skipping) throw new Error(`unterminated code fence in ${SECTION}`);
  return { blocks, unreadFences };
}

const NAME = /^[A-Za-z0-9_.\-/]+$/;

function parseEntries(markdown: string): { entries: Entry[]; malformed: string[]; unreadFences: string[] } {
  const entries: Entry[] = [];
  const malformed: string[] = [];
  const { blocks, unreadFences } = sectionBlocks(markdown);
  for (const block of blocks) {
    const stack: Array<{ indent: number; path: string }> = [];
    block.lines.forEach((raw, k) => {
      const line = block.start + k;
      if (raw.trim() === "") return;
      const indent = raw.length - raw.trimStart().length;
      if (indent === DESCRIPTION_COLUMN) return; // a description's continuation
      if (indent > DESCRIPTION_COLUMN || indent % 2 !== 0) {
        malformed.push(`line ${line}: neither an entry nor a continuation: ${JSON.stringify(raw)}`);
        return;
      }
      // The name is the first token; `a.ts + b.ts` names two files on one line.
      const m = /^(\s*)(\S+(?: \+ \S+)?)(\s*)(.*)$/.exec(raw)!;
      const [, , nameField, gap, description] = m as unknown as [string, string, string, string, string];
      const names = nameField.split(" + ");
      if (names.some((n) => !NAME.test(n))) {
        malformed.push(`line ${line}: unreadable entry name: ${JSON.stringify(raw)}`);
        return;
      }
      // A description starts exactly at the column. Anything else is most
      // likely a continuation that lost its indent, which would otherwise be
      // read as an entry named by its first word. No exemption for a long
      // name: one that would push its description past the column puts the
      // description on the next line instead. (An exemption for "one space
      // after a long name" was tried and let a continuation shifted to column
      // 30 through, since its first word then ends past the column too.)
      const descriptionAt = indent + nameField.length + gap.length;
      if (description !== "" && descriptionAt !== DESCRIPTION_COLUMN) {
        malformed.push(`line ${line}: description not at column ${DESCRIPTION_COLUMN}: ${JSON.stringify(raw)}`);
        return;
      }
      // A one-word continuation that slid left has no description, so the
      // column check above cannot see it. What gives it away is its depth:
      // every real entry is either a top-level directory (column 0) or sits
      // exactly one level (two columns) below the directory it belongs to.
      const isDirName = names.length === 1 && names[0]!.endsWith("/");
      const parentIndent = stack.filter((s) => s.indent < indent).at(-1)?.indent;
      const placed = indent === 0 ? isDirName : parentIndent !== undefined && indent === parentIndent + 2;
      if (!placed) {
        malformed.push(`line ${line}: not one level below a directory (a slid continuation?): ${JSON.stringify(raw)}`);
        return;
      }
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const parent = stack.length > 0 ? stack[stack.length - 1]!.path : "";
      for (const name of names) {
        const isDir = name.endsWith("/");
        const path = join(parent, name);
        entries.push({ line, text: raw.trim(), path, isDir });
        if (isDir && names.length === 1) stack.push({ indent, path });
      }
    });
  }
  return { entries, malformed, unreadFences };
}

describe("docs/WORKFLOW_AUTOMATION.md source tree map vs the tree", () => {
  const { entries, malformed, unreadFences } = parseEntries(readFileSync(DOC, "utf8"));

  test("the parser walked the map", () => {
    // Known entries from each block and from a deep level, so a parser that
    // silently matched nothing (fence reformatted) fails here rather than
    // passing the existence check below vacuously. If one of these is
    // legitimately removed from the map, swap in another entry at the same
    // depth and in the same block.
    const paths = new Set(entries.map((e) => e.path));
    for (const known of [
      "src/workflows/",
      "src/workflows/api/routes.ts",
      "src/workflows/runner/engine-runtime/engine-runtime.ts",
      "src/workflows/sandbox-api/routes/jarvis-tools.ts",
      "ui/src/v2/rooms/workflows/WorkflowEditor.tsx",
      "scripts/build-engine.ts",
    ]) {
      expect({ known, seen: paths.has(known) }).toEqual({ known, seen: true });
    }
  });

  test("the section has no fence this test would not read", () => {
    expect(unreadFences).toEqual([]);
  });

  test("every line is an entry or a description continuation", () => {
    expect(malformed).toEqual([]);
  });

  test("every named file and directory exists", () => {
    const missing = entries
      .filter((e) => {
        const abs = join(REPO_ROOT, e.path);
        if (!existsSync(abs)) return true;
        return statSync(abs).isDirectory() !== e.isDir;
      })
      .map((e) => `line ${e.line}: ${e.path}${e.isDir ? " (directory)" : ""}  <- "${e.text}"`);
    // On failure: update the map in docs/WORKFLOW_AUTOMATION.md to the
    // file's new name or remove the line, in the same change as the rename.
    expect(missing).toEqual([]);
  });
});
