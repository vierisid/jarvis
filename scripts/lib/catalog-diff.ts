/**
 * Diff two generations of the pieces catalog and turn the delta into a
 * human-readable PR body.
 *
 * Pure + side-effect free so it can be unit-tested and reused: the sync script
 * feeds it the previously-committed `GENERATED` array and the freshly computed
 * one, and gets back a verdict ("safe" vs "review") plus the markdown that
 * becomes the auto-PR description.
 *
 * Why a "safe" verdict can exist at all:
 *   On a normal weekly run the pinned SHA is fixed, so every field sourced from
 *   the monorepo (displayName, description, license, sourceUrl) is frozen --
 *   only npm-derived versions and the generation timestamp can move. A diff
 *   containing nothing but version bumps is therefore mechanical and safe to
 *   merge without a human reading it. Anything else -- a piece entering or
 *   leaving the catalog, a license change, a pinned-SHA bump -- puts
 *   third-party code or a trust assertion in motion and asks for human eyes.
 *
 *   Verified pieces are the exception to "a bump is mechanical": each has a
 *   governed adapter that must cover the version installed. The sync script
 *   checks that per bump (`verified-upgrade.ts`) and holds back the ones that
 *   fail, so a verified bump reaching this diff has passed it. One that did
 *   not -- `checked` does not list it -- forces review, as #664 should have.
 */

/**
 * The shape we diff on. Matches `GeneratedCatalogEntry` from
 * `catalog-generated.ts` field-for-field; declared locally so this module has
 * no dependency on the generated file (which the sync script overwrites).
 */
export interface GeneratedEntryLike {
  id: string;
  npmPackage: string;
  versionRange: string;
  latestVersion: string;
  displayName: string;
  description: string;
  sourceUrl: string;
  licenseSpdx: string;
}

export interface CatalogDiff {
  /** Ids present in the new catalog but not the old one. Third-party code. */
  added: GeneratedEntryLike[];
  /** Ids present in the old catalog but gone from the new one. */
  removed: GeneratedEntryLike[];
  /** Same id, different npm version. The mechanical, expected change. */
  versionChanged: Array<{ id: string; from: string; to: string }>;
  /**
   * Bumps that move a verified piece's installed version WITHOUT having passed
   * the sync script's adapter check. Empty on every run the script makes; it
   * exists so a code path that skips the check fails loudly instead of
   * shipping the bump as "safe" (#664 merged eight unchecked ones and turned
   * `main` red).
   */
  verifiedVersionChanged: Array<{ id: string; from: string; to: string }>;
  /** Same id, different SPDX license. A trust/legal signal -- always flagged. */
  licenseChanged: Array<{ id: string; from: string; to: string }>;
  /**
   * Same id, drift in displayName / description / npmPackage. `sourceUrl` is
   * deliberately excluded -- when the pinned SHA moves every entry's sourceUrl
   * changes at once, which the dedicated `shaChanged` line already explains.
   */
  otherChanged: Array<{ id: string; fields: string[] }>;
  /** Non-null when the pinned SHA moved (a manual bump of the sync script). */
  shaChanged: { from: string; to: string } | null;
  oldCount: number;
  newCount: number;
}

export type Verdict = "safe" | "review";

const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

/** Compute the categorised delta between two catalog generations. */
export function diffCatalogs(
  oldEntries: GeneratedEntryLike[],
  newEntries: GeneratedEntryLike[],
  meta: {
    oldSha: string;
    newSha: string;
    /**
     * Verified ids whose installed version follows the generated one, i.e.
     * VERIFIED minus VERSION_PIN. Required, so a caller cannot forget it and
     * get the old every-bump-is-safe behaviour.
     */
    verified: ReadonlySet<string>;
    /** Verified ids whose bump passed the adapter check this run. */
    checked: ReadonlySet<string>;
  },
): CatalogDiff {
  const oldById = new Map(oldEntries.map((e) => [e.id, e]));
  const newById = new Map(newEntries.map((e) => [e.id, e]));

  const added = newEntries.filter((e) => !oldById.has(e.id)).sort(byId);
  const removed = oldEntries.filter((e) => !newById.has(e.id)).sort(byId);

  const versionChanged: CatalogDiff["versionChanged"] = [];
  const licenseChanged: CatalogDiff["licenseChanged"] = [];
  const otherChanged: CatalogDiff["otherChanged"] = [];

  for (const e of newEntries) {
    const prev = oldById.get(e.id);
    if (!prev) continue; // handled by `added`
    if (prev.latestVersion !== e.latestVersion) {
      versionChanged.push({ id: e.id, from: prev.latestVersion, to: e.latestVersion });
    }
    if (prev.licenseSpdx !== e.licenseSpdx) {
      licenseChanged.push({ id: e.id, from: prev.licenseSpdx, to: e.licenseSpdx });
    }
    const fields: string[] = [];
    if (prev.displayName !== e.displayName) fields.push("displayName");
    if (prev.description !== e.description) fields.push("description");
    if (prev.npmPackage !== e.npmPackage) fields.push("npmPackage");
    if (fields.length > 0) otherChanged.push({ id: e.id, fields });
  }

  versionChanged.sort(byId);
  licenseChanged.sort(byId);
  otherChanged.sort(byId);

  const shaChanged =
    meta.oldSha && meta.oldSha !== meta.newSha
      ? { from: meta.oldSha, to: meta.newSha }
      : null;

  const verifiedVersionChanged = versionChanged.filter(
    (c) => meta.verified.has(c.id) && !meta.checked.has(c.id),
  );

  return {
    added,
    removed,
    versionChanged,
    verifiedVersionChanged,
    licenseChanged,
    otherChanged,
    shaChanged,
    oldCount: oldEntries.length,
    newCount: newEntries.length,
  };
}

/**
 * "safe" only when the diff is purely mechanical: version bumps of unverified
 * pieces (and the always-changing timestamp, which isn't represented here). The
 * moment a piece is added/removed, a license changes, metadata drifts, the
 * pinned SHA moves, or a verified piece's version moves, a human should look.
 */
export function verdictFor(diff: CatalogDiff): Verdict {
  const needsReview =
    diff.added.length > 0 ||
    diff.removed.length > 0 ||
    diff.licenseChanged.length > 0 ||
    diff.otherChanged.length > 0 ||
    diff.verifiedVersionChanged.length > 0 ||
    diff.shaChanged !== null;
  return needsReview ? "review" : "safe";
}

/**
 * True when the diff carries a real catalog update -- anything an entry could
 * change. The generation timestamp is NOT represented here, so a run that only
 * bumped the timestamp returns false. The sync workflow keys PR creation off
 * this: no material change -> no PR (a "safe" verdict with version bumps still
 * counts as a change worth shipping).
 */
export function hasChanges(diff: CatalogDiff): boolean {
  return (
    diff.added.length > 0 ||
    diff.removed.length > 0 ||
    diff.versionChanged.length > 0 ||
    diff.licenseChanged.length > 0 ||
    diff.otherChanged.length > 0 ||
    diff.shaChanged !== null
  );
}

export interface ReportOptions {
  /** Short pinned SHA for the summary line. */
  shortSha: string;
  /** ISO date the catalog was generated. */
  generatedAt: string;
  /** Repo-relative path used in `path:Lnn` references for added pieces. */
  fileLabel: string;
  /** Resolve an id to its 1-based line in the generated file, or null. */
  lineOf: (id: string) => number | null;
  /**
   * Pieces whose npm lookup failed transiently this run, so the previously
   * committed latestVersion was reused (metadata still comes from the pinned
   * SHA, like every other entry). On a routine run -- SHA unchanged -- the
   * whole entry is therefore identical to the previous catalog and produces
   * no diff; on a SHA-bump run metadata changes surface in their own diff
   * sections as usual. Carried-forward status itself never affects the
   * verdict; the reviewer just needs to know these versions may lag npm
   * until the next successful run.
   */
  carriedForward?: Array<{ id: string; version: string }>;
  /** The sync script's verified-bump decisions, taken and held. */
  verifiedUpgrades?: ReadonlyArray<{
    id: string;
    from: string;
    to: string;
    ok: boolean;
    added: string[];
    removed: string[];
    reasons: ReadonlyArray<{ kind: string }>;
  }>;
  /** Where the Tests runs for this PR's branch are listed. */
  testsUrl?: string;
}

/** Collapse a list into a `<details>` block once it gets long. */
const COLLAPSE_THRESHOLD = 12;

/**
 * Make an arbitrary upstream string safe to drop inside an inline code span: a
 * stray backtick would break out of the span and a newline would break the
 * bullet. ids and npm package names are already constrained by the generator's
 * id regex, so only free-form fields (license, npm version) get run through it.
 */
function codeSafe(s: string): string {
  return s.replace(/`/g, "'").replace(/\s+/g, " ").trim();
}

function fmtLicense(spdx: string): string {
  return spdx === "" ? "(unspecified)" : `\`${codeSafe(spdx)}\``;
}

/** Build the full PR body markdown + the verdict it implies. */
export function renderReport(
  diff: CatalogDiff,
  opts: ReportOptions,
): { verdict: Verdict; markdown: string } {
  const verdict = verdictFor(diff);
  const out: string[] = [];
  const p = (line = "") => out.push(line);

  p("## Automated pieces-catalog refresh");
  p();
  p(
    `The sync script walked the activepieces monorepo at \`${opts.shortSha}\` ` +
      "and queried npm for the latest published version of every piece.",
  );
  p();

  // Verdict callout (GitHub alert syntax -- renders as a coloured banner).
  if (verdict === "safe") {
    const n = diff.versionChanged.length;
    const bumps =
      n === 0
        ? "only the generation timestamp moved"
        : `the only entry changes are ${n} version bump${n === 1 ? "" : "s"} from npm`;
    p("> [!NOTE]");
    p(
      `> **Safe to merge.** No pieces were added, removed, or relicensed, every ` +
        `verified bump passed the adapter check, and the pinned SHA is unchanged -- ` +
        `${bumps}. Merge on a green Tests run only: nothing blocks merging a red one, ` +
        `and a bot PR does not show its checks.` +
        (opts.testsUrl ? ` [Tests runs for this branch](${opts.testsUrl}).` : ""),
    );
  } else {
    p("> [!WARNING]");
    p(`> **Manual review required** -- ${reviewReasons(diff)}. See the flagged sections below.`);
  }
  p();

  // Summary table.
  p("### Summary");
  p();
  p("| metric | value |");
  p("| --- | --- |");
  p(`| Generated at | ${opts.generatedAt} |`);
  p(
    `| Pinned SHA | \`${opts.shortSha}\` (${diff.shaChanged ? "changed" : "unchanged"}) |`,
  );
  p(`| Catalog size | ${diff.newCount} (was ${diff.oldCount}) |`);
  p(`| Added | ${diff.added.length} |`);
  p(`| Removed | ${diff.removed.length} |`);
  p(`| Version bumps | ${diff.versionChanged.length} |`);
  p(`| License changes | ${diff.licenseChanged.length} |`);
  p(`| Other metadata | ${diff.otherChanged.length} |`);
  const upgrades = opts.verifiedUpgrades ?? [];
  if (upgrades.length > 0) {
    const taken = upgrades.filter((u) => u.ok).length;
    p(`| Verified upgrades | ${taken} taken, ${upgrades.length - taken} held |`);
  }
  const carried = opts.carriedForward ?? [];
  if (carried.length > 0) {
    p(`| Carried forward (stale) | ${carried.length} |`);
  }
  p();

  if (diff.shaChanged) {
    p("### Pinned SHA changed");
    p();
    p(
      `\`${diff.shaChanged.from}\` -> \`${diff.shaChanged.to}\`. Every piece's ` +
        "`sourceUrl` now points at the new commit, and descriptions / licenses may " +
        "have shifted with it. Treat this as a full re-review, not a routine refresh.",
    );
    p();
  }

  if (diff.verifiedVersionChanged.length > 0) {
    p("### Verified pieces bumped without the adapter check -- review required");
    p();
    p(
      "The sync script checks every verified bump against its governed adapter and " +
        "holds back the ones the adapter no longer covers. These moved without that " +
        "check, which is a bug in the sync: do not merge until each is checked against " +
        "`GOVERNED_PIECE_ADAPTERS` (`src/workflows/runtime/piece-effects.ts`):",
    );
    p();
    for (const c of diff.verifiedVersionChanged) {
      p(`- \`${c.id}\` -- \`${codeSafe(c.from)}\` -> \`${codeSafe(c.to)}\``);
    }
    p();
  }

  const taken = upgrades.filter((u) => u.ok);
  if (taken.length > 0) {
    p("### Verified pieces upgraded");
    p();
    p(
      "Each new version passed the adapter check: every action it offers is mapped, " +
        "no existing action got a more severe upstream classification, and none lost props.",
    );
    p();
    for (const u of taken) {
      const moved: string[] = [];
      if (u.added.length > 0) moved.push(`+${u.added.length} (${u.added.map((a) => `\`${codeSafe(a)}\``).join(", ")}, already mapped)`);
      if (u.removed.length > 0) moved.push(`-${u.removed.length} (${u.removed.map((a) => `\`${codeSafe(a)}\``).join(", ")})`);
      const actions = moved.length > 0 ? `actions ${moved.join(", ")}` : "same action set";
      p(`- \`${u.id}\` -- \`${codeSafe(u.from)}\` -> \`${codeSafe(u.to)}\` -- ${actions}`);
    }
    p();
  }

  const held = upgrades.filter((u) => !u.ok);
  if (held.length > 0) {
    p("### Verified pieces held back");
    p();
    p(
      "These stay at the installed version because the adapter does not cover the new " +
        "one yet. They do not affect this PR; the review issue the sync opened says why " +
        "and how to clear each, and the next run takes the bump once it is cleared.",
    );
    p();
    for (const u of held) {
      const why = [...new Set(u.reasons.map((r) => r.kind))].join(", ");
      p(`- \`${u.id}\` -- stays at \`${codeSafe(u.from)}\`, \`${codeSafe(u.to)}\` available -- ${why}`);
    }
    p();
  }

  if (diff.added.length > 0) {
    p("### Added pieces -- review required");
    p();
    p(
      "Each entry below is new and installs third-party code that has not been " +
        "vetted. Confirm the package name and license before merging:",
    );
    p();
    for (const e of diff.added) {
      const line = opts.lineOf(e.id);
      const where = line === null ? "" : ` -- \`${opts.fileLabel}:${line}\``;
      p(`- \`${e.id}\` -- \`${e.npmPackage}\` -- license ${fmtLicense(e.licenseSpdx)}${where}`);
    }
    p();
  }

  if (diff.removed.length > 0) {
    p("### Removed pieces");
    p();
    p(
      "A piece leaving the catalog means npm answered 404 for its latest release " +
        "(unpublished upstream), or the piece left the monorepo at the pinned SHA " +
        "(renamed or deleted -- a rename shows up as one removal plus one addition). " +
        "Transient npm failures do NOT remove pieces; those are carried forward and " +
        "listed separately. Confirm each removal is intentional:",
    );
    p();
    for (const e of diff.removed) {
      p(`- \`${e.id}\` -- was \`${e.npmPackage}\``);
    }
    p();
  }

  if (carried.length > 0) {
    p("### Stale entries (carried forward)");
    p();
    p(
      "npm could not be reached for these pieces during this run (rate limit or " +
        "outage), so each kept its previously committed version instead of being " +
        "removed; the next successful sync catches them up. Any metadata change " +
        "from the pinned SHA still appears in the sections above. Listed for " +
        "transparency -- staleness alone needs no action:",
    );
    p();
    const rows = carried.map(
      (c) => `- \`${codeSafe(c.id)}\` -- kept at \`${codeSafe(c.version)}\``,
    );
    if (rows.length > COLLAPSE_THRESHOLD) {
      p(`<details><summary>Show ${rows.length} carried-forward pieces</summary>`);
      p();
      for (const r of rows) p(r);
      p();
      p("</details>");
    } else {
      for (const r of rows) p(r);
    }
    p();
  }

  if (diff.licenseChanged.length > 0) {
    p("### License changes -- review required");
    p();
    for (const c of diff.licenseChanged) {
      p(`- \`${c.id}\`: ${fmtLicense(c.from)} -> ${fmtLicense(c.to)}`);
    }
    p();
  }

  if (diff.versionChanged.length > 0) {
    p(`### Version bumps (${diff.versionChanged.length})`);
    p();
    const rows = diff.versionChanged.map(
      (c) => `- \`${c.id}\`: \`${codeSafe(c.from)}\` -> \`${codeSafe(c.to)}\``,
    );
    if (rows.length > COLLAPSE_THRESHOLD) {
      p(`<details><summary>Show ${rows.length} version bumps</summary>`);
      p();
      for (const r of rows) p(r);
      p();
      p("</details>");
    } else {
      for (const r of rows) p(r);
    }
    p();
  }

  if (diff.otherChanged.length > 0) {
    p("### Other metadata changes");
    p();
    for (const c of diff.otherChanged) {
      p(`- \`${c.id}\`: ${c.fields.join(", ")}`);
    }
    p();
  }

  p("---");
  p();
  p(
    "Hand-tuning (verified status, exclusions, version pins, sizes, descriptions) " +
      "lives in `catalog-overrides.ts`, which this refresh does not touch. If a " +
      "newly added piece needs an exclusion, pin, or description override, land it " +
      "in its own PR to main: the next sync run rebuilds this branch from main and " +
      "force-pushes it, so a commit made here is lost.",
  );

  return { verdict, markdown: out.join("\n") + "\n" };
}

/** One-line summary of why review is needed, for the warning callout. */
function reviewReasons(diff: CatalogDiff): string {
  const parts: string[] = [];
  if (diff.added.length > 0) {
    parts.push(`${diff.added.length} piece${diff.added.length === 1 ? "" : "s"} added`);
  }
  if (diff.removed.length > 0) {
    parts.push(`${diff.removed.length} removed`);
  }
  if (diff.licenseChanged.length > 0) {
    parts.push(
      `${diff.licenseChanged.length} license change${diff.licenseChanged.length === 1 ? "" : "s"}`,
    );
  }
  if (diff.shaChanged) {
    parts.push("pinned SHA bumped");
  }
  if (diff.otherChanged.length > 0) {
    parts.push(`${diff.otherChanged.length} metadata change${diff.otherChanged.length === 1 ? "" : "s"}`);
  }
  if (diff.verifiedVersionChanged.length > 0) {
    const n = diff.verifiedVersionChanged.length;
    parts.push(`${n} verified piece${n === 1 ? "" : "s"} bumped without the adapter check`);
  }
  return parts.join(", ");
}
