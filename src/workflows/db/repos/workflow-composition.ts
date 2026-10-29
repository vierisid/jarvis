import { DEFAULT_IDS, getWorkflowDb } from "../index";
import { apId } from "../ids";
import type { CompositionCandidate, WorkflowJobSpecification } from "../../../actions/tools/workflow-composer";

export interface WorkflowCompositionRecord extends CompositionCandidate {
  id: string;
  projectId: string;
  specification: WorkflowJobSpecification;
  state: "COMPOSING" | "VALIDATED" | "FAILED";
  created: number;
  updated: number;
}

/**
 * Journals this process opened and has not finished. A COMPOSING row that is
 * not here was left by a crash or an earlier process: its outcome is unknown
 * and nothing will ever finish it.
 */
const LIVE_JOURNALS = new Set<string>();
/**
 * A live journal that has not checkpointed for this long is treated as stuck.
 * Composition's own budget is three minutes, and connector installs before it
 * each update the row, so a healthy attempt never comes close.
 */
export const COMPOSITION_STALE_MS = 15 * 60_000;

/** True while a COMPOSING record is still being worked on by this process. */
export function compositionInProgress(record: Pick<WorkflowCompositionRecord, "id" | "state" | "updated">, now = Date.now()): boolean {
  return record.state === "COMPOSING" && LIVE_JOURNALS.has(record.id) && now - record.updated < COMPOSITION_STALE_MS;
}

/** Commit the immutable specification before any provider call. The journal
 * captures its DB handle: a late completion must never write to a replacement
 * database after shutdown. Each checkpoint is a short autocommit, with no
 * transaction held across the LLM request.
 */
export function createCompositionJournal(specification: WorkflowJobSpecification, projectId: string = DEFAULT_IDS.project) {
  const db = getWorkflowDb();
  const id = apId();
  const now = Date.now();
  db.run(`INSERT INTO workflow_composition (id, project_id, specification, state, created, updated)
    VALUES (?, ?, ?, 'COMPOSING', ?, ?)`, [id, projectId, JSON.stringify(specification), now, now]);
  LIVE_JOURNALS.add(id);
  return {
    id,
    recordInstalledPiece(piece: NonNullable<NonNullable<WorkflowJobSpecification['provenance']>['installedPieces']>[number]) {
      // Append discovery provenance, without rewriting the immutable user specification.
      db.run(`UPDATE workflow_composition SET specification = json_set(specification,
        '$.provenance.installedPieces', json_insert(COALESCE(json_extract(specification, '$.provenance.installedPieces'), '[]'), '$[#]', json(?))),
        updated = ? WHERE id = ? AND state = 'COMPOSING'`, [JSON.stringify(piece), Date.now(), id]);
    },
    checkpoint(candidate: CompositionCandidate) {
      db.run(`UPDATE workflow_composition SET previous_response = ?, previous_graph = ?, errors = ?, updated = ?
        WHERE id = ? AND state = 'COMPOSING'`, [candidate.previousResponse,
        candidate.previousGraph === null ? null : JSON.stringify(candidate.previousGraph), JSON.stringify(candidate.errors), Date.now(), id]);
    },
    finish(state: "VALIDATED" | "FAILED", errors: string[]) {
      LIVE_JOURNALS.delete(id);
      db.run(`UPDATE workflow_composition SET state = ?, errors = ?, updated = ? WHERE id = ? AND state = 'COMPOSING'`,
        [state, JSON.stringify(errors), Date.now(), id]);
    },
  };
}

export function getWorkflowComposition(id: string, projectId: string = DEFAULT_IDS.project): WorkflowCompositionRecord | null {
  const row = getWorkflowDb().query<{
    id: string; project_id: string; specification: string; state: WorkflowCompositionRecord["state"];
    previous_response: string | null; previous_graph: string | null; errors: string; created: number; updated: number;
  }, [string, string]>("SELECT * FROM workflow_composition WHERE id = ? AND project_id = ?").get(id, projectId);
  return row ? {
    id: row.id, projectId: row.project_id, specification: JSON.parse(row.specification), state: row.state,
    previousResponse: row.previous_response, previousGraph: row.previous_graph === null ? null : JSON.parse(row.previous_graph),
    errors: JSON.parse(row.errors), created: row.created, updated: row.updated,
  } : null;
}


/** Latest attempt in a setup chain, scoped to the caller's project. */
export function latestSetupComposition(rootId: string, projectId: string): WorkflowCompositionRecord | null {
  const row = getWorkflowDb().query<{ id: string }, [string, string]>(
    `SELECT id FROM workflow_composition WHERE project_id = ?
      AND json_extract(specification, '$.context.workflowSetup.rootCompositionId') = ?
      ORDER BY created DESC, rowid DESC LIMIT 1`).get(projectId, rootId);
  return getWorkflowComposition(row?.id ?? rootId, projectId);
}

/** Repeated setup completion returns its existing draft, never creates another. */
export function composedFlowId(compositionId: string, projectId: string): string | null {
  return getWorkflowDb().query<{ id: string }, [string, string]>(
    `SELECT id FROM flow WHERE project_id = ? AND json_valid(metadata)
      AND json_extract(metadata, '$.compositionRecordId') = ? LIMIT 1`).get(projectId, compositionId)?.id ?? null;
}
