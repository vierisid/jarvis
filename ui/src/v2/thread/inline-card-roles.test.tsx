/**
 * #1092. The approval, clarifier and repeat-back cards sit inline in the thread,
 * never take focus and never block the page, so they must not claim to be an
 * alertdialog (a dialog that owns focus). Each is a named region: a landmark a
 * screen reader can jump to, announced politely by the thread around it.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard } from "./ApprovalCard";
import { ClarifierCard } from "./ClarifierCard";
import { RepeatBackCard } from "./RepeatBackCard";
import { Thread } from "./Thread";

/** The opening tag of the card's root element. */
function rootTag(html: string): string {
  return html.slice(0, html.indexOf(">") + 1);
}

const cards: Array<[string, React.ReactElement, string]> = [
  ["approval", <ApprovalCard intent="Delete 14 files" category="delete_data" impact="destructive" />, "Approval required: Delete 14 files"],
  ["clarifier", <ClarifierCard transcript="open mail" primary={{ label: "Open Mail", verb: "open", impact: "read" }} alternatives={[]} confidence={0.7} />, "Clarify: did you mean Open Mail?"],
  ["repeat-back", <RepeatBackCard transcript="mumble" confidence={0.4} />, "Heard transcript needs confirmation"],
];

describe("inline confirmation cards are named regions, not dialogs (#1092)", () => {
  for (const [name, element, label] of cards) {
    test(`the ${name} card`, () => {
      const html = renderToStaticMarkup(element);
      expect(html).not.toContain("alertdialog");
      expect(html).not.toContain("aria-modal");
      const root = rootTag(html);
      expect(root).toContain('role="region"');
      expect(root).toContain(`aria-label="${label}"`);
    });
  }
});

describe("with no dialog role, the thread is what announces a new card (#1092)", () => {
  test("the dashboard thread renders cards inside its polite log", () => {
    const html = renderToStaticMarkup(
      <Thread items={[{ kind: "approval", id: "a1", intent: "Delete 14 files", category: "delete_data", impact: "destructive", t: "now" }]} />,
    );
    const log = html.indexOf('role="log"');
    expect(log).toBeGreaterThanOrEqual(0);
    const open = html.lastIndexOf("<", log);
    const logTag = html.slice(open, html.indexOf(">", log) + 1);
    expect(logTag).toContain('aria-live="polite"');
    expect(logTag).toContain('aria-relevant="additions"');
    // Find where the log's own <div> closes, counting nested divs.
    const re = /<(\/?)div\b[^>]*>/g;
    re.lastIndex = open;
    let depth = 0, close = -1, m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) { close = m.index; break; }
    }
    expect(close).toBeGreaterThan(open);
    const card = html.indexOf('aria-label="Approval required: Delete 14 files"');
    expect(card).toBeGreaterThan(open);
    expect(card).toBeLessThan(close);
  });
});
