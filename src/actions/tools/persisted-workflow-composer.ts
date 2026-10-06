import { snapshotComposition } from './composition-provenance';
import { createCompositionJournal } from "../../workflows/db/repos/workflow-composition";
import { composeFlow, jobSpecification, type ComposeDeps, type ComposeRequest, type ComposeResult } from "./workflow-composer";
import { getWorkflowDb } from '../../workflows/db/index';

export interface PersistedCompositionOptions {
  projectId?: string;
  /** Synchronous attachment, in the journal's creation transaction, before any provider call. */
  onJournal?: (id: string) => void;
}

/** Production entrypoint for both chat and opportunity composition. Validation
 * is only structural; it does not prove semantic fidelity to a free-text job.
 */
export async function composePersistedFlow(deps: ComposeDeps, input: ComposeRequest, options: PersistedCompositionOptions = {}): Promise<ComposeResult & { compositionRecordId: string }> {
  const request = { ...input };
  request.signal?.throwIfAborted();
  const snapshot = snapshotComposition(deps);
  const journal = getWorkflowDb().transaction(() => {
    const record = createCompositionJournal({ ...jobSpecification(request), provenance: snapshot.provenance }, options.projectId);
    options.onJournal?.(record.id);
    return record;
  }).immediate();
  try {
    const result = await composeFlow({ ...snapshot.deps, onCandidate(candidate) {
      request.signal?.throwIfAborted();
      journal.checkpoint(candidate);
      deps.onCandidate?.(candidate);
    } }, request);
    request.signal?.throwIfAborted();
    journal.finish(result.ok ? "VALIDATED" : "FAILED", result.ok ? [] : result.errors);
    return { ...result, compositionRecordId: journal.id };
  } catch (error) {
    // Preserve cancellation/provider failures. If shutdown closed the captured
    // DB, its last durable checkpoint remains COMPOSING (outcome unknown).
    try { journal.finish("FAILED", [error instanceof Error ? error.message : String(error)]); } catch { /* closed DB */ }
    throw error;
  }
}
