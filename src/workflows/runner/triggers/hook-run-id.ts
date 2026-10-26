/**
 * Run ids for trigger hooks (enable, disable, poll). A hook runs in an engine
 * sandbox like a flow run does, but it has no flow_run row, so the sandbox's
 * run id is the only thing that says which flow it serves. The sandbox API
 * reads the flow back out of it to bind a hook's writes (step files) to that
 * flow, which is why the format lives here and both sides use it.
 */

export type TriggerHookKind = 'enable' | 'disable' | 'poll';

const HOOK_RUN_ID = /^(enable|disable|poll)-(.+)-([0-9a-z]+)$/;

export function triggerHookRunId(kind: TriggerHookKind, flowId: string, now = Date.now()): string {
  return `${kind}-${flowId}-${now.toString(36)}`;
}

/** The flow a trigger hook run id was minted for, or null when it is not one. */
export function flowIdOfTriggerHookRunId(runId: string): string | null {
  return HOOK_RUN_ID.exec(runId)?.[2] ?? null;
}
