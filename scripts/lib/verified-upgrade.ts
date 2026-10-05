/**
 * Decide whether the catalog sync may move a verified piece to a new version on
 * its own, and explain the ones it may not.
 *
 * A verified piece has a governed adapter that gives every action an Authority
 * category (`GOVERNED_PIECE_ADAPTERS` in `src/workflows/runtime/piece-effects.ts`).
 * Most upstream releases leave that table correct -- in the #664 refresh, five of
 * the eight verified bumps had the identical action set -- so a bump is taken
 * automatically when all of these hold:
 *
 *   - every action the new version offers is mapped in the adapter, new ones
 *     included (a contributor may have mapped them already);
 *   - no action the baseline had got a more severe upstream classification
 *     (READ/SEARCH < WRITE < DESTRUCTIVE), which is the mechanical signal that
 *     an action now does something worse under the same name;
 *   - no action the baseline had lost props, the other sign it changed shape.
 *
 * The baseline is the installed version, or the version a person signed off in
 * `VERIFIED_UPGRADE_REVIEWED` when that is newer: a sign-off means "I read what
 * changed up to here", so a later release is only compared from that point and
 * does not need a second sign-off for the same change. Nothing clears an
 * unmapped action except mapping it, because an unmapped action is gated as the
 * adapter's worst case and the governed-pieces test refuses a catalog that
 * installs one.
 *
 * Pure: the caller fetches nothing here and feeds results in.
 */
import { classificationRank, type ManifestResult, type PieceAction, type PieceManifest } from "./piece-manifest";

export type HoldReason =
  | { kind: "unmapped"; actions: PieceAction[] }
  | { kind: "classification-raised"; changes: Array<{ name: string; from: string; to: string }> }
  | { kind: "props-removed"; changes: Array<{ name: string; removed: string[] }> }
  | { kind: "unavailable"; error: string };

export interface UpgradeAssessment {
  id: string;
  /** The installed version. */
  from: string;
  to: string;
  /** The version the classification and props checks compared from. */
  baselineVersion: string;
  /** True when the bump may be taken without a person. */
  ok: boolean;
  reasons: HoldReason[];
  /** For the PR body: what moved, even when nothing needed a person. */
  added: string[];
  removed: string[];
}

export function assessVerifiedUpgrade(input: {
  id: string;
  from: string;
  to: string;
  /**
   * The manifest to compare from (installed, or a newer sign-off), or an
   * explanation of why it could not be had.
   */
  baseline: ManifestResult;
  candidate: ManifestResult;
  isMapped: (action: string) => boolean;
}): UpgradeAssessment {
  const { id, from, to } = input;
  const baselineVersion = input.baseline.kind === "ok" ? input.baseline.manifest.version : from;
  const held = (reasons: HoldReason[], added: string[] = [], removed: string[] = []): UpgradeAssessment =>
    ({ id, from, to, baselineVersion, ok: reasons.length === 0, reasons, added, removed });

  if (input.candidate.kind === "error") {
    return held([{ kind: "unavailable", error: `${to}: ${input.candidate.error}` }]);
  }
  if (input.baseline.kind === "error") {
    return held([{ kind: "unavailable", error: `baseline: ${input.baseline.error}` }]);
  }
  const next = input.candidate.manifest.actions;
  if (next.length === 0) {
    return held([{ kind: "unavailable", error: `${to}: the package reports no actions` }]);
  }
  const prev = new Map(input.baseline.manifest.actions.map((a) => [a.name, a]));
  const nextNames = new Set(next.map((a) => a.name));
  const added = next.filter((a) => !prev.has(a.name)).map((a) => a.name);
  const removed = [...prev.keys()].filter((n) => !nextNames.has(n));

  const reasons: HoldReason[] = [];
  const unmapped = next.filter((a) => !input.isMapped(a.name));
  if (unmapped.length > 0) reasons.push({ kind: "unmapped", actions: unmapped });

  const raised: Array<{ name: string; from: string; to: string }> = [];
  const shrunk: Array<{ name: string; removed: string[] }> = [];
  for (const a of next) {
    const before = prev.get(a.name);
    if (!before) continue;
    const was = classificationRank(before.classification);
    const now = classificationRank(a.classification);
    // No upstream classification on the old side is no signal, not a rise:
    // otherwise the release that first adds them would hold every action.
    if (was !== null && now !== null && now > was) {
      raised.push({ name: a.name, from: before.classification!, to: a.classification! });
    }
    const lost = before.props.filter((p) => !a.props.includes(p));
    if (lost.length > 0) shrunk.push({ name: a.name, removed: lost });
  }
  if (raised.length > 0) reasons.push({ kind: "classification-raised", changes: raised });
  if (shrunk.length > 0) reasons.push({ kind: "props-removed", changes: shrunk });
  return held(reasons, added, removed);
}

/**
 * Order two `x.y.z` versions. A part that is not a number compares as 0, which
 * only matters for a pre-release tag, and npm's `latest` is never one for these.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Upstream text in the issue goes inside a code span, capped: a description or
 * classification comes from the package, and outside a span it could add a
 * heading, an @mention, a cross-reference or a tracking image to an issue the
 * bot posts. Backticks and line breaks are what would close a span.
 */
function code(s: string, max = 200): string {
  const flat = s.replace(/[`\s]+/g, " ").trim();
  return `\`${flat.length > max ? `${flat.slice(0, max)}...` : flat}\``;
}

/**
 * The tracking issue for the held bumps: one section per piece, saying what
 * was found and what unblocks it. Rewritten in full on every sync run, so it
 * always describes the newest npm release, and closed by the workflow once
 * nothing is held.
 */
export function renderReviewIssue(
  held: UpgradeAssessment[],
  opts: { prUrl: string | null; runUrl: string | null },
): string {
  const out: string[] = [];
  const p = (line = "") => out.push(line);
  p("The weekly catalog sync bumps a verified piece on its own when its governed adapter still covers it. " +
    "These did not pass that check, so the catalog keeps installing the version below until the reason is cleared.");
  p();
  p(opts.prUrl ? `Catalog PR from this run: ${opts.prUrl}` : "This run opened no catalog PR (no other entry changed).");
  if (opts.runUrl) p(`Sync run: ${opts.runUrl}`);
  p();
  p("The adapter table is `GOVERNED_PIECE_ADAPTERS` in `src/workflows/runtime/piece-effects.ts`; " +
    "the sign-off list is `VERIFIED_UPGRADE_REVIEWED` in `src/workflows/pieces-library/catalog-overrides.ts`. " +
    "Land the change in its own PR to main; the next sync run then takes the bump by itself.");
  for (const h of held) {
    p();
    p(`## ${code(h.id)}: ${code(h.from)} -> ${code(h.to)}`);
    if (h.baselineVersion !== h.from) {
      p();
      p(`Compared from the signed-off ${code(h.baselineVersion)}, not the installed version.`);
    }
    const signOff = code(`"${h.id}": "${h.to}"`);
    for (const r of h.reasons) {
      p();
      switch (r.kind) {
        case "unmapped":
          p(`**${r.actions.length} action${r.actions.length === 1 ? " is" : "s are"} not in the adapter.** ` +
            "Until mapped, each is gated at the adapter's `unknownActionCategory`, and the governed-pieces test refuses to install them. " +
            "Give each one a category in the adapter's `categories`, at its worst case, and add any prop that names what it acts on to `targetProps`:");
          p();
          for (const a of r.actions) {
            const what = a.description ? ` -- ${code(a.description)}` : "";
            const props = a.props.length > 0 ? ` Props: ${a.props.map((x) => code(x, 60)).join(", ")}.` : "";
            p(`- ${code(a.name, 100)} (upstream ${code(a.classification ?? "unclassified", 40)})${what}${props}`);
          }
          break;
        case "classification-raised":
          p("**Upstream now classifies existing actions as more severe.** The same name may do something worse. " +
            `Read what changed, fix the category in the adapter if it no longer fits, then add ${signOff} to \`VERIFIED_UPGRADE_REVIEWED\`:`);
          p();
          for (const c of r.changes) p(`- ${code(c.name, 100)}: ${code(c.from, 40)} -> ${code(c.to, 40)}`);
          break;
        case "props-removed":
          p("**Existing actions lost props**, so they changed shape. Check the adapter's `targetProps` still name " +
            `what each acts on, then add ${signOff} to \`VERIFIED_UPGRADE_REVIEWED\`:`);
          p();
          for (const c of r.changes) p(`- ${code(c.name, 100)}: lost ${c.removed.map((x) => code(x, 60)).join(", ")}`);
          break;
        case "unavailable":
          p(`**The sync could not read the actions:** ${code(r.error, 300)}. ` +
            "Usually transient (npm, a slow load), and the next run retries. If it repeats, the package itself needs a look.");
          break;
      }
    }
  }
  return out.join("\n") + "\n";
}
