/**
 * What a governed piece action will do, as the Needs you card shows it.
 *
 * Read from the effect's frozen arguments: the step's real input after the
 * piece adapter redacted inline credentials and bounded every value. Nothing
 * here reads a live connection, and the shown values are the ones the approval
 * is bound to. Display only; the approval still runs the frozen record.
 */
import { boundedApprovalLabel, TARGET_KEY_PRIORITY } from './approval-delivery';
import { ALL_PIECE_ADAPTERS, PIECE_AUTH_PROPERTY } from '../workflows/runtime/piece-effects';

export interface GovernedReviewField { label: string; value: string }
export interface GovernedReview { fields: GovernedReviewField[]; /** Fields of the step that are not shown. */ more: number }

const MAX_FIELDS = 12;
const VALUE_MAX_CHARS = 300;
/** A message or request body: an excerpt, not the whole text. */
const BODY_MAX_CHARS = 500;
const BODY_MAX_LINES = 12;
const LIST_MAX_ITEMS = 25;
const LABEL_MAX_CHARS = 40;
const BODY_KEYS = new Set(['body', 'message', 'text', 'content', 'html', 'query']);
/** The step's own count of dropped fields, written by the first bounding pass. */
const OMITTED_FIELDS = /^~*omittedFields$/u;

const REVIEW_PRIORITY: readonly string[] = [...TARGET_KEY_PRIORITY, 'from', 'senderName', 'replyTo', 'reply_to', 'body', 'message',
  'text', 'content', 'attachments', 'query', 'variables'];
const LABELS: Record<string, string> = {
  to: 'To', receiver: 'To', cc: 'Cc', bcc: 'Bcc', subject: 'Subject', from: 'From', senderName: 'Sender name',
  replyTo: 'Reply to', reply_to: 'Reply to', body: 'Body', method: 'Method', url: 'URL', attachments: 'Attachments',
};

function humanize(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[_-]+/gu, ' ').trim().toLowerCase();
  return boundedApprovalLabel(words.charAt(0).toUpperCase() + words.slice(1), LABEL_MAX_CHARS) || 'Field';
}

/** Lines kept as lines, each one reduced like any card label, the whole cut at `max`. */
function excerpt(text: string, max: number, lines: number): string {
  const kept = text.split(/\r\n|\r|\n/u).slice(0, lines).map(line => boundedApprovalLabel(line, max));
  const joined = kept.join('\n').trimEnd();
  const cut = text.split(/\r\n|\r|\n/u).length > lines || joined.length > max;
  return cut ? `${joined.slice(0, max)}...` : joined;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** "invoice.pdf (21 bytes)" from an attachment item as the frozen record holds it. */
function attachmentName(item: unknown): string {
  if (typeof item === 'string') return boundedApprovalLabel(item, 80);
  if (!item || typeof item !== 'object') return 'attachment';
  const record = item as Record<string, unknown>;
  const file = record.file && typeof record.file === 'object' ? record.file as Record<string, unknown> : {};
  const name = [record.name, file.filename, file.name, record.filename].map(scalar).find(v => v?.trim()) ?? 'attachment';
  const data = [file.data, record.data].map(scalar).find(v => v !== undefined);
  const size = data === undefined ? null : /^\[binary, (\d+) bytes\]$/u.exec(data)?.[1];
  return `${boundedApprovalLabel(name, 80)}${size ? ` (${size} bytes)` : ''}`;
}

function render(key: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (key === 'attachments' && Array.isArray(value)) {
    if (!value.length) return undefined;
    const names = value.slice(0, LIST_MAX_ITEMS).map(attachmentName);
    return value.length > LIST_MAX_ITEMS ? `${names.join(', ')}, +${value.length - LIST_MAX_ITEMS} more` : names.join(', ');
  }
  const body = BODY_KEYS.has(key);
  const one = scalar(value);
  if (one !== undefined) return body ? excerpt(one, BODY_MAX_CHARS, BODY_MAX_LINES) : excerpt(one, VALUE_MAX_CHARS, 1);
  if (Array.isArray(value)) {
    if (!value.length) return undefined;
    const items = value.slice(0, LIST_MAX_ITEMS).map(item => scalar(item) ?? JSON.stringify(item) ?? '');
    const shown = items.map(item => boundedApprovalLabel(item, 120)).join(', ');
    return excerpt(value.length > LIST_MAX_ITEMS ? `${shown}, +${value.length - LIST_MAX_ITEMS} more` : shown, VALUE_MAX_CHARS, 1);
  }
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return json === undefined || json === '{}' ? undefined : excerpt(json, BODY_MAX_CHARS, 1);
  }
  return undefined;
}

/**
 * The fields of a governed piece action worth putting in front of the person,
 * primary target first (who or where, then what), then the rest in the
 * adapter's order. Headers and credentials are never listed.
 */
export function governedActionReview(catalogId: string, args: unknown): GovernedReview | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const input = args as Record<string, unknown>;
  const adapterProps = ALL_PIECE_ADAPTERS.find(adapter => adapter.catalogId === catalogId)?.targetProps ?? [];
  const rank = (key: string) => {
    const priority = REVIEW_PRIORITY.indexOf(key);
    if (priority >= 0) return priority;
    const adapter = adapterProps.indexOf(key);
    return REVIEW_PRIORITY.length + (adapter >= 0 ? adapter : adapterProps.length);
  };
  const keys = Object.keys(input).filter(key => key !== PIECE_AUTH_PROPERTY && !/^(headers|customHeaders)$/iu.test(key)).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  const fields: GovernedReviewField[] = [];
  let more = 0;
  for (const key of keys) {
    if (OMITTED_FIELDS.test(key)) { more += typeof input[key] === 'number' ? input[key] as number : 0; continue; }
    const value = render(key, input[key]);
    if (value === undefined) continue;
    if (fields.length >= MAX_FIELDS) { more++; continue; }
    fields.push({ label: LABELS[key] ?? humanize(key), value });
  }
  return fields.length || more ? { fields, more } : null;
}
