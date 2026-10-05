import { describe, expect, test } from "bun:test";
import type { ManifestResult, PieceAction, PieceManifest } from "./piece-manifest";
import { decideVerified, lookupIn, parseInspection, planInspection, type VerifiedEntry, type VerifiedPolicy } from "./verified-sync";
import { VERIFIED_MANIFESTS } from "../../src/workflows/pieces-library/verified-manifests-generated";

const PKG = "@activepieces/piece-acme";
const action = (name: string, classification: string | null = "WRITE", props: string[] = []): PieceAction =>
  ({ name, classification, props });
const manifest = (version: string, actions: PieceAction[]): PieceManifest => ({ version, actions });
const BASE = [action("send", "WRITE", ["to"]), action("read", "READ", ["id"])];

function run(opts: {
  latest: string;
  previous?: string;
  committed?: PieceManifest;
  inspected?: Record<string, ManifestResult>;
  mapped?: string[];
  pins?: VerifiedPolicy["pins"];
  reviewed?: VerifiedPolicy["reviewed"];
  carried?: boolean;
}) {
  const entry: VerifiedEntry = { id: "acme", npmPackage: PKG, latestVersion: opts.latest };
  const mapped = new Set(opts.mapped ?? ["send", "read"]);
  const result = decideVerified({
    entries: [entry],
    previousVersion: () => opts.previous,
    carriedForward: new Set(opts.carried ? ["acme"] : []),
    policy: {
      committed: opts.committed ? { acme: opts.committed } : {},
      pins: opts.pins ?? {},
      reviewed: opts.reviewed ?? {},
    },
    lookup: (pkg, version) => (pkg === PKG ? opts.inspected?.[version] ?? null : null),
    isMapped: (_pkg, a) => mapped.has(a),
  });
  return { entry, ...result };
}
const ok = (m: PieceManifest): ManifestResult => ({ kind: "ok", manifest: m });

describe("decideVerified", () => {
  test("a covered bump is taken and its manifest recorded", () => {
    const r = run({ latest: "1.1.0", previous: "1.0.0", committed: manifest("1.0.0", BASE), inspected: { "1.1.0": ok(manifest("1.1.0", BASE)) } });
    expect(r.entry.latestVersion).toBe("1.1.0");
    expect(r.manifests.acme!.version).toBe("1.1.0");
    expect(r.assessments).toMatchObject([{ ok: true, from: "1.0.0", to: "1.1.0" }]);
  });

  test("an uncovered bump is held: the entry goes back to the installed version, and so does the manifest", () => {
    const r = run({
      latest: "1.1.0", previous: "1.0.0", committed: manifest("1.0.0", BASE),
      inspected: { "1.1.0": ok(manifest("1.1.0", [...BASE, action("purge", "DESTRUCTIVE")])) },
    });
    expect(r.entry.latestVersion).toBe("1.0.0");
    expect(r.manifests.acme!.version).toBe("1.0.0");
    expect(r.assessments).toMatchObject([{ ok: false, reasons: [{ kind: "unmapped" }] }]);
  });

  test("a candidate the inspect job did not read is held, never taken", () => {
    const r = run({ latest: "1.1.0", previous: "1.0.0", committed: manifest("1.0.0", BASE) });
    expect(r.entry.latestVersion).toBe("1.0.0");
    expect(r.assessments[0]!.reasons[0]).toMatchObject({ kind: "unavailable" });
  });

  test("an unchanged version records the committed manifest and assesses nothing", () => {
    const r = run({ latest: "1.0.0", previous: "1.0.0", committed: manifest("1.0.0", BASE) });
    expect(r.assessments).toEqual([]);
    expect(r.manifests.acme!.version).toBe("1.0.0");
  });

  test("a pinned piece records its pin's manifest and is never assessed", () => {
    const r = run({
      latest: "0.9.0", previous: "0.9.0", committed: manifest("0.7.3", BASE), pins: { acme: { vettedVersion: "0.7.3" } },
    });
    expect(r.assessments).toEqual([]);
    expect(r.manifests.acme!.version).toBe("0.7.3");
    expect(r.entry.latestVersion).toBe("0.9.0");
  });

  /**
   * The generated version of a pinned piece follows npm unchecked. Deciding
   * from the committed manifest (what is installed) rather than from the
   * previous generated version is what makes removing the pin a checked move.
   */
  test("removing a pin assesses the jump from the pinned version", () => {
    const r = run({
      latest: "0.9.0", previous: "0.9.0", committed: manifest("0.7.3", BASE),
      inspected: { "0.9.0": ok(manifest("0.9.0", [action("send", "DESTRUCTIVE", ["to"]), action("read", "READ", ["id"])])) },
    });
    expect(r.assessments).toMatchObject([{ from: "0.7.3", to: "0.9.0", ok: false, reasons: [{ kind: "classification-raised" }] }]);
    expect(r.entry.latestVersion).toBe("0.7.3");
  });

  test("npm unanswered (carried forward) is inconclusive, not a decision", () => {
    const r = run({ latest: "1.0.0", previous: "1.0.0", committed: manifest("1.0.0", BASE), carried: true });
    expect(r.inconclusive).toEqual(["acme"]);
    expect(r.assessments).toEqual([]);
    expect(r.manifests.acme!.version).toBe("1.0.0");
  });

  test("a verified id new to the catalog records what it installs", () => {
    const r = run({ latest: "2.0.0", inspected: { "2.0.0": ok(manifest("2.0.0", BASE)) } });
    expect(r.manifests.acme!.version).toBe("2.0.0");
    expect(r.assessments).toEqual([]);
  });

  test("an installed version with no manifest anywhere is held and inconclusive", () => {
    const r = run({ latest: "1.1.0", previous: "1.0.0", inspected: { "1.1.0": ok(manifest("1.1.0", BASE)) } });
    expect(r.entry.latestVersion).toBe("1.0.0");
    expect(r.inconclusive).toEqual(["acme"]);
  });

  test("npm latest moving backwards is kept at the installed version, not taken as an upgrade", () => {
    const r = run({ latest: "0.9.0", previous: "1.0.0", committed: manifest("1.0.0", BASE), inspected: { "0.9.0": ok(manifest("0.9.0", BASE)) } });
    expect(r.entry.latestVersion).toBe("1.0.0");
    expect(r.assessments).toEqual([]);
    expect(r.notes[0]).toContain("older than the installed");
  });

  test("a sign-off between installed and latest is the baseline, so a later release is not held for the same change", () => {
    const raised = [action("send", "WRITE", ["to"]), action("read", "DESTRUCTIVE", ["id"])];
    const inspected = { "1.1.0": ok(manifest("1.1.0", raised)), "1.2.0": ok(manifest("1.2.0", raised)) };
    const base = { latest: "1.2.0", previous: "1.0.0", committed: manifest("1.0.0", BASE), inspected };
    expect(run(base).assessments[0]).toMatchObject({ ok: false, baselineVersion: "1.0.0" });
    expect(run({ ...base, reviewed: { acme: "1.1.0" } }).assessments[0]).toMatchObject({ ok: true, baselineVersion: "1.1.0" });
    // A sign-off of the latest itself compares it with itself.
    expect(run({ ...base, reviewed: { acme: "1.2.0" } }).assessments[0]).toMatchObject({ ok: true });
    // A stale sign-off (at or below what is installed) changes nothing.
    expect(run({ ...base, reviewed: { acme: "0.5.0" } }).assessments[0]).toMatchObject({ ok: false, baselineVersion: "1.0.0" });
  });

  test("a sign-off never clears an unmapped action", () => {
    const r = run({
      latest: "1.1.0", previous: "1.0.0", committed: manifest("1.0.0", BASE), reviewed: { acme: "1.1.0" },
      inspected: { "1.1.0": ok(manifest("1.1.0", [...BASE, action("purge")])) },
    });
    expect(r.assessments[0]!.reasons.map((x) => x.kind)).toEqual(["unmapped"]);
  });
});

test("planInspection asks for the latest, a sign-off in between, a changed pin and a missing baseline only", () => {
  const plan = planInspection(
    [
      { id: "same", npmPackage: "@activepieces/piece-same", installed: "1.0.0", latest: "1.0.0" },
      { id: "bump", npmPackage: "@activepieces/piece-bump", installed: "1.0.0", latest: "1.2.0" },
      { id: "pinned", npmPackage: "@activepieces/piece-pinned", installed: "0.7.3", latest: null },
      { id: "fresh", npmPackage: "@activepieces/piece-fresh", installed: "3.0.0", latest: null },
    ],
    {
      committed: {
        same: manifest("1.0.0", BASE), bump: manifest("1.0.0", BASE), pinned: manifest("0.7.0", BASE),
      },
      pins: { pinned: { vettedVersion: "0.7.3" } },
      reviewed: { bump: "1.1.0" },
    },
  );
  expect(plan.map((p) => `${p.pkg.slice("@activepieces/piece-".length)}@${p.version}`).sort()).toEqual(
    ["bump@1.1.0", "bump@1.2.0", "fresh@3.0.0", "pinned@0.7.3"],
  );
});

describe("parseInspection", () => {
  const entry = (result: unknown, version = "1.0.0") => ({ manifests: [{ pkg: PKG, version, result }] });

  test("every committed manifest passes validation unchanged", () => {
    const raw = {
      manifests: Object.entries(VERIFIED_MANIFESTS).map(([id, m]) => ({
        pkg: `@activepieces/piece-${id}`, version: m.version, result: { kind: "ok", manifest: m },
      })),
    };
    const lookup = lookupIn(parseInspection(raw));
    for (const [id, m] of Object.entries(VERIFIED_MANIFESTS)) {
      expect(lookup(`@activepieces/piece-${id}`, m.version)).toEqual({ kind: "ok", manifest: m });
    }
  });

  test("a malformed file fails the run", () => {
    expect(() => parseInspection(null)).toThrow();
    expect(() => parseInspection({ manifests: "x" })).toThrow();
    expect(() => parseInspection({ manifests: [{ pkg: "evil", version: "1.0.0" }] })).toThrow();
    expect(() => parseInspection({ manifests: [{ pkg: PKG, version: "1.0.0; rm -rf" }] })).toThrow();
  });

  test("an entry with an unexpected shape becomes an error result, which holds that bump", () => {
    const rejected = [
      { kind: "ok", manifest: { version: "9.9.9", actions: [action("a")] } },
      { kind: "ok", manifest: { version: "1.0.0", actions: [action("a"), action("a")] } },
      { kind: "ok", manifest: { version: "1.0.0", actions: [action("a b")] } },
      { kind: "ok", manifest: { version: "1.0.0", actions: [action("a", "write\n## injected")] } },
      { kind: "ok", manifest: { version: "1.0.0", actions: [{ name: "a", classification: null, props: ["x`y"] }] } },
      { kind: "ok", manifest: { version: "1.0.0", actions: "nope" } },
      { kind: "weird" },
    ];
    for (const result of rejected) {
      const r = lookupIn(parseInspection(entry(result)))(PKG, "1.0.0");
      expect(r?.kind).toBe("error");
    }
  });

  test("free text is kept but capped", () => {
    const r = lookupIn(parseInspection(entry({
      kind: "ok", manifest: { version: "1.0.0", actions: [{ ...action("a"), description: "d".repeat(5000) }] },
    })))(PKG, "1.0.0");
    expect(r?.kind === "ok" && r.manifest.actions[0]!.description!.length).toBe(400);
  });
});
