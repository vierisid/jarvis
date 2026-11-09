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
 * Statuses a run cannot leave. A status outside this list and outside
 * QUEUED, RUNNING and PAUSED (one this code does not know) keeps the run's
 * tree: it is treated as a run that may still continue. QUEUED, RUNNING and
 * PAUSED keep it only as versionIdsPinnedByRuns says.
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
 * Version ids whose tree a run that can still continue needs (#1154). These
 * are kept whatever the size budget says: reinstalling under such a run could
 * resolve a range or dist-tag to something else.
 *
 * A run pins its version only while something can still move it on:
 *   - it is PAUSED on a waitpoint nobody has resumed yet (a timer, a webhook,
 *     a child run, an approval: each waits on a waitpoint);
 *   - a queued or running job names it, or its version (a run being started,
 *     resumed or retried; a QUEUED run is started by its job);
 *   - its status is one this list does not know, which is treated as a run
 *     that may still continue.
 * Before #1154 every QUEUED, RUNNING or PAUSED run pinned its tree, so a run
 * left RUNNING by a crash with no job left to recover it, QUEUED with its job
 * never enqueued (the API creates the run, then the job, outside one
 * transaction), or PAUSED with every waitpoint already consumed, pinned its
 * tree forever. Such a run cannot
 * continue without a job, and a run executing in this process holds a lease
 * (code-materialize.ts) whatever its row says.
 */
export function versionIdsPinnedByRuns(): Set<string> {
  const rows = getWorkflowDb()
    .query<{ id: string | null }, []>(
      `SELECT r.flow_version_id AS id FROM flow_run r WHERE r.status = 'PAUSED'
              AND EXISTS (SELECT 1 FROM waitpoint w WHERE w.flow_run_id = r.id AND w.resumed_at IS NULL)
       UNION SELECT flow_version_id FROM flow_run
              WHERE status NOT IN ('QUEUED', 'RUNNING', 'PAUSED', ${TERMINAL})
       UNION SELECT r.flow_version_id FROM flow_run r JOIN workflow_job j
              ON j.flow_run_id = r.id
              OR (j.flow_run_id IS NULL AND CASE WHEN json_valid(j.payload) THEN json_extract(j.payload, '$.runId') END = r.id)
              WHERE r.status IN ('QUEUED', 'RUNNING', 'PAUSED') AND j.status IN ('QUEUED', 'RUNNING')
       UNION SELECT flow_version_id FROM workflow_job
              WHERE status IN ('QUEUED', 'RUNNING') AND flow_version_id IS NOT NULL`,
    )
    .all();
  const out = new Set<string>();
  for (const { id } of rows) if (id) out.add(id);
  return out;
}

/**
 * Every version id whose tree must stay:
 *   - the published version of any flow (its next trigger runs it);
 *   - each flow's current draft, the one the editor shows and test-runs
 *     (brief_workflow_draft_selection, the selector getLatestDraft reads).
 *     Not every DRAFT row: a new draft is a new row and older ones are never
 *     locked or deleted, so keeping them all would pin a tree for every draft
 *     ever test-run. An older draft run again simply installs again;
 *   - what versionIdsPinnedByRuns returns.
 * The first two only stay within the code directory's size budget
 * (code-tree-prune.ts); a version that runs again after its tree was evicted
 * installs again.
 */
export function versionIdsNeedingCodeTrees(): Set<string> {
  const rows = getWorkflowDb()
    .query<{ id: string | null }, []>(
      `SELECT published_version_id AS id FROM flow WHERE published_version_id IS NOT NULL
       UNION SELECT version_id FROM brief_workflow_draft_selection WHERE version_id IS NOT NULL`,
    )
    .all();
  const out = versionIdsPinnedByRuns();
  for (const { id } of rows) if (id) out.add(id);
  return out;
}
