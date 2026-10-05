import { describe, expect, test } from "bun:test";
import {
  diffCatalogs,
  hasChanges,
  renderReport,
  verdictFor,
  type GeneratedEntryLike,
} from "./catalog-diff";

const SHA = "d04e6807c485ecd788a72af0d04abffba78563c7";

function entry(over: Partial<GeneratedEntryLike> & { id: string }): GeneratedEntryLike {
  return {
    npmPackage: `@activepieces/piece-${over.id}`,
    versionRange: "^1.0.0",
    latestVersion: "1.0.0",
    displayName: over.id,
    description: "",
    sourceUrl: `https://example.com/${over.id}`,
    licenseSpdx: "MIT",
    ...over,
  };
}

const meta = { oldSha: SHA, newSha: SHA, verified: new Set<string>(), checked: new Set<string>() };
const reportOpts = {
  shortSha: SHA.slice(0, 7),
  generatedAt: "2026-06-30",
  fileLabel: "src/workflows/pieces-library/catalog-generated.ts",
  lineOf: (_id: string) => null as number | null,
};

describe("diffCatalogs", () => {
  test("identical catalogs produce an empty, safe diff", () => {
    const a = [entry({ id: "gmail" }), entry({ id: "slack" })];
    const diff = diffCatalogs(a, a, meta);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.versionChanged).toHaveLength(0);
    expect(diff.licenseChanged).toHaveLength(0);
    expect(diff.otherChanged).toHaveLength(0);
    expect(diff.shaChanged).toBeNull();
    expect(verdictFor(diff)).toBe("safe");
  });

  test("a pure version bump is detected and stays safe", () => {
    const oldE = [entry({ id: "gmail", latestVersion: "0.4.7" })];
    const newE = [entry({ id: "gmail", latestVersion: "0.4.8" })];
    const diff = diffCatalogs(oldE, newE, meta);
    expect(diff.versionChanged).toEqual([{ id: "gmail", from: "0.4.7", to: "0.4.8" }]);
    expect(diff.added).toHaveLength(0);
    expect(verdictFor(diff)).toBe("safe");
  });

  test("a verified bump that skipped the adapter check forces review (#664)", () => {
    const oldE = [
      entry({ id: "gmail", latestVersion: "0.15.0" }),
      entry({ id: "slack", latestVersion: "0.17.10" }),
      entry({ id: "acme", latestVersion: "1.0.0" }),
    ];
    const newE = [
      entry({ id: "gmail", latestVersion: "0.17.0" }),
      entry({ id: "slack", latestVersion: "0.21.0" }),
      entry({ id: "acme", latestVersion: "1.1.0" }),
    ];
    const verified = new Set(["gmail", "slack"]);
    // Neither verified bump was checked: both force review, the community bump does not.
    const unchecked = diffCatalogs(oldE, newE, { ...meta, verified });
    expect(unchecked.verifiedVersionChanged.map((c) => c.id)).toEqual(["gmail", "slack"]);
    expect(verdictFor(unchecked)).toBe("review");
    const { markdown } = renderReport(unchecked, reportOpts);
    expect(markdown).toContain("2 verified pieces bumped without the adapter check");
    expect(markdown).toContain("- `gmail` -- `0.15.0` -> `0.17.0`");
    expect(markdown.indexOf("`gmail`")).toBeLessThan(markdown.indexOf("`slack`"));

    // One checked, one not: only the unchecked one is flagged.
    const partly = diffCatalogs(oldE, newE, { ...meta, verified, checked: new Set(["gmail"]) });
    expect(partly.verifiedVersionChanged.map((c) => c.id)).toEqual(["slack"]);
    expect(renderReport(partly, reportOpts).markdown).toContain("1 verified piece bumped without the adapter check");

    // Both checked: safe again, and an unverified bump never mattered.
    expect(verdictFor(diffCatalogs(oldE, newE, { ...meta, verified, checked: verified }))).toBe("safe");
    expect(verdictFor(diffCatalogs(oldE, newE, meta))).toBe("safe");
  });

  test("the report lists verified upgrades taken and held, and links the Tests runs", () => {
    const oldE = [entry({ id: "notion", latestVersion: "0.6.10" })];
    const newE = [entry({ id: "notion", latestVersion: "0.7.3" })];
    const diff = diffCatalogs(oldE, newE, { ...meta, verified: new Set(["notion"]), checked: new Set(["notion"]) });
    const { verdict, markdown } = renderReport(diff, {
      ...reportOpts,
      testsUrl: "https://example.test/tests",
      verifiedUpgrades: [
        { id: "notion", from: "0.6.10", to: "0.7.3", ok: true, added: [], removed: [], reasons: [] },
        { id: "gmail", from: "0.15.0", to: "0.17.0", ok: false, added: ["gmail_trash_message"], removed: [],
          reasons: [{ kind: "unmapped" }, { kind: "unmapped" }] },
      ],
    });
    expect(verdict).toBe("safe");
    expect(markdown).toContain("| Verified upgrades | 1 taken, 1 held |");
    expect(markdown).toContain("- `notion` -- `0.6.10` -> `0.7.3` -- same action set");
    expect(markdown).toContain("- `gmail` -- stays at `0.15.0`, `0.17.0` available -- unmapped\n");
    expect(markdown).toContain("[Tests runs for this branch](https://example.test/tests)");
  });

  test("an added piece flips the verdict to review", () => {
    const oldE = [entry({ id: "gmail" })];
    const newE = [entry({ id: "gmail" }), entry({ id: "acme-crm", licenseSpdx: "GPL-3.0" })];
    const diff = diffCatalogs(oldE, newE, meta);
    expect(diff.added.map((e) => e.id)).toEqual(["acme-crm"]);
    expect(verdictFor(diff)).toBe("review");
  });

  test("a removed piece flips the verdict to review", () => {
    const oldE = [entry({ id: "gmail" }), entry({ id: "old-piece" })];
    const newE = [entry({ id: "gmail" })];
    const diff = diffCatalogs(oldE, newE, meta);
    expect(diff.removed.map((e) => e.id)).toEqual(["old-piece"]);
    expect(verdictFor(diff)).toBe("review");
  });

  test("a license change is flagged even with no other movement", () => {
    const oldE = [entry({ id: "gmail", licenseSpdx: "MIT" })];
    const newE = [entry({ id: "gmail", licenseSpdx: "GPL-3.0" })];
    const diff = diffCatalogs(oldE, newE, meta);
    expect(diff.licenseChanged).toEqual([{ id: "gmail", from: "MIT", to: "GPL-3.0" }]);
    expect(verdictFor(diff)).toBe("review");
  });

  test("a pinned-SHA bump forces review", () => {
    const a = [entry({ id: "gmail" })];
    const diff = diffCatalogs(a, a, { ...meta, oldSha: "aaa", newSha: "bbb" });
    expect(diff.shaChanged).toEqual({ from: "aaa", to: "bbb" });
    expect(verdictFor(diff)).toBe("review");
  });

  test("displayName/description drift lands in otherChanged (not version)", () => {
    const oldE = [entry({ id: "slack", displayName: "Slack", description: "old" })];
    const newE = [entry({ id: "slack", displayName: "Slack v2", description: "new" })];
    const diff = diffCatalogs(oldE, newE, meta);
    expect(diff.otherChanged).toEqual([{ id: "slack", fields: ["displayName", "description"] }]);
    expect(diff.versionChanged).toHaveLength(0);
    expect(verdictFor(diff)).toBe("review");
  });

  test("first run (no previous) treats everything as added", () => {
    const newE = [entry({ id: "gmail" }), entry({ id: "slack" })];
    const diff = diffCatalogs([], newE, { ...meta, oldSha: "", newSha: SHA });
    expect(diff.added).toHaveLength(2);
    expect(diff.shaChanged).toBeNull(); // empty oldSha is not a "change"
    expect(verdictFor(diff)).toBe("review");
  });
});

describe("hasChanges", () => {
  test("identical catalogs report no changes (timestamp-only run)", () => {
    const a = [entry({ id: "gmail" })];
    expect(hasChanges(diffCatalogs(a, a, meta))).toBe(false);
  });

  test("a version bump counts as a change worth a PR", () => {
    const oldE = [entry({ id: "gmail", latestVersion: "0.4.7" })];
    const newE = [entry({ id: "gmail", latestVersion: "0.4.8" })];
    expect(hasChanges(diffCatalogs(oldE, newE, meta))).toBe(true);
  });

  test("added / removed / sha bump all count as changes", () => {
    const base = [entry({ id: "gmail" })];
    expect(hasChanges(diffCatalogs(base, [...base, entry({ id: "x" })], meta))).toBe(true);
    expect(hasChanges(diffCatalogs([...base, entry({ id: "x" })], base, meta))).toBe(true);
    expect(hasChanges(diffCatalogs(base, base, { ...meta, oldSha: "a", newSha: "b" }))).toBe(true);
  });
});

describe("renderReport", () => {
  test("safe diff renders the NOTE banner and 'Safe to merge'", () => {
    const oldE = [entry({ id: "gmail", latestVersion: "0.4.7" })];
    const newE = [entry({ id: "gmail", latestVersion: "0.4.8" })];
    const { verdict, markdown } = renderReport(diffCatalogs(oldE, newE, meta), reportOpts);
    expect(verdict).toBe("safe");
    expect(markdown).toContain("> [!NOTE]");
    expect(markdown).toContain("Safe to merge");
    // It used to say CI "still gates this PR", which nothing enforced.
    expect(markdown).toContain("Merge on a green Tests run only");
    expect(markdown).not.toContain("gates this PR");
    expect(markdown).toContain("`0.4.7` -> `0.4.8`");
    expect(markdown).not.toContain("[!WARNING]");
  });

  test("added piece renders the WARNING banner with the file:line", () => {
    const oldE = [entry({ id: "gmail" })];
    const newE = [entry({ id: "gmail" }), entry({ id: "acme-crm", licenseSpdx: "Apache-2.0" })];
    const { verdict, markdown } = renderReport(diffCatalogs(oldE, newE, meta), {
      ...reportOpts,
      lineOf: (id) => (id === "acme-crm" ? 42 : null),
    });
    expect(verdict).toBe("review");
    expect(markdown).toContain("> [!WARNING]");
    expect(markdown).toContain("Manual review required");
    expect(markdown).toContain("1 piece added");
    expect(markdown).toContain(
      "`acme-crm` -- `@activepieces/piece-acme-crm` -- license `Apache-2.0` -- " +
        "`src/workflows/pieces-library/catalog-generated.ts:42`",
    );
  });

  test("empty license renders as (unspecified)", () => {
    const oldE = [entry({ id: "gmail" })];
    const newE = [entry({ id: "gmail" }), entry({ id: "weird", licenseSpdx: "" })];
    const { markdown } = renderReport(diffCatalogs(oldE, newE, meta), reportOpts);
    expect(markdown).toContain("license (unspecified)");
  });

  test("a backtick in an upstream license can't break out of the code span", () => {
    const oldE = [entry({ id: "gmail" })];
    const newE = [entry({ id: "gmail" }), entry({ id: "evil", licenseSpdx: "MIT` injected" })];
    const { markdown } = renderReport(diffCatalogs(oldE, newE, meta), reportOpts);
    expect(markdown).not.toContain("MIT` injected");
    expect(markdown).toContain("MIT' injected");
  });

  test("carried-forward pieces render the stale section and summary row", () => {
    const a = [entry({ id: "gmail" }), entry({ id: "spotify", latestVersion: "0.4.4" })];
    const { verdict, markdown } = renderReport(diffCatalogs(a, a, meta), {
      ...reportOpts,
      carriedForward: [{ id: "spotify", version: "0.4.4" }],
    });
    expect(markdown).toContain("| Carried forward (stale) | 1 |");
    expect(markdown).toContain("### Stale entries (carried forward)");
    expect(markdown).toContain("`spotify` -- kept at `0.4.4`");
    // On an unchanged SHA a carried-forward entry produces no diff, so it
    // must not flip the verdict on its own.
    expect(verdict).toBe("safe");
  });

  test("a long carried-forward list collapses into a details block", () => {
    const carried = Array.from({ length: 20 }, (_, i) => ({
      id: `piece-${String(i).padStart(2, "0")}`,
      version: "1.0.0",
    }));
    const a = carried.map((c) => entry({ id: c.id }));
    const { markdown } = renderReport(diffCatalogs(a, a, meta), {
      ...reportOpts,
      carriedForward: carried,
    });
    expect(markdown).toContain("<details><summary>Show 20 carried-forward pieces</summary>");
    expect(markdown).toContain("| Carried forward (stale) | 20 |");
  });

  test("a backtick in a carried-forward version can't break out of the code span", () => {
    const a = [entry({ id: "gmail" })];
    const { markdown } = renderReport(diffCatalogs(a, a, meta), {
      ...reportOpts,
      carriedForward: [{ id: "gmail", version: "1.0.0` injected" }],
    });
    expect(markdown).not.toContain("1.0.0` injected");
    expect(markdown).toContain("1.0.0' injected");
  });

  test("carried-forward alone does not make the diff a change", () => {
    const a = [entry({ id: "spotify" })];
    expect(hasChanges(diffCatalogs(a, a, meta))).toBe(false);
  });

  test("no carriedForward option renders neither section nor summary row", () => {
    const a = [entry({ id: "gmail" })];
    const oldE = [entry({ id: "gmail", latestVersion: "0.9.0" })];
    const { markdown } = renderReport(diffCatalogs(oldE, a, meta), reportOpts);
    expect(markdown).not.toContain("Carried forward");
    expect(markdown).not.toContain("Stale entries");
  });

  test("empty carriedForward list renders neither section nor summary row", () => {
    const a = [entry({ id: "gmail" })];
    const { markdown } = renderReport(diffCatalogs(a, a, meta), {
      ...reportOpts,
      carriedForward: [],
    });
    expect(markdown).not.toContain("Carried forward");
    expect(markdown).not.toContain("Stale entries");
  });

  test("no em dashes or fancy arrows leak into the body", () => {
    const oldE = [entry({ id: "gmail", latestVersion: "1.0.0", licenseSpdx: "MIT" })];
    const newE = [
      entry({ id: "gmail", latestVersion: "1.1.0", licenseSpdx: "ISC" }),
      entry({ id: "new-one" }),
    ];
    const { markdown } = renderReport(diffCatalogs(oldE, newE, { ...meta, oldSha: "aaa", newSha: "bbb" }), reportOpts);
    expect(markdown).not.toMatch(/[—–→⇒←]/);
  });
});
