import { AsyncLocalStorage } from 'node:async_hooks';

/** Internal observations only. Arguments, results, error text and agent prose never cross this port. */
export interface ExecutionActivity {
  kind: 'tool' | 'agent' | 'task';
  executionId: string;
  phase: 'started' | 'completed' | 'failed';
  toolName?: string;
  refs?: Array<{ kind: 'goal' | 'fact' | 'run'; id: string }>;
}
const observer = new AsyncLocalStorage<((event: ExecutionActivity) => void) | undefined>();
const toolOutcome = new AsyncLocalStorage<{ failed: boolean; settled: boolean }>();
export function withExecutionProgress<T>(observe: ((event: ExecutionActivity) => void) | undefined, run: () => T): T {
  return observer.run(observe, run);
}
export function reportExecutionActivity(event: ExecutionActivity): boolean {
  const observe = observer.getStore();
  if (!observe) return false;
  try { observe(event); } catch { /* Progress cannot alter a tool's result or trigger a retry. */ }
  return true;
}
export function beginExecutionActivity(kind: ExecutionActivity['kind'], toolName?: string) {
  if (!observer.getStore()) return (_phase: 'completed' | 'failed') => {};
  const executionId = crypto.randomUUID();
  reportExecutionActivity({ kind, executionId, phase: 'started', toolName });
  let settled = false;
  return (phase: 'completed' | 'failed') => {
    if (settled) return;
    settled = true; reportExecutionActivity({ kind, executionId, phase, toolName });
  };
}

/**
 * A trusted adapter marks a known failure where it occurs, retaining its legacy
 * return value. Never infer status from file bytes, model prose or result shape.
 * The outcome belongs to this invocation only, including nested/concurrent tools.
 */
export function failedToolResult<T>(result: T): T {
  const outcome = toolOutcome.getStore();
  if (observer.getStore() && outcome && !outcome.settled) outcome.failed = true;
  return result;
}
export async function observeToolExecution<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!observer.getStore()) return run();
  const finish = beginExecutionActivity('tool', name);
  const outcome = { failed: false, settled: false };
  return toolOutcome.run(outcome, async () => {
    try {
      const result = await run();
      // Completion means the call returned, not proof that arbitrary content
      // or an uninstrumented legacy tool's requested effect was successful.
      finish(outcome.failed ? 'failed' : 'completed');
      return result;
    } catch (error) { finish('failed'); throw error; }
    finally { outcome.settled = true; }
  });
}
