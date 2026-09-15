/** Workflow jobs can contain effects without provider receipts. Never replay
 * BEGIN or RESUME automatically; safe effect recovery needs its own contract. */
export const RUN_FLOW = "RUN_FLOW";
export const WORKFLOW_RUN_MAX_ATTEMPTS = 1;

export function maxAttemptsForJob(jobType: string, requested = 3): number {
  return jobType === RUN_FLOW ? WORKFLOW_RUN_MAX_ATTEMPTS : requested;
}

export const WORKFLOW_RETRY_GUIDANCE =
  "Automatic retry is disabled. Check completed effects and reconcile uncertain outcomes before deciding to start a new run.";

export function workflowFailureMessage(error: string): string {
  return error.includes(WORKFLOW_RETRY_GUIDANCE) ? error : `${error}\n${WORKFLOW_RETRY_GUIDANCE}`;
}
