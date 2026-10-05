import { describe, expect, test } from "bun:test";
import type { PieceAction, PieceManifest } from "./piece-manifest";
import { assessVerifiedUpgrade, renderReviewIssue } from "./verified-upgrade";

const action = (name: string, classification: string | null = "WRITE", props: string[] = []): PieceAction =>
  ({ name, classification, props });
const manifest = (version: string, actions: PieceAction[]): PieceManifest => ({ version, actions });

const baseline = manifest("1.0.0", [
  action("send", "WRITE", ["to", "body"]),
  action("read", "READ", ["id"]),
]);
const mapped = new Set(["send", "read"]);

function assess(next: PieceAction[], opts: { mapped?: Set<string>; reviewedVersion?: string } = {}) {
  const isMapped = (name: string) => (opts.mapped ?? mapped).has(name);
  return assessVerifiedUpgrade({
    id: "acme", from: "1.0.0", to: "1.1.0", baseline,
    candidate: { kind: "ok", manifest: manifest("1.1.0", next) },
    isMapped,
    ...(opts.reviewedVersion ? { reviewedVersion: opts.reviewedVersion } : {}),
  });
}

describe("assessVerifiedUpgrade", () => {
  test("an unchanged action set is taken", () => {
    const a = assess(baseline.actions);
    expect(a).toMatchObject({ ok: true, reasons: [], added: [], removed: [] });
  });

  test("an added prop is not a change of shape", () => {
    expect(assess([action("send", "WRITE", ["to", "body", "cc"]), action("read", "READ", ["id"])]).ok).toBe(true);
  });

  test("a new action is held until the adapter maps it, then taken", () => {
    const next = [...baseline.actions, action("purge", "DESTRUCTIVE", ["id"])];
    const held = assess(next);
    expect(held.ok).toBe(false);
    expect(held.added).toEqual(["purge"]);
    expect(held.reasons).toEqual([{ kind: "unmapped", actions: [action("purge", "DESTRUCTIVE", ["id"])] }]);
    expect(assess(next, { mapped: new Set([...mapped, "purge"]) }).ok).toBe(true);
  });

  test("a sign-off does not clear an unmapped action", () => {
    const next = [...baseline.actions, action("purge")];
    expect(assess(next, { reviewedVersion: "1.1.0" }).reasons.map((r) => r.kind)).toEqual(["unmapped"]);
  });

  test("a more severe upstream classification is held until signed off for that version", () => {
    const next = [action("send", "WRITE", ["to", "body"]), action("read", "DESTRUCTIVE", ["id"])];
    expect(assess(next).reasons).toEqual([
      { kind: "classification-raised", changes: [{ name: "read", from: "READ", to: "DESTRUCTIVE" }] },
    ]);
    expect(assess(next, { reviewedVersion: "1.1.0" }).ok).toBe(true);
    // A sign-off is for one version; an older one does not carry over.
    expect(assess(next, { reviewedVersion: "1.0.5" }).ok).toBe(false);
  });

  test("a less severe or newly present classification is not a rise", () => {
    const lowered = manifest("1.0.0", [action("send", "DESTRUCTIVE", ["to", "body"]), action("read", null, ["id"])]);
    const a = assessVerifiedUpgrade({
      id: "acme", from: "1.0.0", to: "1.1.0", baseline: lowered,
      candidate: { kind: "ok", manifest: manifest("1.1.0", baseline.actions) },
      isMapped: (n) => mapped.has(n),
    });
    expect(a.ok).toBe(true);
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
    const a = assess([action("send", "WRITE", ["to", "body"])]);
    expect(a).toMatchObject({ ok: true, removed: ["read"] });
  });

  test("a version whose actions could not be read is held, never taken", () => {
    const unreadable = assessVerifiedUpgrade({
      id: "acme", from: "1.0.0", to: "1.1.0", baseline,
      candidate: { kind: "error", error: "tarball does not match the registry's integrity" },
      isMapped: () => true,
    });
    expect(unreadable.ok).toBe(false);
    expect(unreadable.reasons[0]).toMatchObject({ kind: "unavailable" });
    const noBaseline = assessVerifiedUpgrade({
      id: "acme", from: "1.0.0", to: "1.1.0", baseline: null,
      candidate: { kind: "ok", manifest: manifest("1.1.0", baseline.actions) },
      isMapped: () => true,
    });
    expect(noBaseline.ok).toBe(false);
  });
});

describe("renderReviewIssue", () => {
  const held = [
    assess([...baseline.actions, { ...action("purge", "DESTRUCTIVE", ["id"]), description: "Deletes `everything`\nforever" }]),
    assess([action("send", "WRITE", ["body"]), action("read", "DESTRUCTIVE", ["id"])]),
  ];

  test("says what was found and how to clear each reason, and links the PR", () => {
    const body = renderReviewIssue(held, { prUrl: "https://example.test/pr/1", runUrl: "https://example.test/run/2" });
    expect(body).toContain("Catalog PR from this run: https://example.test/pr/1");
    expect(body).toContain("Sync run: https://example.test/run/2");
    expect(body).toContain("## `acme`: `1.0.0` -> `1.1.0`");
    expect(body).toContain("**1 action is not in the adapter.**");
    expect(body).toContain("- `purge` (upstream DESTRUCTIVE) -- Deletes `everything` forever Props: `id`.");
    expect(body).toContain("- `read`: READ -> DESTRUCTIVE");
    expect(body).toContain("- `send`: lost `to`");
    expect(body).toContain('`"acme": "1.1.0"` to `VERIFIED_UPGRADE_REVIEWED`');
  });

  test("says so when the run opened no PR", () => {
    expect(renderReviewIssue(held, { prUrl: null, runUrl: null })).toContain("This run opened no catalog PR");
  });

  test("no em dashes or fancy arrows", () => {
    expect(renderReviewIssue(held, { prUrl: null, runUrl: null })).not.toMatch(/[—–→⇒←]/);
  });
});
