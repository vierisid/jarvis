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
  return {
    id,
    checkpoint(candidate: CompositionCandidate) {
      db.run(`UPDATE workflow_composition SET previous_response = ?, previous_graph = ?, errors = ?, updated = ?
        WHERE id = ? AND state = 'COMPOSING'`, [candidate.previousResponse,
        candidate.previousGraph === null ? null : JSON.stringify(candidate.previousGraph), JSON.stringify(candidate.errors), Date.now(), id]);
    },
    finish(state: "VALIDATED" | "FAILED", errors: string[]) {
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
