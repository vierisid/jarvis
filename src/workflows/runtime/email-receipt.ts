/**
 * #957: the provider's ids for a sent email, for the audit trail. Only ids:
 * recipients and subject stay on the effect record, which the audit view joins
 * through `effect_id` while it exists, and never go into the long-lived audit
 * rows.
 *
 * Gmail's receipt is the Gaxios envelope Q-07 keeps (`data.id`,
 * `data.threadId`); the SMTP piece returns nodemailer's result (`messageId`,
 * the Message-ID header). Anything else, or a value that is not a short plain
 * string, gives nothing.
 */
import { describesEmailSender } from './email-sender';

const ID_MAX = 256;

function id(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= ID_MAX && !/[\u0000-\u001f\u007f]/u.test(text) ? text : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function emailReceiptIds(piece: string, action: string, result: unknown): { messageId?: string; threadId?: string } {
  if (!describesEmailSender(piece, action)) return {};
  const body = record(result);
  const data = record(body?.data);
  const messageId = id(data?.id) ?? id(body?.messageId);
  const threadId = id(data?.threadId);
  return { ...(messageId ? { messageId } : {}), ...(threadId ? { threadId } : {}) };
}
