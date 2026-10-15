/**
 * The approval an executing call was granted, as ambient context for the
 * agent lifecycle sinks (#932, #963).
 *
 * `orchestrator.spawnSubAgent` and `orchestrator.terminateAgent` are where a
 * spawn or a stop actually happens, whichever path asked for it: a model turn
 * through `manage_agents` / `delegate_task`, the dashboard, the pebble's voice
 * fast path, a workflow step. They gate it there, so a path added later is
 * covered by default. But most of those paths already put the call in front of
 * the person once -- the tool layer raised a card and the person approved it --
 * and asking again at the sink would raise a second card for the same act.
 *
 * So the one execution an approval buys runs inside this scope, and the sink
 * reads it: a decision that needs approval is satisfied when the scope holds an
 * approval for the same category that has not been spent yet. It is spent by
 * the first sink that uses it, so one approved `manage_agents spawn` starts one
 * agent, not every agent the call could reach.
 *
 * WHY AMBIENT. `ToolDefinition.execute(params)` takes the model's arguments and
 * nothing else. An "already approved" flag passed as an argument would be one
 * the model can write. Same reasoning as `reviewed-call-scope.ts`.
 *
 * WHO ENTERS IT. Only trusted code that has itself decided the call may run:
 * the approval executor (an approved card), the realtime voice gate for the
 * categories its documented policy auto-approves, the workflow effect
 * boundary for a delegation it authorised, and the per-call boundary for a
 * workflow-delegated agent's call (#988) whose own card a person approved
 * and which named the act: that one is an approved card too, so its source is
 * 'approval'. Nothing reads it to grant anything the engine denied: a hard
 * deny at the sink still throws.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActionCategory } from '../roles/authority.ts';

/** Where an approval came from; the sink's audit row records it as the row's channel. */
export type ApprovalSource = 'approval' | 'realtime_auto' | 'workflow_effect';

export type ApprovedAction = {
  readonly categories: readonly ActionCategory[];
  readonly approvalId: string | null;
  readonly source: ApprovalSource;
  /** Set by the first sink that uses it. */
  spent: boolean;
};

const store = new AsyncLocalStorage<ApprovedAction>();

/** Run `fn` as the execution an approval of `categories` bought. */
export function runAsApproved<T>(
  grant: { categories: readonly ActionCategory[]; approvalId: string | null; source: ApprovalSource },
  fn: () => T,
): T {
  const live: ApprovedAction = { ...grant, spent: false };
  // The approval buys this call, not whatever outlives it: a timer or a
  // continuation the call scheduled still sees the store, so the grant is
  // spent when the call settles.
  const close = () => { live.spent = true; };
  let result: T;
  try {
    result = store.run(live, fn);
  } catch (err) {
    close();
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(close) as T;
  }
  close();
  return result;
}

/**
 * Run `fn` outside any approval scope. For work that outlives the approved
 * call -- a background task loop -- so it cannot inherit the scope.
 */
export function outsideApprovalScope<T>(fn: () => T): T {
  return store.exit(fn);
}

/**
 * Spend the current approval for `category`, if there is an unspent one.
 * Returns it (now spent), or null when nothing covers `category`. A sink calls
 * this on EVERY decision for the category, not only one that needs approval,
 * so the first act the approved call reaches uses the grant up.
 */
export function spendApproval(category: ActionCategory): ApprovedAction | null {
  const grant = store.getStore();
  if (!grant || grant.spent || !grant.categories.includes(category)) return null;
  grant.spent = true;
  return grant;
}
