import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "canvas.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string) => {
  const found = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(m => m[1]!.replace(/\s+/g, " ").trim() === selector).map(m => m[2]!).join(" ");
  expect(found).not.toBe("");
  return found;
};

test("the Flow permissions panel is tall enough to show the Add a host row, and scrolls inside itself", () => {
  const body = rule(".brief-root .brief-canvas-setup");
  expect(body).toContain("overflow: auto");
  expect(body).not.toContain("max-height: 200px");
  expect(body).toMatch(/max-height: min\(60vh, 420px\)/);
});

test("node subtitles wrap instead of being cut mid-word", () => {
  const body = rule(".brief-root .brief-workflow-canvas .wf-node__body");
  expect(body).toContain("flex-wrap: wrap");
  expect(body).toContain("white-space: normal");
  expect(body).toContain("overflow-wrap: anywhere");
});

test("a node subtitle stops at three lines so it never runs under the next card", () => {
  const body = rule(".brief-root .brief-workflow-canvas .wf-node__body");
  // Auto-layout spaces cards 140px apart; a card is 84px before its subtitle grows.
  expect(body).toContain("row-gap: 0");
  expect(body).toContain("line-height: 16px");
  expect(body).toContain("max-height: 48px");
});
