/**
 * Which flow versions still need their CODE-step tree under
 * `~/.jarvis/workflow-codes/<versionId>` (#865). Read by the pruner
 * (runner/engine-runtime/code-tree-prune.ts); a tree for any other version is
 * removable once nothing in this process is running it and it has not been
 * used recently.
 *
 * A tree is rebuilt from the version row on every engine run, so pruning one
 * never makes a run impossible. What these rules protect is the run that
 * would otherwise reinstall in the middle of its life: a paused run resuming
 * days later would fetch its packages again, and a range or dist-tag can
 * resolve to a different version by then.
 */
import { getWorkflowDb } from "../index";

/**
 * Statuses a run cannot leave. Anything else, including a status this list
 * does not know, keeps the run's tree: an unknown status is treated as a run
 * that may still continue.
 */
const TERMINAL_RUN_STATUSES = [
  "SUCCEEDED",
  "FAILED",
  "TIMEOUT",
  "INTERNAL_ERROR",
  "QUOTA_EXCEEDED",
  "STOPPED",
  "MEMORY_LIMIT_EXCEEDED",
  "SCHEDULE_FAILURE",
] as const;

const TERMINAL = TERMINAL_RUN_STATUSES.map((s) => `'${s}'`).join(", ");

/**
 * Every version id whose tree must stay:
 *   - the published version of any flow (its next trigger runs it);
 *   - each flow's current draft, the one the editor shows and test-runs
 *     (brief_workflow_draft_selection, the selector getLatestDraft reads).
 *     Not every DRAFT row: a new draft is a new row and older ones are never
 *     locked or deleted, so keeping them all would pin a tree for every draft
 *     ever test-run. An older draft run again simply installs again;
 *   - the version of every run that has not finished: queued, running, or
 *     paused on a waitpoint, a child run or an approval. A run waiting on a
 *     waitpoint is PAUSED, so waitpoints need no rule of their own, and one
 *     left on a finished run cannot resume it;
 *   - the version named by any queued or running job.
 */
export function versionIdsNeedingCodeTrees(): Set<string> {
  const rows = getWorkflowDb()
    .query<{ id: string | null }, []>(
      `SELECT published_version_id AS id FROM flow WHERE published_version_id IS NOT NULL
       UNION SELECT version_id FROM brief_workflow_draft_selection WHERE version_id IS NOT NULL
       UNION SELECT flow_version_id FROM flow_run WHERE status NOT IN (${TERMINAL})
       UNION SELECT flow_version_id FROM workflow_job
              WHERE status IN ('QUEUED', 'RUNNING') AND flow_version_id IS NOT NULL`,
    )
    .all();
  const out = new Set<string>();
  for (const { id } of rows) if (id) out.add(id);
  return out;
}
