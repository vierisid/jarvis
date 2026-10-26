import { PieceCatalog } from '../../workflows/runtime/piece-catalog';
import { fingerprint, snapshotComposition } from './composition-provenance';
import { createCompositionJournal } from "../../workflows/db/repos/workflow-composition";
import { composeFlow, jobSpecification, type ComposeDeps, type ComposeRequest, type ComposeResult } from "./workflow-composer";
import { getWorkflowDb } from '../../workflows/db/index';

/** Production entrypoint for both chat and opportunity composition. Validation
 * is structural, plus the caller's job contract when one is stated; neither
 * proves semantic fidelity to a free-text job.
 */
export async function composePersistedFlow(deps: ComposeDeps, input: ComposeRequest,
  /** The project the journal is recorded in: the one the composed flow will be created in (#844). */
  projectId?: string,
  /** Synchronous attachment, in the journal's creation transaction, before any provider call. */
  onJournal?: (id: string) => void,
  /**
   * Library IDs a person approved installing for this composition. They are
   * installed, in order, before the composer starts, and the composer's own
   * tool loop is then given no installer: the approval named these entries,
   * so nothing else can be installed under it.
   */
  preinstall: readonly string[] = []): Promise<ComposeResult & { compositionRecordId: string; installedPieces?: string[]; alreadyInstalledPieces?: string[]; installationErrors?: string[] }> {
  // Snapshot the job (including supplemental context and selected ingredients) so caller mutations cannot change intent mid-await.
  const request = { ...jobSpecification(input), signal: input.signal };
  request.signal?.throwIfAborted();
  const snapshot = snapshotComposition(deps);
  const journal = getWorkflowDb().transaction(() => {
    const record = createCompositionJournal({ ...jobSpecification(request), provenance: snapshot.provenance }, projectId);
    onJournal?.(record.id);
    return record;
  }).immediate();
  // Install only explicitly requested Library entries into the frozen discovery
  // catalog. Unrelated concurrent refreshes must not change a repair's contracts.
  if (deps.installLibraryPiece) snapshot.deps.installLibraryPiece = async (id, signal) => {
    request.signal?.throwIfAborted();
    const entry = snapshot.deps.library?.find(candidate => candidate.id === id);
    if (!entry) throw new Error('Unknown Library entry');
    await deps.installLibraryPiece!(id, signal);
    const actual = deps.pieceRegistry.get(entry.npmPackage);
    if (!actual) throw new Error('Installed piece metadata is unavailable');
    const metadata = JSON.parse(JSON.stringify(actual));
    journal.recordInstalledPiece({ id, name: actual.name, version: actual.version, sha256: fingerprint(metadata) });
    request.signal?.throwIfAborted();
    signal?.throwIfAborted();
    (snapshot.deps.pieceRegistry as PieceCatalog).upsert(metadata);
  };
  const installedPieces: string[] = [], alreadyInstalledPieces: string[] = [], installationErrors: string[] = [];
  try {
    if (preinstall.length) {
      const install = snapshot.deps.installLibraryPiece;
      if (!install) throw new Error('Library installation is not available in this context');
      delete snapshot.deps.installLibraryPiece;
      for (const id of preinstall) {
        const entry = snapshot.deps.library?.find(candidate => candidate.id === id);
        if (entry && snapshot.deps.pieceRegistry.get(entry.npmPackage)) { alreadyInstalledPieces.push(id); continue; }
        try {
          await install(id, request.signal);
          installedPieces.push(id);
        } catch (error) {
          request.signal?.throwIfAborted();
          installationErrors.push(`Could not install ${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const result = await composeFlow({ ...snapshot.deps, onCandidate(candidate) {
      request.signal?.throwIfAborted();
      journal.checkpoint(candidate);
      deps.onCandidate?.(candidate);
    } }, request);
    request.signal?.throwIfAborted();
    journal.finish(result.ok ? "VALIDATED" : "FAILED", result.ok ? [] : result.errors);
    return { ...result, compositionRecordId: journal.id,
      ...(installedPieces.length ? { installedPieces } : {}),
      ...(alreadyInstalledPieces.length ? { alreadyInstalledPieces } : {}),
      ...(installationErrors.length ? { installationErrors } : {}) };
  } catch (error) {
    // Preserve cancellation/provider failures. If shutdown closed the captured
    // DB, its last durable checkpoint remains COMPOSING (outcome unknown).
    try { journal.finish("FAILED", [error instanceof Error ? error.message : String(error)]); } catch { /* closed DB */ }
    // Connectors installed before the failure stay installed (the journal
    // records them); the caller reports them with the error.
    if (installedPieces.length && error && typeof error === "object") {
      try { Object.assign(error, { installedPieces: [...installedPieces] }); } catch { /* frozen error */ }
    }
    throw error;
  }
}
