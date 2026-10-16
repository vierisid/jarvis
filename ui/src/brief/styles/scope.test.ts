import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Brief styles ship in the same bundle as AppShellV2. Every rule must stay
// inside a Brief root so nothing restyles the released dashboard.
const SHEETS = [
  "index.css", "specimen.css",
  "../components/controls/controls.css", "../components/controls/specimen.css",
  "../motion/specimen.css",
  "../shell/navigation/navigation.css", "../shell/navigation/specimen.css",
  "../shell/pebble-layout/pebble.css", "../shell/pebble-layout/specimen.css",
  "../today/hero-paper/hero-paper.css", "../today/layout/today-layout.css", "../today/preview/specimen.css",
  "../today/decision-transition/decision-transition.css",
  "../today/outcomes/outcomes.css", "../today/activity/activity.css", "../today/goal-card/goal-card.css",
  "../today/opportunity-stack/opportunity-stack.css",
  "../chat/tab-strip/tabs.css", "../chat/tab-strip/preview/specimen.css",
  "../chat/composer/composer.css", "../chat/composer/preview/specimen.css",
  "../chat/attachment-fan/attachment-fan.css", "../chat/attachment-fan/preview/specimen.css",
  "../chat/message/messages.css",
  "../workflows/ingredient-picker/picker.css",
  "../workflows/create/creation.css", "../workflows/canvas/canvas.css",
  "../workflows/runs/runs.css", "../workflows/runs/header.css",
  "../workflows/context/context.css",
  "../workflows/manage-list/management.css",
];

function selectors(css: string): string[] {
  const out: string[] = [];
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // Keyframe stops (from, to, 40%) are not selectors.
  let depth = 0, start = 0, keyframes = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{") {
      const prelude = body.slice(start, i).trim();
      if (/^@(-webkit-)?keyframes\b/.test(prelude) && keyframes < 0) keyframes = depth;
      else if (!prelude.startsWith("@") && keyframes < 0) {
        let paren = 0, from = 0;
        for (let j = 0; j <= prelude.length; j++) {
          const d = prelude[j];
          if (d === "(") paren++;
          else if (d === ")") paren--;
          else if ((d === "," && paren === 0) || j === prelude.length) {
            out.push(prelude.slice(from, j).trim()); from = j + 1;
          }
        }
      }
      depth++; start = i + 1;
    } else if (c === "}") { depth--; start = i + 1; if (depth === keyframes) keyframes = -1; }
    else if (c === ";" && depth > 0) start = i + 1;
  }
  return out.filter(Boolean);
}

for (const sheet of SHEETS) {
  test(`${sheet} only styles elements inside a Brief root`, () => {
    const css = readFileSync(join(import.meta.dir, sheet), "utf8");
    const list = selectors(css);
    // Sanity floor so a parse that finds nothing cannot pass; the smallest sheet has 5 rules.
    expect(list.length).toBeGreaterThan(4);
    const leaking = list.filter(s => !/^(:root(\[data-theme="dark"\])? )?\.brief-(root|specimen(__[a-z-]+)?)(?![\w-])/.test(s));
    expect(leaking).toEqual([]);
  });
}

test("the scope check catches an unscoped rule", () => {
  expect(selectors(".brief-root a, body { color: red } @media (x) { .v2-btn { color: red } }"))
    .toEqual([".brief-root a", "body", ".v2-btn"]);
});

test("the scope check skips keyframe stops but not the rules after them", () => {
  expect(selectors("@keyframes spin { from { opacity: 0 } 50% { opacity: .5 } to { opacity: 1 } } body { color: red }"))
    .toEqual(["body"]);
});
