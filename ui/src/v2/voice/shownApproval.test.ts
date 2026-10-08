import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newestApprovalId, newestFirst, shownApprovalId } from "./shownApproval";

/**
 * #809. The id sent with a spoken answer is the approval on top of the voice
 * rail, so the rail and the id must agree on what "on top" is.
 */
describe("newestApprovalId", () => {
  test("is the newest by timestamp, whatever the arrival order", () => {
    expect(newestApprovalId([
      { id: "a", timestamp: 1 },
      { id: "c", timestamp: 3 },
      { id: "b", timestamp: 2 },
    ])).toBe("c");
  });

  test("is null when nothing is shown", () => {
    expect(newestApprovalId([])).toBeNull();
  });

  test("on a tie it is the first the rail lists, so the two never disagree", () => {
    const approvals = [{ id: "x", timestamp: 5 }, { id: "y", timestamp: 5 }, { id: "z", timestamp: 4 }];
    expect(newestApprovalId(approvals)).toBe(newestFirst(approvals)[0]!.id);
    expect(newestApprovalId(approvals)).toBe("x");
  });

  test("the rail and the voice hook are both wired to this ordering", () => {
    const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8");
    expect(read("RailConfirmationStack.tsx")).toContain("const sortedApprovals = newestFirst(approvals);");
    const shell = read("../shell/AppShell.tsx");
    expect(shell).toContain("shownApprovalId(approvalsRef.current, document.visibilityState)");
    expect(shell).toMatch(/useVoice\(\{[\s\S]*?getShownApprovalId,[\s\S]*?\}\);/);
  });
});

/** #809 review: a hidden dashboard showed nothing, whatever it holds. */
describe("shownApprovalId", () => {
  const approvals = [{ id: "a", timestamp: 1 }, { id: "b", timestamp: 2 }];

  test("is the top of the rail while the page is on screen", () => {
    expect(shownApprovalId(approvals, "visible")).toBe("b");
  });

  test("is null while the page is hidden, so a wake-word yes decides nothing", () => {
    expect(shownApprovalId(approvals, "hidden")).toBeNull();
    expect(shownApprovalId(approvals, "prerender")).toBeNull();
  });
});
