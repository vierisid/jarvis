/**
 * The verified-piece half of the catalog sync, split in two so that no job
 * holding a write token ever runs piece code:
 *
 *   inspect (read-only job)   `planInspection` names the versions worth
 *                             reading, `scripts/inspect-verified-pieces.ts`
 *                             loads each one and writes their manifests as
 *                             JSON. That job has no token in its environment
 *                             and no credentials on disk.
 *   sync (the writing job)    `parseInspection` validates that JSON -- it was
 *                             produced next to third-party code, so it is
 *                             untrusted input -- and `decideVerified` takes the
 *                             bumps the governed adapter covers and holds the
 *                             rest. Nothing here executes a package.
 *
 * Every decision is made against what is INSTALLED, which is the committed
 * manifest (`verified-manifests-generated.ts`), not against the previous
 * generated version: a pinned piece's generated version follows npm unchecked,
 * so unpinning one would otherwise skip the check.
 */
import { assessVerifiedUpgrade, compareVersions, type UpgradeAssessment } from "./verified-upgrade";
import type { ManifestResult, PieceAction, PieceManifest } from "./piece-manifest";
import { committable } from "./verified-manifests";

/** A verified catalog entry as the sync builds it. `latestVersion` is rewritten on a hold. */
export interface VerifiedEntry {
  id: string;
  npmPackage: string;
  latestVersion: string;
}

export interface VerifiedPolicy {
  /** Committed manifests: the actions of what is installed now. */
  committed: Record<string, PieceManifest>;
  /** `VERSION_PIN`: a pinned piece installs its pin, decided by hand. */
  pins: Record<string, { vettedVersion: string }>;
  /** `VERIFIED_UPGRADE_REVIEWED`: id -> the newest version a person signed off. */
  reviewed: Record<string, string>;
}

const key = (pkg: string, version: string) => `${pkg}@${version}`;
const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

/**
 * Which versions the inspect job should read: the npm latest when it differs
 * from what is installed, a sign-off between the two (the baseline the checks
 * compare from), a changed pin, and the installed version itself when nothing
 * is committed for it.
 */
export function planInspection(
  pieces: ReadonlyArray<{ id: string; npmPackage: string; installed: string; latest: string | null }>,
  policy: VerifiedPolicy,
): Array<{ pkg: string; version: string }> {
  const want = new Map<string, { pkg: string; version: string }>();
  const add = (pkg: string, version: string) => want.set(key(pkg, version), { pkg, version });
  for (const p of pieces) {
    const committed = own(policy.committed, p.id);
    const pin = own(policy.pins, p.id);
    if (pin) {
      if (committed?.version !== pin.vettedVersion) add(p.npmPackage, pin.vettedVersion);
      continue;
    }
    const installed = committed?.version ?? p.installed;
    if (!committed) add(p.npmPackage, installed);
    if (!p.latest || compareVersions(p.latest, installed) <= 0) continue;
    add(p.npmPackage, p.latest);
    const signed = own(policy.reviewed, p.id);
    if (signed && compareVersions(signed, installed) > 0 && compareVersions(signed, p.latest) < 0) {
      add(p.npmPackage, signed);
    }
  }
  return [...want.values()];
}

/**
 * Take each verified bump the adapter covers, hold the rest at the installed
 * version, and collect the manifest of whatever ends up installed.
 *
 * `lookup` answers from the inspect job's output and returns null for a
 * version that was not inspected. `inconclusive` lists ids this run could not
 * decide about at all (npm unanswered, a pin unreadable): the workflow keeps
 * the review issue open rather than declaring "nothing held" on a guess.
 */
export function decideVerified(input: {
  entries: VerifiedEntry[];
  previousVersion: (id: string) => string | undefined;
  carriedForward: ReadonlySet<string>;
  policy: VerifiedPolicy;
  lookup: (pkg: string, version: string) => ManifestResult | null;
  isMapped: (pkg: string, action: string) => boolean;
}): {
  manifests: Record<string, PieceManifest>;
  assessments: UpgradeAssessment[];
  inconclusive: string[];
  notes: string[];
} {
  const manifests: Record<string, PieceManifest> = {};
  const assessments: UpgradeAssessment[] = [];
  const inconclusive: string[] = [];
  const notes: string[] = [];

  for (const entry of input.entries) {
    const { id, npmPackage: pkg } = entry;
    let committed = own(input.policy.committed, id) ?? null;
    const get = (version: string): ManifestResult =>
      committed?.version === version
        ? { kind: "ok", manifest: committed }
        : input.lookup(pkg, version) ?? { kind: "error", error: `${pkg}@${version} was not inspected this run` };
    const record = (m: PieceManifest) => (manifests[id] = committable(m));

    const pin = own(input.policy.pins, id);
    if (pin) {
      const r = get(pin.vettedVersion);
      if (r.kind === "ok") record(r.manifest);
      else {
        if (committed) record(committed);
        inconclusive.push(id);
        notes.push(`${id}: could not read the pinned ${pin.vettedVersion} (${r.error})`);
      }
      continue;
    }
    if (input.carriedForward.has(id)) {
      // npm did not answer, so there is no candidate to decide about.
      if (committed) record(committed);
      inconclusive.push(id);
      continue;
    }

    const previous = input.previousVersion(id);
    if (!committed) {
      if (previous === undefined) {
        // A verified id new to the catalog arrives in a hand-made PR that adds
        // its adapter; record what it installs and let the test check it.
        const r = get(entry.latestVersion);
        if (r.kind === "ok") record(r.manifest);
        else inconclusive.push(id);
        continue;
      }
      const r = get(previous);
      if (r.kind === "ok") committed = r.manifest;
      else {
        entry.latestVersion = previous;
        inconclusive.push(id);
        notes.push(`${id}: no manifest for the installed ${previous} (${r.error}); held`);
        continue;
      }
    }

    const installed = committed.version;
    const target = entry.latestVersion;
    if (target === installed) {
      record(committed);
      continue;
    }
    if (compareVersions(target, installed) < 0) {
      // npm's latest moved backwards (an unpublish or a re-tag). Never take a
      // downgrade on its own.
      entry.latestVersion = installed;
      record(committed);
      notes.push(`${id}: npm latest ${target} is older than the installed ${installed}; kept ${installed}`);
      continue;
    }

    const signed = own(input.policy.reviewed, id);
    const baselineVersion =
      signed && compareVersions(signed, installed) > 0 && compareVersions(signed, target) <= 0 ? signed : installed;
    const candidate = get(target);
    const baseline = baselineVersion === target ? candidate : get(baselineVersion);
    const assessment = assessVerifiedUpgrade({
      id,
      from: installed,
      to: target,
      baseline,
      candidate,
      isMapped: (action) => input.isMapped(pkg, action),
    });
    assessments.push(assessment);
    if (assessment.ok && candidate.kind === "ok") {
      record(candidate.manifest);
    } else {
      entry.latestVersion = installed;
      record(committed);
    }
  }
  return { manifests, assessments, inconclusive, notes };
}

/** What the inspect job writes. */
export interface Inspection {
  manifests: Array<{ pkg: string; version: string; result: ManifestResult }>;
}

const PKG = /^@activepieces\/piece-[a-z][a-z0-9-]{0,80}$/;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const NAME = /^[A-Za-z0-9_.:$-]{1,120}$/;
const CLASSIFICATION = /^[A-Z_]{1,40}$/;
const MAX_ACTIONS = 1000;
const MAX_PROPS = 300;

/**
 * Validate the inspect job's output. It was written in a job that ran
 * third-party code, so a field is trusted only after it matches the shape a
 * real manifest has; one bad entry turns into an `error` result (which holds
 * that bump), and a malformed file throws, failing the run before anything is
 * written. Free text (displayName, description) is kept but length-capped; it
 * is only ever shown inside a code span.
 */
export function parseInspection(raw: unknown): Map<string, ManifestResult> {
  const out = new Map<string, ManifestResult>();
  const list = (raw as Inspection | null)?.manifests;
  if (!Array.isArray(list) || list.length > 200) throw new Error("inspection: `manifests` must be an array of at most 200");
  for (const item of list) {
    const pkg = (item as { pkg?: unknown })?.pkg;
    const version = (item as { version?: unknown })?.version;
    if (typeof pkg !== "string" || !PKG.test(pkg) || typeof version !== "string" || !VERSION.test(version)) {
      throw new Error("inspection: an entry has no valid pkg/version");
    }
    out.set(key(pkg, version), validateResult((item as { result?: unknown }).result, version));
  }
  return out;
}

function validateResult(r: unknown, version: string): ManifestResult {
  const bad = (why: string): ManifestResult => ({ kind: "error", error: `inspection output rejected: ${why}` });
  const result = r as { kind?: unknown; error?: unknown; manifest?: { version?: unknown; actions?: unknown } } | null;
  if (result?.kind === "error") {
    return { kind: "error", error: typeof result.error === "string" ? result.error.slice(0, 300) : "unknown error" };
  }
  if (result?.kind !== "ok" || !result.manifest) return bad("not an ok or error result");
  if (result.manifest.version !== version) return bad("manifest version does not match");
  const actions = result.manifest.actions;
  if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) return bad("actions is not a bounded array");
  const clean: PieceAction[] = [];
  const seen = new Set<string>();
  for (const a of actions as Array<Record<string, unknown>>) {
    const name = a?.name;
    if (typeof name !== "string" || !NAME.test(name)) return bad("an action name has an unexpected shape");
    if (seen.has(name)) return bad(`duplicate action ${name}`);
    seen.add(name);
    const classification = a.classification;
    if (classification !== null && (typeof classification !== "string" || !CLASSIFICATION.test(classification))) {
      return bad(`action ${name} has an unexpected classification`);
    }
    const props = a.props;
    if (!Array.isArray(props) || props.length > MAX_PROPS || !props.every((p) => typeof p === "string" && NAME.test(p))) {
      return bad(`action ${name} has unexpected props`);
    }
    const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
    const displayName = text(a.displayName, 120);
    const description = text(a.description, 400);
    clean.push({
      name,
      classification: classification as string | null,
      props: [...(props as string[])].sort(),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(description !== undefined ? { description } : {}),
    });
  }
  return { kind: "ok", manifest: { version, actions: clean } };
}

/** Index a parsed inspection for `decideVerified`'s `lookup`. */
export function lookupIn(inspection: Map<string, ManifestResult>) {
  return (pkg: string, version: string) => inspection.get(key(pkg, version)) ?? null;
}
