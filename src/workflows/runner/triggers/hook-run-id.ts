/**
 * Run ids for trigger hooks (enable, disable, poll). A hook runs in an engine
 * sandbox like a flow run does, but it has no flow_run row, so the sandbox's
 * run id is the only thing that says which flow it serves. The sandbox API
 * reads the flow back out of it to bind a hook's writes (step files) to that
 * flow, which is why the format lives here and both sides use it.
 *
 * The id also names the version the hook runs and a digest of that version's
 * trigger as the hook was handed it. The credential route checks a managed
 * connection against exactly that trigger: not another version of the flow
 * (an editable draft beside the published one), and not a draft trigger that
 * was edited after the hook started.
 */

import { graphDigest } from "../../runtime/continuation";

export type TriggerHookKind = 'enable' | 'disable' | 'poll';

/** kind - flow id (may hold hyphens) - version id - trigger digest - time. */
const HOOK_RUN_ID = /^(enable|disable|poll)-(.+)-([A-Za-z0-9_]+)-([0-9a-f]{32})-([0-9a-z]+)$/;

/** Digest of the trigger node a hook runs: the steps after it are not part of a hook. */
export function hookTriggerDigest(trigger: unknown): string {
  return graphDigest(trigger && typeof trigger === 'object' && !Array.isArray(trigger)
    ? { ...(trigger as Record<string, unknown>), nextAction: undefined } : trigger);
}

export function triggerHookRunId(kind: TriggerHookKind, flowId: string, version: { id: string; trigger: unknown }, now = Date.now()): string {
  return `${kind}-${flowId}-${version.id}-${hookTriggerDigest(version.trigger)}-${now.toString(36)}`;
}

export interface TriggerHookRun {
  flowId: string;
  versionId: string;
  /** `hookTriggerDigest` of the trigger the hook was handed. */
  triggerDigest: string;
}

/** What a trigger hook run id was minted for, or null when it is not one. */
export function parseTriggerHookRunId(runId: string): TriggerHookRun | null {
  const match = HOOK_RUN_ID.exec(runId);
  return match ? { flowId: match[2]!, versionId: match[3]!, triggerDigest: match[4]! } : null;
}

/** The flow a trigger hook run id was minted for, or null when it is not one. */
export function flowIdOfTriggerHookRunId(runId: string): string | null {
  return parseTriggerHookRunId(runId)?.flowId ?? null;
}
