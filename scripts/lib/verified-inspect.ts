/**
 * Read the manifests the verified-piece decision needs. This RUNS PIECE CODE
 * (see `piece-manifest.ts`), so in CI it only runs in the read-only `inspect`
 * job, through `scripts/inspect-verified-pieces.ts`; the writing job reads the
 * result with `parseInspection`. Locally, the sync script calls it in-process
 * when no `--inspection` file is given.
 */
import type { NpmClient } from "./npm-latest";
import { fetchPieceManifest, type ManifestResult } from "./piece-manifest";
import { planInspection, type Inspection, type VerifiedPolicy } from "./verified-sync";

export async function inspectVerified(opts: {
  /** Every verified catalog entry, with the version it installs today. */
  pieces: ReadonlyArray<{ id: string; npmPackage: string; installed: string }>;
  policy: VerifiedPolicy;
  npm: NpmClient;
  fetchManifest?: (pkg: string, version: string) => Promise<ManifestResult>;
  log?: (msg: string) => void;
}): Promise<Inspection> {
  const fetchManifest = opts.fetchManifest ?? ((pkg, version) => fetchPieceManifest(pkg, version));
  const log = opts.log ?? (() => {});
  const withLatest = [];
  for (const p of opts.pieces) {
    const latest = Object.hasOwn(opts.policy.pins, p.id) ? null : await opts.npm.fetchLatest(p.npmPackage);
    withLatest.push({ ...p, latest: latest?.kind === "ok" ? latest.version : null });
  }
  const manifests: Inspection["manifests"] = [];
  for (const { pkg, version } of planInspection(withLatest, opts.policy)) {
    const result = await fetchManifest(pkg, version);
    log(`${pkg}@${version}: ${result.kind === "ok" ? `${result.manifest.actions.length} actions` : result.error}`);
    manifests.push({ pkg, version, result });
  }
  return { manifests };
}
