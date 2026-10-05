/**
 * Render `src/workflows/pieces-library/verified-manifests-generated.ts`: the
 * action manifest of the version the catalog installs for each verified piece.
 * `governed-pieces.test.ts` checks every action in it is mapped by the piece's
 * governed adapter, which is the property a verified bump has to keep.
 */
import type { PieceManifest } from "./piece-manifest";

export function renderManifestsFile(manifests: Record<string, PieceManifest>): string {
  const lines: string[] = [];
  lines.push("/**");
  lines.push(" * AUTO-GENERATED -- DO NOT EDIT BY HAND.");
  lines.push(" *");
  lines.push(" * Written by `scripts/sync-pieces-catalog.ts`: for each verified piece, the");
  lines.push(" * actions of the version the catalog installs, read from the published");
  lines.push(" * package. `governed-pieces.test.ts` requires every action here to be mapped");
  lines.push(" * by the piece's adapter in `src/workflows/runtime/piece-effects.ts`.");
  lines.push(" *");
  lines.push(" * To refresh without a full sync:  bun run scripts/sync-pieces-catalog.ts --manifests-only");
  lines.push(" */");
  lines.push("");
  lines.push("export interface VerifiedManifest {");
  lines.push("  version: string;");
  lines.push("  /** Upstream classification is READ | SEARCH | WRITE | DESTRUCTIVE, or null. */");
  lines.push("  actions: Array<{ name: string; classification: string | null; props: string[] }>;");
  lines.push("}");
  lines.push("");
  lines.push("export const VERIFIED_MANIFESTS: Record<string, VerifiedManifest> = {");
  for (const id of Object.keys(manifests).sort()) {
    const m = manifests[id]!;
    lines.push(`  ${JSON.stringify(id)}: {`);
    lines.push(`    version: ${JSON.stringify(m.version)},`);
    lines.push("    actions: [");
    for (const a of [...m.actions].sort((x, y) => x.name.localeCompare(y.name))) {
      const entry = { name: a.name, classification: a.classification, props: a.props };
      lines.push(`      ${JSON.stringify(entry)},`);
    }
    lines.push("    ],");
    lines.push("  },");
  }
  lines.push("};");
  return lines.join("\n") + "\n";
}

/** Drop the run-time-only fields before a manifest is committed. */
export function committable(m: PieceManifest): PieceManifest {
  return {
    version: m.version,
    actions: m.actions.map((a) => ({ name: a.name, classification: a.classification, props: a.props })),
  };
}
