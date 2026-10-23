/** Stable identity from retained bytes, never the connector's temporary file URL. */
import { createHash } from 'node:crypto';
import { getWorkflowFile } from '../db/repos/workflow-file';

export function isGmailAttachmentTrigger(settings: { pieceName?: unknown; triggerName?: unknown } | undefined): boolean {
  return settings?.pieceName === '@activepieces/piece-gmail' && settings.triggerName === 'new_attachment';
}

/** Accept only local, stored workflow files owned by this flow. Never fetch a supplied URL. */
export function storedWorkflowFile(reference: unknown, flowId: string, projectId: string) {
  if (typeof reference !== 'string' || !/^\/v1\/step-files\/[A-Za-z0-9_-]+$/.test(reference))
    throw Error('Expected a stored workflow file reference (/v1/step-files/id)');
  const file = getWorkflowFile(reference.slice('/v1/step-files/'.length));
  if (!file || file.projectId !== projectId || file.flowId !== flowId) throw Error('Workflow file is missing or belongs to another workflow');
  if (!file.data.length || file.size !== file.data.length) throw Error('Workflow file is empty or incomplete');
  return file;
}

export function gmailAttachmentKey(payload: Record<string, unknown>, flowId: string, projectId: string): string {
  const message = payload.message as { id?: unknown } | undefined;
  const attachment = payload.attachment as { data?: unknown } | undefined;
  if (typeof message?.id !== 'string' || !message.id.trim() || message.id !== message.id.trim() || message.id.length > 512)
    throw Error('Gmail attachment requires its source message.id');
  const file = storedWorkflowFile(attachment?.data, flowId, projectId);
  // Exact duplicate bytes are one attachment per workflow, including a resent email
  // or a changed filename. Different PDFs with the same invoice number are not conflated.
  return 'attachment:v1:' + createHash('sha256').update(file.data).digest('hex');
}
