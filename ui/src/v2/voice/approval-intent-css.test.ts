import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * #719. Every surface that puts an approval sentence next to an Approve (or
 * Yes) control must show the whole sentence. The rail clamped it to three
 * lines with no expand control, and the transcript a repeat-back row confirms
 * to two; and a long unbroken token could be clipped sideways by a container
 * with `overflow: hidden` (`.v2-thread__scroll`, `.rs-wid`).
 *
 * This repo has no DOM or layout in its tests (see OnboardingWizard.steps.test.ts),
 * so the contract is pinned on the stylesheets themselves: each rule that
 * styles such a sentence wraps long tokens, and NO rule that mentions its class
 * -- in a later block, a media query or under a compound selector -- carries
 * anything that cuts it.
 */
const V2 = join(import.meta.dir, "..");

type Block = { selectors: string[]; decls: string };

function blocks(file: string): Block[] {
  const css = readFileSync(join(V2, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  // `[^{}]` blocks are the innermost ones, so rules inside @media parse too.
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, decls]) => ({
    selectors: sel!.split(",").map((s) => s.trim()),
    decls: decls!,
  }));
}

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(file: string, selector: string): string {
  const hit = blocks(file).find((b) => b.selectors.includes(selector));
  if (!hit) throw new Error(`no rule for ${selector} in ${file}`);
  return hit.decls;
}

/** Every block, anywhere in the file, whose selector targets the selector's last class. */
function everyRuleFor(file: string, selector: string): string[] {
  const cls = selector.split(/\s+/).at(-1)!;
  const token = new RegExp(`${cls.replace(/[.]/g, "\\.")}(?![\\w-])`);
  return blocks(file).filter((b) => b.selectors.some((s) => token.test(s.split(/\s+/).at(-1)!))).map((b) => b.decls);
}

const SENTENCES: Array<[string, string, string]> = [
  ["the rail's approval intent and clarifier label", "voice/RailConfirmationStack.css", ".v2-rail-confirm__card-title"],
  ["the rail's confirmed transcript", "voice/RailConfirmationStack.css", ".v2-rail-confirm__card-quote"],
  ["the thread's approval card", "thread/ApprovalCard.css", ".v2-approval__intent"],
  ["the thread's clarifier label", "thread/ClarifierCard.css", ".v2-clarifier__primary"],
  ["the thread's clarifier transcript", "thread/ClarifierCard.css", ".v2-clarifier__transcript"],
  ["the thread's repeat-back transcript", "thread/RepeatBackCard.css", ".v2-repeatback__heard-text"],
  ["the Authority room's pending card", "rooms/authority/AuthorityRoom.css", ".v2-auth__pending-intent"],
  ["the Now room's waiting widget", "shell/roomShell.css", ".rs-apr .t2"],
  // #792: the reason, in its own element on every one of those surfaces.
  ["the approval reason on every surface", "thread/ApprovalWhy.css", ".v2-approval-why"],
  ["the approval reason's text", "thread/ApprovalWhy.css", ".v2-approval-why__text"],
];

const CUTS: Array<[string, RegExp]> = [
  ["a line clamp", /line-clamp/],
  ["an ellipsis", /text-overflow/],
  ["no wrapping", /white-space\s*:\s*nowrap/],
  ["a clipping overflow", /overflow(-[xy])?\s*:\s*(hidden|clip)/],
  ["a height cap", /max-height/],
  ["a fixed height", /(^|;|\s)height\s*:/],
];

describe("#719: an approval sentence beside an Approve control is never cut", () => {
  test.each(SENTENCES)("%s is not clamped, ellipsized or clipped by any rule", (_label, file, selector) => {
    const rules = everyRuleFor(file, selector);
    expect(rules.length).toBeGreaterThan(0);
    for (const decls of rules) for (const [, cut] of CUTS) expect(decls).not.toMatch(cut);
  });

  test.each(SENTENCES)("%s wraps a long unbroken token", (_label, file, selector) => {
    expect(rule(file, selector)).toMatch(/overflow-wrap\s*:\s*anywhere/);
  });

  test("the rail stack scrolls, and the suggestions give way before it on a short rail", () => {
    const stack = rule("voice/RailConfirmationStack.css", ".v2-rail-confirm");
    expect(stack).toMatch(/min-height\s*:\s*0/);
    expect(stack).toMatch(/overflow-y\s*:\s*auto/);
    const sugs = rule("shell/VoiceRail.css", ".v2-rail__sugs");
    expect(sugs).toMatch(/min-height\s*:\s*0/);
    expect(sugs).toMatch(/flex-shrink\s*:\s*1000/);
  });
});
