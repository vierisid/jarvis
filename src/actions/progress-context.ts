import { AsyncLocalStorage } from 'node:async_hooks';
import { isActionOutcome } from './action-outcome.ts';

/** Internal observations only. Arguments, results, error text and agent prose never cross this port. */
export interface ExecutionActivity {
  kind: 'tool' | 'agent' | 'task';
  executionId: string;
  phase: 'started' | 'completed' | 'failed';
  toolName?: string;
  refs?: Array<{ kind: 'goal' | 'fact' | 'run'; id: string }>;
}
const observer = new AsyncLocalStorage<((event: ExecutionActivity) => void) | undefined>();
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

/** Legacy tools may return a failure instead of throwing. No result text is published. */
function failedResult(value: unknown): boolean {
  if (isActionOutcome(value)) return value.status !== 'succeeded';
  if (value && typeof value === 'object') {
    const result = value as Record<string, unknown>;
    return result.success === false || result.ok === false || result.isError === true || !!result.error;
  }
  return typeof value === 'string' && /^(?:Error\b|\[(?:ERROR|ACTION_FAILED|NOT RUN|AUTHORITY DENIED)\])/i.test(value.trimStart());
}
export async function observeToolExecution<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!observer.getStore()) return run();
  const finish = beginExecutionActivity('tool', name);
  try {
    const result = await run();
    let failed = false;
    try { failed = failedResult(result); } catch { failed = true; }
    finish(failed ? 'failed' : 'completed');
    return result;
  } catch (error) { finish('failed'); throw error; }
}
