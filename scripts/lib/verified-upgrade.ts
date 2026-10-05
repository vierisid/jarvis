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
 *   - no action the old version had got a more severe upstream classification
 *     (READ/SEARCH < WRITE < DESTRUCTIVE), which is the mechanical signal that
 *     an action now does something worse under the same name;
 *   - no action the old version had lost props, the other sign it changed shape.
 *
 * The last two can be cleared by a person: `VERIFIED_UPGRADE_REVIEWED` in
 * `catalog-overrides.ts` records "I read what changed up to this version".
 * Nothing clears the first except mapping the actions, because an unmapped
 * action is gated as the adapter's worst case and the governed-pieces test
 * refuses a catalog that installs one.
 *
 * Pure: the sync script does the fetching and feeds results in.
 */
import { classificationRank, type ManifestResult, type PieceAction, type PieceManifest } from "./piece-manifest";

export type HoldReason =
  | { kind: "unmapped"; actions: PieceAction[] }
  | { kind: "classification-raised"; changes: Array<{ name: string; from: string; to: string }> }
  | { kind: "props-removed"; changes: Array<{ name: string; removed: string[] }> }
  | { kind: "unavailable"; error: string };

export interface UpgradeAssessment {
  id: string;
  from: string;
  to: string;
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
  /** The installed version's manifest, or null when it could not be had. */
  baseline: PieceManifest | null;
  candidate: ManifestResult;
  isMapped: (action: string) => boolean;
  /** `VERIFIED_UPGRADE_REVIEWED[id]`, when someone signed off a version. */
  reviewedVersion?: string;
}): UpgradeAssessment {
  const { id, from, to } = input;
  const held = (reasons: HoldReason[], added: string[] = [], removed: string[] = []): UpgradeAssessment =>
    ({ id, from, to, ok: reasons.length === 0, reasons, added, removed });

  if (input.candidate.kind === "error") {
    return held([{ kind: "unavailable", error: `${to}: ${input.candidate.error}` }]);
  }
  if (!input.baseline) {
    return held([{ kind: "unavailable", error: `${from}: no manifest for the installed version to compare against` }]);
  }
  const next = input.candidate.manifest.actions;
  const prev = new Map(input.baseline.actions.map((a) => [a.name, a]));
  const nextNames = new Set(next.map((a) => a.name));
  const added = next.filter((a) => !prev.has(a.name)).map((a) => a.name);
  const removed = [...prev.keys()].filter((n) => !nextNames.has(n));

  const reasons: HoldReason[] = [];
  const unmapped = next.filter((a) => !input.isMapped(a.name));
  if (unmapped.length > 0) reasons.push({ kind: "unmapped", actions: unmapped });

  if (input.reviewedVersion !== to) {
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
  }
  return held(reasons, added, removed);
}

/** Inline-code-safe text: no backticks, no newlines. */
const code = (s: string) => `\`${s.replace(/[`\r\n]/g, "")}\``;
const plain = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/[<>]/g, "");

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
    "Once a piece is cleared, the next sync run takes the bump by itself (or run `bun run scripts/sync-pieces-catalog.ts` and open the PR yourself).");
  for (const h of held) {
    p();
    p(`## ${code(h.id)}: ${code(h.from)} -> ${code(h.to)}`);
    for (const r of h.reasons) {
      p();
      switch (r.kind) {
        case "unmapped":
          p(`**${r.actions.length} action${r.actions.length === 1 ? " is" : "s are"} not in the adapter.** ` +
            "Until mapped, each is gated at the adapter's `unknownActionCategory`, and the governed-pieces test refuses to install them. " +
            "Give each one a category in the adapter's `categories`, at its worst case, and add any prop that names what it acts on to `targetProps`:");
          p();
          for (const a of r.actions) {
            const what = a.description ? ` -- ${plain(a.description)}` : "";
            const props = a.props.length > 0 ? ` Props: ${a.props.map(code).join(", ")}.` : "";
            p(`- ${code(a.name)} (upstream ${a.classification ?? "unclassified"})${what}${props}`);
          }
          break;
        case "classification-raised":
          p("**Upstream now classifies existing actions as more severe.** The same name may do something worse. " +
            "Read what changed, fix the category in the adapter if it no longer fits, then add " +
            `${code(`"${h.id}": "${h.to}"`)} to \`VERIFIED_UPGRADE_REVIEWED\`:`);
          p();
          for (const c of r.changes) p(`- ${code(c.name)}: ${c.from} -> ${c.to}`);
          break;
        case "props-removed":
          p("**Existing actions lost props**, so they changed shape. Check the adapter's `targetProps` still name " +
            `what each acts on, then add ${code(`"${h.id}": "${h.to}"`)} to \`VERIFIED_UPGRADE_REVIEWED\`:`);
          p();
          for (const c of r.changes) p(`- ${code(c.name)}: lost ${c.removed.map(code).join(", ")}`);
          break;
        case "unavailable":
          p(`**The sync could not read the actions:** ${plain(r.error)}. ` +
            "Usually transient (npm, a slow load), and the next run retries. If it repeats, the package itself needs a look.");
          break;
      }
    }
  }
  return out.join("\n") + "\n";
}
