/**
 * Q-05: a governed step that sends to, or addresses, an email address memory
 * knows must not act on a fact that is no longer current.
 *
 * Workflows never read facts as data, so nothing records which fact a value
 * came from; what can be checked is the value itself. When the effect is
 * recorded, each recipient address is matched against memory's email facts and
 * the matching fact ids are kept with the record. Before it is approved and
 * again before it dispatches, those facts must still hold: a superseded,
 * expired or deleted fact, or a contested one, blocks the effect with a typed
 * outcome. The arguments stay frozen, so the effect never switches to the
 * address memory holds now; a person updates the workflow or the fact and
 * starts a new run. An address memory does not know is not checked.
 */
import { ActionOutcomeError } from '../../actions/action-outcome';
import { appliesAt, type FactRow } from '../../vault/fact-policy';
import { getWorkflowDb } from '../db';

/** Facts matched to one recipient address when the effect was recorded. */
export interface FactPin { value: string; factIds: string[] }

/** Input props that address people on a governed action. */
const ADDRESS_PROPS = ['receiver', 'to', 'cc', 'bcc', 'attendees', 'attendee_email', 'user_email', 'email'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_PREDICATES = ['email', 'primary_email'];

function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed; } catch { /* plain text */ }
  }
  return value === undefined || value === null || value === '' ? [] : [value];
}

/** The email addresses a governed step's input addresses. */
export function recipientAddresses(input: Record<string, unknown>): string[] {
  const addresses = ADDRESS_PROPS.flatMap(prop => listOf(input[prop]))
    .filter((value): value is string => typeof value === 'string' && EMAIL.test(value.trim()))
    .map(value => value.trim());
  return [...new Set(addresses)];
}

/** Memory's email facts for each address, in any state. Addresses memory does not know are left out. */
export function recipientFactPins(addresses: string[]): FactPin[] {
  const pins: FactPin[] = [];
  for (const value of addresses) {
    let ids: string[] = [];
    try {
      ids = getWorkflowDb().query<{ id: string }, string[]>(
        `SELECT id FROM facts WHERE predicate_key IN (${EMAIL_PREDICATES.map(() => '?').join(', ')}) AND lower(value_key) = lower(?) ORDER BY id`,
      ).all(...EMAIL_PREDICATES, value).map(row => row.id);
    } catch { ids = []; } // a database without vault facts has nothing to match
    if (ids.length) pins.push({ value, factIds: ids });
  }
  return pins;
}

/**
 * Throws a blocked, not-started outcome when an address's facts no longer
 * hold: none of them is current (superseded, expired or deleted), or every
 * current one is contested.
 */
export function assertRecipientFactsCurrent(pins: FactPin[] | undefined, at = Date.now()): void {
  for (const pin of pins ?? []) {
    const rows = getWorkflowDb().query<FactRow, string[]>(
      `SELECT * FROM facts WHERE id IN (${pin.factIds.map(() => '?').join(', ')})`,
    ).all(...pin.factIds);
    const current = rows.filter(row => row.status !== 'superseded' && appliesAt(row, at));
    if (!current.length) {
      const why = rows.length < pin.factIds.length ? 'deleted' : rows.some(row => row.status === 'superseded') ? 'superseded' : 'expired';
      throw new ActionOutcomeError({ status: 'blocked', code: 'WORKFLOW_FACT_STALE', effect: 'not_started',
        message: `Recipient ${pin.value} is no longer current in memory (the fact was ${why}). Nothing was sent. Update the workflow or the fact, then start a new run; the send never switches to another address on its own.` });
    }
    if (current.every(row => row.status === 'contested')) {
      throw new ActionOutcomeError({ status: 'blocked', code: 'WORKFLOW_FACT_AMBIGUOUS', effect: 'not_started',
        message: `Memory holds conflicting values for recipient ${pin.value}. Nothing was sent. Resolve the conflict, then start a new run.` });
    }
  }
}
