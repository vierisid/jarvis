/**
 * What `PATCH /api/vault/commitments/:id` may change (#1020).
 *
 * It took only a status, so the Tasks room's `{priority}` and `{assigned_to}`
 * were refused with 400 and the voice actions update_priority and reassign,
 * and the priority control on every task card, never worked. It now takes any
 * of the three, and nothing else: a field it does not write is refused rather
 * than ignored, so it never answers 200 for a change it did not make, and the
 * fields a task runs from (what, when_due, context, scope_id, retry_policy)
 * stay out of its reach. A result is text that goes with a status change, as
 * before.
 */
import {
  COMMITMENT_PRIORITIES, COMMITMENT_STATUSES, type CommitmentPatch, type CommitmentPriority, type CommitmentStatus,
} from '../vault/commitments.ts';

const WRITABLE = new Set(['status', 'result', 'priority', 'assigned_to']);

/**
 * Length bounds on what the dashboard may store in a task (#1036).
 *
 * Measured on a real vault (41 tasks, from chat extraction, goal check-ins,
 * the model and the dashboard): the longest `what` was 112 characters, the
 * longest `context` 27 and the longest `assigned_to` 6. The bounds are well
 * clear of that. A task's text has to fit an approval card sentence
 * (`forCard` caps a value at 600); `context` takes the bound the goals routes
 * already put on a goal's description (`goals/validation.ts` `text`).
 */
export const COMMITMENT_WHAT_MAX_CHARS = 500;
export const COMMITMENT_ASSIGNEE_MAX_CHARS = 100;
export const COMMITMENT_CONTEXT_MAX_CHARS = 20_000;

/**
 * The most a create body needs: every text field at its bound with each
 * UTF-16 unit spent as a six-byte `\uXXXX` escape, the most JSON can spend on
 * one, plus room for the keys, a priority and a due time. Without it the
 * route read whatever Bun's server-wide default lets in (128 MiB).
 */
export const COMMITMENT_CREATE_MAX_BODY_BYTES =
  6 * (COMMITMENT_WHAT_MAX_CHARS + COMMITMENT_ASSIGNEE_MAX_CHARS + COMMITMENT_CONTEXT_MAX_CHARS) + 1024;

/**
 * What ends a line for something reading the text, not only `\n`: every C0
 * control (the line breaks with them; a tab is made a space first), DEL, every C1 control (NEL,
 * U+0085, is a line break) and the Unicode line and paragraph separators.
 */
// eslint-disable-next-line no-control-regex
const NOT_ONE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** The same, less the tab and the line breaks a block of text may hold. */
// eslint-disable-next-line no-control-regex
const NOT_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

type Field = { ok: true; value: string | null } | { ok: false };

/**
 * Characters that reorder or hide text, dropped on save (#1036): the bidi
 * embeddings, overrides and isolates, the LRM, RLM and Arabic letter marks,
 * and the tag characters, which spell ASCII nobody sees. They change what
 * the model reads without changing what a person sees.
 *
 * NOT the wider set an approval card drops (`withoutCardInvisibles`): that
 * is fine for a card, which is shown once, but stored text is the user's,
 * and it would change it. The ZWNJ (U+200C) and ZWJ (U+200D) spell Persian,
 * Malayalam and the other scripts that need them, and join emoji sequences;
 * the variation selectors U+FE00-FE0F pick emoji or text presentation and
 * make keycaps (the #859 carve-out keeps U+FE0E and U+FE0F for the same
 * reason); a soft hyphen is a hyphenation point. They are kept.
 */
const REORDERS_OR_HIDES = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/**
 * An emoji tag sequence (UTS #51): the black flag, a subdivision code of
 * lower-case tag letters and tag digits, and CANCEL TAG, as in the England,
 * Scotland and Wales flags. Its tags are kept; any other tag character is
 * dropped, including upper case or spaces between a flag and its CANCEL TAG,
 * which no flag uses and which is how hidden ASCII would hide inside one.
 */
const TAGS = /\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,6}\u{E007F}|[\u{E0000}-\u{E007F}]/gu;

function withoutHiddenText(value: string): string {
  return value.replace(REORDERS_OR_HIDES, '').replace(TAGS, (match) => (match.startsWith('\u{1F3F4}') ? match : ''));
}

/**
 * A text field as it is stored, or not ok. Control characters are refused
 * rather than dropped, as the PATCH always did: a request that asked for a
 * line break is not quietly told it got one. Characters that reorder or hide
 * text are dropped instead (`withoutHiddenText`). `blank` says whether text
 * with nothing left in it is no value (null) or a refusal.
 */
function field(input: unknown, opts: { oneLine: boolean; max: number; blank: 'null' | 'refuse' }): Field {
  if (typeof input !== 'string') return { ok: false };
  let value = input;
  // A lone surrogate is not text: SQLite stores it as a broken code point
  // that swallows the character after it, so what was stored would not be
  // what the 201 showed.
  if (!value.isWellFormed()) return { ok: false };
  // A tab cannot start a line; text pasted from a spreadsheet into a one-line
  // box keeps them, and the POST took them before (#1036 review).
  if (opts.oneLine) value = value.replace(/\t/g, ' ');
  if ((opts.oneLine ? NOT_ONE_LINE : NOT_TEXT).test(value)) return { ok: false };
  const text = withoutHiddenText(value).trim();
  if (text.length > opts.max) return { ok: false };
  if (text === '') return opts.blank === 'null' ? { ok: true, value: null } : { ok: false };
  return { ok: true, value: text };
}

/** The patch `body` asks for, or why it is refused. */
export function validateCommitmentPatch(body: unknown): { ok: true; patch: CommitmentPatch } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Invalid request body' };
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !WRITABLE.has(k));
  if (unknown.length > 0) {
    return { ok: false, error: `Cannot change ${unknown.map((k) => JSON.stringify(k)).join(', ')}: only status (with a result), priority and assigned_to` };
  }
  const has = (k: string) => Object.hasOwn(b, k);
  if (has('result') && !has('status')) return { ok: false, error: 'A result is only set with a status' };
  if (!has('status') && !has('priority') && !has('assigned_to')) {
    return { ok: false, error: 'Nothing to change: send status, priority or assigned_to' };
  }
  const patch: CommitmentPatch = {};
  if (has('status')) {
    if (!(COMMITMENT_STATUSES as readonly unknown[]).includes(b.status)) {
      return { ok: false, error: `Invalid status. Must be one of: ${COMMITMENT_STATUSES.join(', ')}` };
    }
    patch.status = b.status as CommitmentStatus;
  }
  // null is no result, as it always was.
  if (has('result') && b.result !== null) {
    if (typeof b.result !== 'string') return { ok: false, error: 'Invalid result: text, or null' };
    patch.result = b.result;
  }
  if (has('priority')) {
    if (!(COMMITMENT_PRIORITIES as readonly unknown[]).includes(b.priority)) {
      return { ok: false, error: `Invalid priority. Must be one of: ${COMMITMENT_PRIORITIES.join(', ')}` };
    }
    patch.priority = b.priority as CommitmentPriority;
  }
  if (has('assigned_to')) {
    // null unassigns; a name must say something, on one line: the
    // commitments tool lists tasks to the model one per line, so a newline in
    // a name would add a line that is not a task.
    if (b.assigned_to === null) {
      patch.assigned_to = null;
    } else {
      const name = field(b.assigned_to, { oneLine: true, max: COMMITMENT_ASSIGNEE_MAX_CHARS, blank: 'refuse' });
      if (!name.ok) return { ok: false, error: ASSIGNEE_ERROR };
      patch.assigned_to = name.value;
    }
  }
  return { ok: true, patch };
}

const ASSIGNEE_ERROR = `Invalid assigned_to: a name on one line of at most ${COMMITMENT_ASSIGNEE_MAX_CHARS} characters, or null to unassign`;

const CREATABLE = new Set(['what', 'when_due', 'context', 'priority', 'assigned_to']);

/** What `POST /api/vault/commitments` stores, after `validateCommitmentCreate`. */
export interface CommitmentCreate {
  what: string;
  when_due?: number;
  context?: string;
  priority?: CommitmentPriority;
  assigned_to?: string;
}

/**
 * The task `body` asks to create, or why it is refused (#1036).
 *
 * The same rules as the PATCH, which the POST never had: it stored any type
 * and any length, and a line break in `what` or `assigned_to` added a line to
 * the `commitments` tool's one-task-per-line listing that the model read as
 * another task. `context` is the one field that may span lines; only `get`
 * shows it, after a `Context:` label and with every further line indented, so
 * a line of it cannot read as another field. Absent and
 * null are the same everywhere: the defaults, as before. A blank name or
 * context is none (the voice create_task sends an empty name for a slot the
 * model left blank); a blank task is refused.
 */
export function validateCommitmentCreate(body: unknown): { ok: true; create: CommitmentCreate } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Invalid request body' };
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !CREATABLE.has(k));
  if (unknown.length > 0) {
    return { ok: false, error: `Cannot set ${unknown.map((k) => JSON.stringify(k)).join(', ')}: only what, when_due, context, priority and assigned_to` };
  }
  const given = (k: string) => b[k] !== undefined && b[k] !== null;

  const what = field(b.what, { oneLine: true, max: COMMITMENT_WHAT_MAX_CHARS, blank: 'refuse' });
  if (!what.ok) return { ok: false, error: `Invalid what: the task on one line of at most ${COMMITMENT_WHAT_MAX_CHARS} characters` };
  const create: CommitmentCreate = { what: what.value as string };

  if (given('when_due')) {
    // A time in ms since the epoch, inside the range a Date can hold.
    const due = b.when_due;
    if (typeof due !== 'number' || !Number.isSafeInteger(due) || Math.abs(due) > 8_640_000_000_000_000) {
      return { ok: false, error: 'Invalid when_due: a time in milliseconds since the epoch, or null' };
    }
    create.when_due = due;
  }
  if (given('priority')) {
    if (!(COMMITMENT_PRIORITIES as readonly unknown[]).includes(b.priority)) {
      return { ok: false, error: `Invalid priority. Must be one of: ${COMMITMENT_PRIORITIES.join(', ')}` };
    }
    create.priority = b.priority as CommitmentPriority;
  }
  if (given('assigned_to')) {
    const name = field(b.assigned_to, { oneLine: true, max: COMMITMENT_ASSIGNEE_MAX_CHARS, blank: 'null' });
    if (!name.ok) return { ok: false, error: ASSIGNEE_ERROR };
    if (name.value !== null) create.assigned_to = name.value;
  }
  if (given('context')) {
    const context = field(b.context, { oneLine: false, max: COMMITMENT_CONTEXT_MAX_CHARS, blank: 'null' });
    if (!context.ok) return { ok: false, error: `Invalid context: text of at most ${COMMITMENT_CONTEXT_MAX_CHARS} characters, with no control characters but line breaks and tabs` };
    if (context.value !== null) create.context = context.value;
  }
  return { ok: true, create };
}

/**
 * A JSON body of at most `maxBytes`, read no further than that: a declared
 * length past the bound is refused unread, and a streamed body is cancelled
 * at the bound rather than buffered to its end.
 */
export async function readBoundedJson(req: Request, maxBytes: number): Promise<{ ok: true; body: unknown } | { ok: false; error: string; status: number }> {
  const tooLarge = { ok: false as const, error: `Request body too large; the limit is ${maxBytes} bytes`, status: 413 };
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge;
  if (!req.body) return { ok: false, error: 'Invalid request body', status: 400 };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return tooLarge;
      }
      chunks.push(next.value);
    }
  } catch {
    return { ok: false, error: 'Invalid request body', status: 400 };
  } finally {
    reader.releaseLock();
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) };
  } catch {
    return { ok: false, error: 'Invalid request body', status: 400 };
  }
}
