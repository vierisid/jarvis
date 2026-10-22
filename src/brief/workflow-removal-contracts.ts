/** D21's presentation seam, with additive F20 recovery and execution state. */
export interface ManagedWorkflow {
  flowId: string; versionId: string | null; revision: string; name: string; description: string; trigger: string;
  activation: 'ENABLED' | 'DISABLED'; publication: 'published' | 'unpublished';
  readiness: { state: 'ready' | 'blocked' | 'unknown'; reason: string | null };
  latestRun: { runId: string; label: string } | null;
}
export interface RemovalReceipt {
  scopeId: string; flowId: string; versionId: string | null; receiptId: string; expiresAt: number;
}
export interface WorkflowManageCommand {
  scopeId: string; flowId: string; versionId: string | null; expectedRevision: string; requestId: string;
  action: 'activation' | 'remove' | 'restore'; activation?: 'ENABLED' | 'DISABLED'; receiptId?: string;
}
export type WorkflowManageResult = Pick<WorkflowManageCommand, 'scopeId' | 'flowId' | 'requestId' | 'action'> & (
  { status: 'accepted'; item?: ManagedWorkflow; receipt?: RemovalReceipt }
  | { status: 'rejected'; message: string; code: string }
);
/** #1096: a person's purge of a restored workflow, or of a removed one whose Undo expired. */
export interface WorkflowPurgeCommand {
  scopeId: string; flowId: string; versionId: string | null; expectedRevision: string; requestId: string;
}
export interface PurgeReceipt { purgeId: string; flowId: string; generation: number; acceptedAt: number }
export type WorkflowPurgeResult = Pick<WorkflowPurgeCommand, 'scopeId' | 'flowId' | 'requestId'> & { action: 'purge' } & (
  { status: 'accepted'; purge: PurgeReceipt }
  | { status: 'rejected'; message: string; code: string }
);
