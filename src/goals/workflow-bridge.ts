/**
 * Goal → Workflow Bridge
 *
 * Auto-generates cron-triggered workflows for morning plan and evening review.
 * Also supports creating recurring task workflows for goals with repeating work.
 */

import type { GoalConfig } from '../config/types.ts';
import { getDb } from '../vault/schema.ts';
import { getWorkItem, WorkItemError } from './work-items.ts';
import { getFlow } from '../workflows/db/repos/flow.ts';
import { getFlowVersion } from '../workflows/db/repos/flow-version.ts';
import { createFlowRun, type FlowRun } from '../workflows/db/repos/flow-run.ts';
import { enqueue } from '../workflows/db/repos/job-queue.ts';

/** The real plan-to-execution bridge. All writes share the vault transaction. */
export function startWorkItemRun(workItemId: string, workflowId: string): FlowRun {
  return getDb().transaction(() => {
    const work = getWorkItem(workItemId);
    if (work.mode !== 'workflow' || work.workflowId !== workflowId || !work.workflowVersionId) {
      throw new WorkItemError('Work item does not reference this workflow', 409);
    }
    if (work.decision?.outcome !== 'accepted') throw new WorkItemError('Accept the work proposal before running it', 409);
    // A repeated click/retry after an HTTP disconnect returns the original run.
    if (work.runId) {
      if (!work.run) throw new WorkItemError('Linked run is unavailable; create a new proposal to retry', 409);
      return work.run;
    }
    if (work.blocker || work.resultCheck) throw new WorkItemError('Work is blocked or already checked', 409);
    const flow = getFlow(workflowId);
    const version = getFlowVersion(work.workflowVersionId);
    if (!flow || !version || version.flowId !== workflowId || version.state !== 'LOCKED') {
      throw new WorkItemError('The accepted workflow version is unavailable', 409);
    }
    const run = createFlowRun({
      flowId: workflowId, flowVersionId: version.id, environment: 'PRODUCTION',
      triggeredBy: `work_item:${work.id}:decision:${work.decision.id}`, startTime: Date.now(),
    });
    enqueue({
      jobType: 'RUN_FLOW', payload: { runId: run.id, payload: work.input },
      flowRunId: run.id, flowId: workflowId, flowVersionId: version.id, maxAttempts: 1,
    });
    getDb().run('UPDATE commitment_work SET run_id = ?, updated_at = ? WHERE work_id = ?', [run.id, Date.now(), work.id]);
    getDb().run("UPDATE commitments SET status = 'active' WHERE id = ?", [work.id]);
    return run;
  })();
}

/**
 * Workflow definition for the goal system's daily rhythm.
 * These can be registered with the TriggerManager when both
 * the workflow engine and goal service are available.
 */
export type GoalWorkflowDefinition = {
  id: string;
  name: string;
  description: string;
  triggerType: 'cron';
  cronExpression: string;
  action: 'morning_plan' | 'evening_review';
};

/**
 * Generate workflow definitions for the daily rhythm check-ins.
 * Returns cron-triggered workflow specs that can be registered with the engine.
 */
export function generateRhythmWorkflows(config: GoalConfig): GoalWorkflowDefinition[] {
  if (!config.enabled) return [];

  const workflows: GoalWorkflowDefinition[] = [];

  const morningWindow = config.morning_window ?? { start: 7, end: 9 };
  const eveningWindow = config.evening_window ?? { start: 20, end: 22 };

  // Morning plan: fire at the start of the morning window
  workflows.push({
    id: 'goal_morning_plan',
    name: 'Morning Goal Plan',
    description: 'Automated morning planning session — reviews active goals, generates daily actions, and sets focus areas.',
    triggerType: 'cron',
    cronExpression: `0 ${morningWindow.start} * * *`, // e.g., "0 7 * * *"
    action: 'morning_plan',
  });

  // Evening review: fire at the start of the evening window
  workflows.push({
    id: 'goal_evening_review',
    name: 'Evening Goal Review',
    description: 'Automated evening review — scores daily progress, generates accountability assessment, and updates goal health.',
    triggerType: 'cron',
    cronExpression: `0 ${eveningWindow.start} * * *`, // e.g., "0 20 * * *"
    action: 'evening_review',
  });

  return workflows;
}

/**
 * Register goal rhythm workflows with the trigger manager.
 * This bridges goal check-ins with the workflow execution system.
 *
 * When the workflow fires, it calls the goalService's daily rhythm methods.
 */
export function registerGoalWorkflows(
  goalWorkflows: GoalWorkflowDefinition[],
  triggerManager: { fireTrigger: (workflowId: string, triggerType: string, data?: Record<string, unknown>) => void },
): void {
  // Note: GoalService schedules its own cron jobs (goals:morning / goals:evening)
  // derived from config.goals.morning_window / evening_window. This bridge
  // function exists for future use when we want to create full workflow graph
  // executions for morning/evening routines.
  //
  // For now, we just log the available workflows.
  for (const wf of goalWorkflows) {
    console.log(`[GoalWorkflowBridge] Registered: ${wf.name} (${wf.cronExpression})`);
  }
}

/**
 * Handle a goal workflow trigger firing.
 * Called from the goal service when daily rhythm check-ins happen.
 */
export async function handleGoalWorkflowTrigger(
  action: 'morning_plan' | 'evening_review',
  goalService: { getGoal: (id: string) => unknown },
  onComplete?: (result: Record<string, unknown>) => void,
): Promise<void> {
  console.log(`[GoalWorkflowBridge] Executing ${action}`);

  // The actual planning/review logic is in rhythm.ts
  // This bridge just provides the workflow integration layer
  if (onComplete) {
    onComplete({ action, completedAt: Date.now() });
  }
}
