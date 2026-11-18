/**
 * #957: what an email send's audit entry shows beyond its ids, read from the
 * workflow effect the entry belongs to (joined through `effect_id`), never
 * stored in the audit rows. Present while the effect is: once its run is
 * removed, the entry keeps its decision, approver, outcome and provider ids.
 *
 * Values are the effect's frozen, redacted and bounded arguments, reduced as
 * any card value is.
 */
import { forCard } from '../util/card-text';

export interface AuditEmailDetail {
  account?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  /** The message a reply or forward answers, as its card named it. */
  answers?: string;
}

const LIST_MAX = 26;

function list(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const out = items.slice(0, LIST_MAX).map(item => forCard(typeof item === 'string' ? item : JSON.stringify(item) ?? '', 320)).filter(Boolean);
  return out.length ? out : undefined;
}

function text(value: unknown, max = 600): string | undefined {
  return typeof value === 'string' ? forCard(value, max) || undefined : undefined;
}

/** From a workflow effect's stored record (JSON), or null when it is not one this can read. */
export function auditEmailDetail(recordJson: string | null | undefined): AuditEmailDetail | null {
  if (!recordJson) return null;
  let record: { arguments?: unknown; sender?: { account?: unknown; replyTo?: unknown; forwards?: unknown } };
  try { record = JSON.parse(recordJson); } catch { return null; }
  const args = record.arguments && typeof record.arguments === 'object' && !Array.isArray(record.arguments)
    ? record.arguments as Record<string, unknown> : {};
  const detail: AuditEmailDetail = {
    account: text(record.sender?.account, 320),
    to: list(args.to ?? args.receiver),
    cc: list(args.cc),
    bcc: list(args.bcc),
    subject: text(args.subject),
    answers: text(record.sender?.replyTo ?? record.sender?.forwards),
  };
  const kept = Object.fromEntries(Object.entries(detail).filter(([, value]) => value !== undefined)) as AuditEmailDetail;
  return Object.keys(kept).length ? kept : null;
}
