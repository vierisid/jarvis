/**
 * Pieces catalog -- the merge layer.
 *
 * Two inputs:
 *   - `catalog-generated.ts` (auto): every `@activepieces/piece-*` package
 *     known to upstream at the pinned SHA. Refreshed by the sync action.
 *   - `catalog-overrides.ts` (hand): verified-tier promotions, exclusions,
 *     version pins, size overrides, description overrides.
 *
 * This file applies the overrides onto the generated list and exports the
 * final `CATALOG`. Consumers (API routes, installer, UI) read from here and
 * shouldn't reach into the underlying files directly.
 *
 * Trust model:
 *   - `tier: "verified"` -- the id appeared in `VERIFIED` in overrides.
 *     Someone read the source, ran a smoke test, and signed off (date in
 *     `VERIFIED_METADATA`).
 *   - `tier: "community"` -- everything else. Installed from npm at the
 *     user's request, runs inside the engine sandbox, but has not been
 *     individually reviewed. The Library UI surfaces a preamble explaining
 *     this distinction so users opt in with their eyes open.
 */

import { GENERATED, type GeneratedCatalogEntry } from "./catalog-generated";
import {
  DESCRIPTION_OVERRIDE,
  EXCLUDED,
  SIZE_OVERRIDE,
  VERIFIED,
  VERIFIED_METADATA,
  VERSION_PIN,
} from "./catalog-overrides";

export type PieceTier = "verified" | "community";

export interface CatalogEntry {
  /**
   * Stable Jarvis-side id. URL slug, manifest key. NEVER rename once shipped --
   * existing installs reference pieces by this id and would orphan on rename.
   */
  id: string;
  /** npm package name resolved at install time. */
  npmPackage: string;
  /**
   * Semver range bun resolves against. Default `^x.y.z` from the generator;
   * `VERSION_PIN` in overrides can swap to `~x.y.z` or an exact pin.
   */
  versionRange: string;
  displayName: string;
  description: string;
  iconUrl?: string;
  /**
   * Exact version Jarvis last tested end-to-end. For verified pieces this
   * is set by the human reviewer; for community pieces it tracks the latest
   * version the sync script saw on npm.
   */
  vettedVersion: string;
  /**
   * ISO date of the most recent manual audit. Present on verified pieces;
   * undefined on community pieces (they haven't been audited).
   */
  vettedAt?: string;
  sourceUrl: string;
  /** SPDX identifier for the piece's own license (deps may differ). */
  licenseSpdx: string;
  /**
   * Approximate on-disk size of the piece + its transitive deps after
   * `bun install`, in megabytes. Hand-measured via `SIZE_OVERRIDE`;
   * undefined when never measured (most community pieces).
   */
  estimatedSizeMb?: number;
  /** Trust tier. See file header. */
  tier: PieceTier;
}

/**
 * Build the final catalog by applying overrides to the generated list.
 * Computed once at module load -- the inputs are static.
 */
function buildCatalog(): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const g of GENERATED) {
    if (EXCLUDED.has(g.id)) continue;
    out.push(mergeEntry(g));
  }
  // Stable sort: verified first (so they appear at the top of the UI),
  // then alphabetical within tier. Ties stable.
  out.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "verified" ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
  return out;
}

function mergeEntry(g: GeneratedCatalogEntry): CatalogEntry {
  const tier: PieceTier = VERIFIED.has(g.id) ? "verified" : "community";
  const pin = VERSION_PIN[g.id];

  // Merge per the precedence:
  //   - VERSION_PIN beats generated for versionRange + vettedVersion.
  //   - DESCRIPTION_OVERRIDE beats generated for description.
  //   - SIZE_OVERRIDE adds an estimatedSizeMb when the generator had none.
  //   - VERIFIED_METADATA supplies vettedAt for verified entries.
  const entry: CatalogEntry = {
    id: g.id,
    npmPackage: g.npmPackage,
    versionRange: pin?.versionRange ?? g.versionRange,
    vettedVersion: pin?.vettedVersion ?? g.latestVersion,
    displayName: g.displayName,
    description: DESCRIPTION_OVERRIDE[g.id] ?? g.description,
    sourceUrl: g.sourceUrl,
    licenseSpdx: g.licenseSpdx,
    tier,
  };

  const size = SIZE_OVERRIDE[g.id];
  if (size !== undefined) entry.estimatedSizeMb = size;

  if (tier === "verified") {
    const meta = VERIFIED_METADATA[g.id];
    if (meta) entry.vettedAt = meta.vettedAt;
  }

  return entry;
}

/**
 * The merged catalog. Verified pieces first, then community, alphabetised
 * within each tier. Re-exported here is the SINGLE source of truth for
 * callers; never read from `catalog-generated` / `catalog-overrides` directly
 * outside this file.
 */
export const CATALOG: CatalogEntry[] = buildCatalog();

/** Look up a catalog entry by Jarvis-side id. Returns null when missing. */
export function findCatalogEntry(id: string): CatalogEntry | null {
  return CATALOG.find((entry) => entry.id === id) ?? null;
}

/**
 * Stable map keyed by id, useful in callers that look up entries repeatedly
 * (the API route handlers, the reconciler). Re-computed every call -- the
 * catalog is tiny enough that the cost is invisible.
 */
export function catalogById(): Map<string, CatalogEntry> {
  return new Map(CATALOG.map((entry) => [entry.id, entry]));
}
