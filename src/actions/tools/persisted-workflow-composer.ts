import { snapshotComposition } from './composition-provenance';
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
  onJournal?: (id: string) => void): Promise<ComposeResult & { compositionRecordId: string }> {
  // Snapshot the job (including supplemental context and selected ingredients) so caller mutations cannot change intent mid-await.
  const request = { ...jobSpecification(input), signal: input.signal };
  request.signal?.throwIfAborted();
  const snapshot = snapshotComposition(deps);
  const journal = getWorkflowDb().transaction(() => {
    const record = createCompositionJournal({ ...jobSpecification(request), provenance: snapshot.provenance }, projectId);
    onJournal?.(record.id);
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
