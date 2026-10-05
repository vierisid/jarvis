#!/usr/bin/env bun
/**
 * Render the review issue for the verified bumps the catalog sync held back.
 * The sync writes them with `--held <path>`; the workflow runs this once the
 * catalog PR exists, so the issue can link it.
 *
 * Usage: bun run scripts/render-review-issue.ts <held.json> [--pr-url URL] [--run-url URL]
 */
import { readFileSync } from "node:fs";
import { renderReviewIssue, type UpgradeAssessment } from "./lib/verified-upgrade";

function flag(name: string): string | null {
  const i = process.argv.indexOf(name);
  const v = i !== -1 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : null;
}

const path = process.argv[2];
if (!path || path.startsWith("--")) {
  console.error("usage: render-review-issue.ts <held.json> [--pr-url URL] [--run-url URL]");
  process.exit(2);
}
const held = JSON.parse(readFileSync(path, "utf8")) as UpgradeAssessment[];
process.stdout.write(renderReviewIssue(held, { prUrl: flag("--pr-url"), runUrl: flag("--run-url") }));
