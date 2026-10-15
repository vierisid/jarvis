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

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

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
    if (b.assigned_to !== null
      && (typeof b.assigned_to !== 'string' || b.assigned_to.trim() === '' || CONTROL_CHARS.test(b.assigned_to))) {
      return { ok: false, error: 'Invalid assigned_to: a name on one line, or null to unassign' };
    }
    patch.assigned_to = b.assigned_to === null ? null : (b.assigned_to as string).trim();
  }
  return { ok: true, patch };
}
