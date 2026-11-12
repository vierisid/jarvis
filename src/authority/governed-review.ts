/**
 * What a governed piece action will do, as the Needs you card shows it.
 *
 * Read from the effect's frozen arguments: the step's real input after the
 * piece adapter redacted inline credentials and bounded every value. The
 * caller (`brief/decisions.ts`) shows it only while those arguments are the
 * ones the approval is bound to (the same digest the effect boundary checks
 * before it runs anything). Nothing here reads a live connection. Display
 * only; the approval still runs the frozen record.
 *
 * Redaction is the record's, applied again here with the same shared rules
 * (`redactHttpInput` and each adapter's `redactInput`, which are idempotent),
 * so a rule added after an effect was frozen (#1390's URL path tokens) also
 * covers what an older record shows. Headers and `auth` are never listed.
 *
 * Every value is untrusted text from the run: reduced as any card value is
 * (`forCard`: format, bidi and control characters removed, whitespace
 * collapsed), one line each, so it cannot reorder or break out of its field.
 * A message or request body keeps its line breaks and is flagged `text`, so
 * the card can frame it apart from the card's own words.
 */
import { boundedApprovalLabel, TARGET_KEY_PRIORITY } from './approval-delivery';
import { ALL_PIECE_ADAPTERS, PIECE_AUTH_PROPERTY, redactHttpInput } from '../workflows/runtime/piece-effects';
import { forCard } from '../util/card-text';

export interface GovernedReviewField {
  label: string;
  value: string;
  /** A message or request body: several lines, framed on the card as quoted text. */
  text?: true;
  /** The value is an excerpt: the card shows less than the step will send. */
  cut?: true;
}
export interface GovernedReview { fields: GovernedReviewField[]; /** Fields of the step that are not shown. */ more: number }

const MAX_FIELDS = 12;
/**
 * One value. Above the effect record's own string bound (512 characters plus
 * its "... [N more characters]" note), so a recipient, subject or URL the
 * record holds is shown whole, note included, never cut again here.
 */
const VALUE_MAX_CHARS = 600;
/** A message or request body: an excerpt, not the whole text. */
const BODY_MAX_CHARS = 500;
const BODY_MAX_LINES = 12;
/** One item of a list (a recipient, an attachment): an address with a display name fits. */
const LIST_ITEM_MAX_CHARS = 320;
/** The record keeps at most 25 items and a "[N more items]" note; every one is shown. */
const LIST_MAX_ITEMS = 26;
const LABEL_MAX_CHARS = 40;
const BODY_KEYS = new Set(['body', 'message', 'text', 'content', 'html', 'query']);
/**
 * The record's count of dropped fields. Only the bare spelling is the marker:
 * a real field spelled like it was escaped to `~omittedFields` (#722) and is
 * shown as a field.
 */
const OMITTED_FIELDS = 'omittedFields';
const URL_KEY = /url$/iu;
/** The note the effect record's bound appends to a string it cut. */
const RECORD_CUT_NOTE = /\.\.\. \[\d+ more characters\]$/u;

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

/** Lines kept as lines, each reduced like any card value, the whole cut at `BODY_MAX_CHARS`. */
function excerpt(text: string): { value: string; cut: boolean } {
  const all = text.split(/\r\n|\r|\n|\u2028|\u2029/u).map(line => forCard(line, Number.POSITIVE_INFINITY));
  // Runs of blank lines read as one; leading and trailing blank lines say nothing.
  const lines = all.filter((line, i) => line !== '' || (i > 0 && all[i - 1] !== '')).join('\n').trim().split('\n');
  const kept = lines.slice(0, BODY_MAX_LINES).join('\n');
  if (lines.length <= BODY_MAX_LINES && kept.length <= BODY_MAX_CHARS) return { value: kept, cut: false };
  return { value: `${kept.slice(0, BODY_MAX_CHARS).trimEnd()}...`, cut: true };
}

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** "invoice.pdf (21 bytes)" from an attachment item as the frozen record holds it. */
function attachmentName(item: unknown): string {
  if (typeof item === 'string') return forCard(item, LIST_ITEM_MAX_CHARS);
  if (!item || typeof item !== 'object') return 'attachment';
  const record = item as Record<string, unknown>;
  const file = record.file && typeof record.file === 'object' ? record.file as Record<string, unknown> : {};
  const name = [record.name, file.filename, file.name, record.filename].map(scalar).find(v => v?.trim()) ?? 'attachment';
  const data = [file.data, record.data].map(scalar).find(v => v !== undefined);
  const size = data === undefined ? null : /^\[binary, (\d+) bytes\]$/u.exec(data)?.[1];
  return `${forCard(name, LIST_ITEM_MAX_CHARS) || 'attachment'}${size ? ` (${size} bytes)` : ''}`;
}

/** A URL as the shared HTTP rules redact it (#1318, #1390), whichever piece holds it. */
function redactedUrl(url: string): string {
  const out = redactHttpInput({ url }).url;
  return typeof out === 'string' ? out : url;
}

function render(key: string, value: unknown): Omit<GovernedReviewField, 'label'> | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) {
    if (!value.length) return undefined;
    const items = value.slice(0, LIST_MAX_ITEMS).map(item => key === 'attachments' ? attachmentName(item)
      : forCard(scalar(item) ?? JSON.stringify(item) ?? '', LIST_ITEM_MAX_CHARS));
    const rest = value.length - LIST_MAX_ITEMS;
    return { value: rest > 0 ? `${items.join(', ')}, and ${rest} more` : items.join(', ') };
  }
  const one = scalar(value) ?? (typeof value === 'object' ? JSON.stringify(value) : undefined);
  if (one === undefined || one === '{}') return undefined;
  if (BODY_KEYS.has(key)) {
    const { value: shown, cut } = excerpt(one);
    return shown ? { value: shown, text: true, ...(cut || RECORD_CUT_NOTE.test(one) ? { cut: true as const } : {}) } : undefined;
  }
  const full = forCard(URL_KEY.test(key) && typeof value === 'string' ? redactedUrl(one) : one, Number.POSITIVE_INFINITY);
  if (!full) return undefined;
  const cut = full.length > VALUE_MAX_CHARS || RECORD_CUT_NOTE.test(full);
  return { value: forCard(full, VALUE_MAX_CHARS), ...(cut ? { cut: true as const } : {}) };
}

/**
 * The fields of a governed piece action worth putting in front of the person,
 * primary target first (who or where, then what), then the rest in the
 * adapter's order. Headers and credentials are never listed.
 */
export function governedActionReview(catalogId: string, args: unknown): GovernedReview | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const adapter = ALL_PIECE_ADAPTERS.find(candidate => candidate.catalogId === catalogId);
  // The adapter's own credential redaction, again: idempotent by contract.
  const input = adapter?.redactInput ? adapter.redactInput(args as Record<string, unknown>, true) : args as Record<string, unknown>;
  const adapterProps = adapter?.targetProps ?? [];
  const rank = (key: string) => {
    const priority = REVIEW_PRIORITY.indexOf(key);
    if (priority >= 0) return priority;
    const index = adapterProps.indexOf(key);
    return REVIEW_PRIORITY.length + (index >= 0 ? index : adapterProps.length);
  };
  const keys = Object.keys(input).filter(key => key !== PIECE_AUTH_PROPERTY && !/^(headers|customHeaders)$/iu.test(key))
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  const fields: GovernedReviewField[] = [];
  let more = 0;
  for (const key of keys) {
    if (key === OMITTED_FIELDS) {
      const count = input[key];
      if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0) more += count;
      continue;
    }
    const shown = render(key, input[key]);
    if (shown === undefined) continue;
    if (fields.length >= MAX_FIELDS) { more++; continue; }
    fields.push({ label: LABELS[key] ?? humanize(key), ...shown });
  }
  return fields.length || more ? { fields, more } : null;
}
