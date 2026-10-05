import { describe, expect, test } from "bun:test";
import type { ManifestResult, PieceAction, PieceManifest } from "./piece-manifest";
import { assessVerifiedUpgrade, compareVersions, renderReviewIssue } from "./verified-upgrade";

const action = (name: string, classification: string | null = "WRITE", props: string[] = []): PieceAction =>
  ({ name, classification, props });
const manifest = (version: string, actions: PieceAction[]): PieceManifest => ({ version, actions });
const ok = (m: PieceManifest): ManifestResult => ({ kind: "ok", manifest: m });

const installed = manifest("1.0.0", [
  action("send", "WRITE", ["to", "body"]),
  action("read", "READ", ["id"]),
]);
const mapped = new Set(["send", "read"]);

function assess(next: PieceAction[], opts: { mapped?: Set<string>; baseline?: ManifestResult } = {}) {
  return assessVerifiedUpgrade({
    id: "acme", from: "1.0.0", to: "1.1.0",
    baseline: opts.baseline ?? ok(installed),
    candidate: ok(manifest("1.1.0", next)),
    isMapped: (name) => (opts.mapped ?? mapped).has(name),
  });
}

describe("assessVerifiedUpgrade", () => {
  test("an unchanged action set is taken", () => {
    expect(assess(installed.actions)).toMatchObject({ ok: true, reasons: [], added: [], removed: [], baselineVersion: "1.0.0" });
  });

  test("an added prop is not a change of shape", () => {
    expect(assess([action("send", "WRITE", ["to", "body", "cc"]), action("read", "READ", ["id"])]).ok).toBe(true);
  });

  test("a new action is held until the adapter maps it, then taken", () => {
    const next = [...installed.actions, action("purge", "DESTRUCTIVE", ["id"])];
    const held = assess(next);
    expect(held.ok).toBe(false);
    expect(held.added).toEqual(["purge"]);
    expect(held.reasons).toEqual([{ kind: "unmapped", actions: [action("purge", "DESTRUCTIVE", ["id"])] }]);
    expect(assess(next, { mapped: new Set([...mapped, "purge"]) }).ok).toBe(true);
  });

  test("every one-step rise in upstream classification is held", () => {
    for (const [from, to] of [["READ", "WRITE"], ["SEARCH", "WRITE"], ["WRITE", "DESTRUCTIVE"]] as const) {
      const base = manifest("1.0.0", [action("x", from)]);
      const a = assessVerifiedUpgrade({
        id: "acme", from: "1.0.0", to: "1.1.0", baseline: ok(base),
        candidate: ok(manifest("1.1.0", [action("x", to)])), isMapped: () => true,
      });
      expect({ from, to, reasons: a.reasons }).toEqual({
        from, to, reasons: [{ kind: "classification-raised", changes: [{ name: "x", from, to }] }],
      });
    }
  });

  test("a rise is compared from a signed-off baseline, so the same change is not held twice", () => {
    const raised = [action("send", "WRITE", ["to", "body"]), action("read", "DESTRUCTIVE", ["id"])];
    expect(assess(raised).reasons.map((r) => r.kind)).toEqual(["classification-raised"]);
    // A person signed off 1.0.5, which already had the rise; 1.1.0 changes nothing more.
    const signedOff = assess(raised, { baseline: ok(manifest("1.0.5", raised)) });
    expect(signedOff).toMatchObject({ ok: true, from: "1.0.0", baselineVersion: "1.0.5" });
  });

  test("a less severe or newly present classification is not a rise", () => {
    const lowered = manifest("1.0.0", [action("send", "DESTRUCTIVE", ["to", "body"]), action("read", null, ["id"])]);
    expect(assess(installed.actions, { baseline: ok(lowered) }).ok).toBe(true);
  });

  test("an unknown upstream classification counts as a rise", () => {
    const next = [action("send", "EXFILTRATE", ["to", "body"]), action("read", "READ", ["id"])];
    expect(assess(next).reasons.map((r) => r.kind)).toEqual(["classification-raised"]);
  });

  test("an existing action that lost props is held", () => {
    const next = [action("send", "WRITE", ["body"]), action("read", "READ", ["id"])];
    expect(assess(next).reasons).toEqual([{ kind: "props-removed", changes: [{ name: "send", removed: ["to"] }] }]);
  });

  test("a removed action is reported but not held", () => {
    expect(assess([action("send", "WRITE", ["to", "body"])])).toMatchObject({ ok: true, removed: ["read"] });
  });

  test("a version with no actions, or one that could not be read, is held, never taken", () => {
    expect(assess([]).reasons).toEqual([{ kind: "unavailable", error: "1.1.0: the package reports no actions" }]);
    const unreadable = assessVerifiedUpgrade({
      id: "acme", from: "1.0.0", to: "1.1.0", baseline: ok(installed),
      candidate: { kind: "error", error: "tarball does not match the registry's integrity" }, isMapped: () => true,
    });
    expect(unreadable.reasons[0]).toMatchObject({ kind: "unavailable" });
    const noBaseline = assessVerifiedUpgrade({
      id: "acme", from: "1.0.0", to: "1.1.0", baseline: { kind: "error", error: "not inspected" },
      candidate: ok(manifest("1.1.0", installed.actions)), isMapped: () => true,
    });
    expect(noBaseline.ok).toBe(false);
  });
});

test("compareVersions orders numerically, not as strings", () => {
  expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
  expect(compareVersions("0.17.10", "0.17.9")).toBeGreaterThan(0);
  expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  expect(compareVersions("0.5.7", "0.7.0")).toBeLessThan(0);
});

describe("renderReviewIssue", () => {
  const held = [
    assess([...installed.actions, { ...action("purge", "DESTRUCTIVE", ["id"]), description: "Deletes `everything`\nforever" }]),
    assess([action("send", "WRITE", ["body"]), action("read", "DESTRUCTIVE", ["id"])]),
  ];

  test("says what was found and how to clear each reason, and links the PR", () => {
    const body = renderReviewIssue(held, { prUrl: "https://example.test/pr/1", runUrl: "https://example.test/run/2" });
    expect(body).toContain("Catalog PR from this run: https://example.test/pr/1");
    expect(body).toContain("Sync run: https://example.test/run/2");
    expect(body).toContain("## `acme`: `1.0.0` -> `1.1.0`");
    expect(body).toContain("**1 action is not in the adapter.**");
    expect(body).toContain("- `purge` (upstream `DESTRUCTIVE`) -- `Deletes everything forever` Props: `id`.");
    expect(body).toContain("- `read`: `READ` -> `DESTRUCTIVE`");
    expect(body).toContain("- `send`: lost `to`");
    expect(body).toContain('`"acme": "1.1.0"` to `VERIFIED_UPGRADE_REVIEWED`');
  });

  test("names a signed-off baseline", () => {
    const fromSignOff = assess([action("send", "WRITE", ["body"]), action("read", "READ", ["id"])], {
      baseline: ok(manifest("1.0.5", installed.actions)),
    });
    expect(renderReviewIssue([fromSignOff], { prUrl: null, runUrl: null })).toContain("Compared from the signed-off `1.0.5`");
  });

  /**
   * Upstream strings are attacker-influenced: outside a code span a
   * description could add a heading, an @mention, a cross-reference or an
   * image to an issue the bot posts.
   */
  test("upstream text stays inside a single capped code span", () => {
    const hostile = assess([
      ...installed.actions,
      { name: "x", classification: "WRITE\n\n## All clear @org/team", props: [], description: "![t](https://e.test/p.png) @user #1 ``` [link](x)" },
    ]);
    const body = renderReviewIssue([hostile], { prUrl: null, runUrl: null });
    const line = body.split("\n").find((l) => l.startsWith("- `x`"))!;
    expect(line).toBe("- `x` (upstream `WRITE ## All clear @org/team`) -- `![t](https://e.test/p.png) @user #1 [link](x)`");
    expect(body).not.toContain("\n## All clear");
    const long = assess([...installed.actions, { ...action("y"), description: "a".repeat(1000) }]);
    expect(renderReviewIssue([long], { prUrl: null, runUrl: null })).toContain(`\`${"a".repeat(200)}...\``);
  });

  test("says so when the run opened no PR", () => {
    expect(renderReviewIssue(held, { prUrl: null, runUrl: null })).toContain("This run opened no catalog PR");
  });

  test("no em dashes or fancy arrows", () => {
    expect(renderReviewIssue(held, { prUrl: null, runUrl: null })).not.toMatch(/[—–→⇒←]/);
  });
});
