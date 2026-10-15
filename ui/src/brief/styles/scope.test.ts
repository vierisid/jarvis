import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Brief styles ship in the same bundle as AppShellV2. Every rule must stay
// inside a Brief root so nothing restyles the released dashboard.
const SHEETS = [
  "index.css", "specimen.css",
  "../components/controls/controls.css", "../components/controls/specimen.css",
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
    expect(list.length).toBeGreaterThan(10);
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
