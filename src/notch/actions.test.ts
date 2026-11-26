/**
 * The list of what the notch did (./actions.ts), over the product's real
 * vault and its real audit trail: what an entry holds, that an action is one
 * entry however it ends, what the audit trail gets and how its readers read
 * it, and that nothing here can stand in the way of the action itself.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NOTCH_DECIDER } from '../authority/approval.ts';
import { AuditTrail, type ResolutionChannel } from '../authority/audit.ts';
import { SYSTEM_DECIDER, resolutionChannel } from '../daemon/approval-decision.ts';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import {
  NOTCH_ACTION_CATEGORY, NOTCH_ACTION_DECIDER, NOTCH_ACTION_SYSTEM, NOTCH_ACTION_WHAT_MAX, attachNotchActions, notchAskedHow, notchSentOutcome,
  type NotchActionEntry, type NotchActionKind,
} from './actions.ts';
import { NOTCH_NAME } from './name.ts';
import { notchEnabled } from './switch.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => closeDb());

const tables = (db: Database): string[] => (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);

function made(options: { now?: () => number } = {}) {
  const logged: string[] = [];
  const trail = new AuditTrail();
  let at = 1_000;
  const now = options.now ?? (() => at);
  const actions = attachNotchActions(getDb(), { audit: trail, now, log: (line) => logged.push(line) });
  return { actions, trail, logged, tick: (ms: number) => { at += ms; } };
}

const reply = (extra: Partial<NotchActionEntry> = {}): NotchActionEntry => ({
  kind: 'mail_reply', what: 'Reply to Leo: Deck for Thursday?', target: 'leo@lumen.example', asked: { seen: 'sheet', how: 'key', fuseMs: 5000 }, outcome: 'done', ref: 'mail:p1', ...extra,
});

describe('the switch off', () => {
  test('the vault has no such table, and the switch is off unless it is exactly 1', () => {
    expect(tables(getDb())).not.toContain('notch_actions');
    expect(notchEnabled({})).toBe(false);
    expect(notchEnabled({ JARVIS_NOTCH: 'true' })).toBe(false);
    // The table is made by the list, and the list only by the notch when it is attached (./real.ts).
    expect(new AuditTrail().queryEntries()).toEqual([]);
  });

  test('the table is made when the list is, and only then', () => {
    made();
    expect(tables(getDb())).toContain('notch_actions');
  });
});

describe('an entry', () => {
  test('holds what was done, to whom, what the owner saw, how it was decided, when, and what came of it', () => {
    const h = made();
    const id = h.actions.record(reply());
    expect(id).toMatch(/^na-/);
    expect(h.actions.since(0)).toEqual([{
      id: id!, at: 1000, updatedAt: 1000, kind: 'mail_reply', what: 'Reply to Leo: Deck for Thursday?', target: 'leo@lumen.example',
      seen: 'sheet', fuseMs: 5000, how: 'key', outcome: 'done', ref: 'mail:p1', approvalId: null,
    }]);
    expect(h.logged).toEqual([]);
  });

  test('a sentence is one line of bounded length, whatever it was given', () => {
    const h = made();
    h.actions.record(reply({ what: `Reply to Leo:\n${'x'.repeat(900)}`, ref: undefined }));
    const [row] = h.actions.since(0);
    expect([...row!.what].length).toBeLessThanOrEqual(NOTCH_ACTION_WHAT_MAX);
    expect(row!.what).not.toContain('\n');
  });

  test('with no fuse there is none written, and with no ref every record is an entry of its own', () => {
    const h = made();
    h.actions.record({ kind: 'people_tell', what: 'Message to Leo', target: 'Leo', asked: { seen: 'nothing', how: 'said' }, outcome: 'done' });
    h.actions.record({ kind: 'people_tell', what: 'Message to Leo', target: 'Leo', asked: { seen: 'nothing', how: 'said' }, outcome: 'done' });
    expect(h.actions.since(0)).toHaveLength(2);
    expect(h.actions.since(0)[0]).toMatchObject({ fuseMs: null, ref: null, seen: 'nothing', how: 'said' });
  });
});

describe('one action is one entry', () => {
  test('tried again after it did not go: the entry it had is changed, with the yes that led to what came of it', () => {
    const h = made();
    const first = h.actions.record(reply({ outcome: 'not_done' }));
    h.tick(60_000);
    const second = h.actions.record(reply({ outcome: 'done', asked: { seen: 'sheet', how: 'said', fuseMs: 5000 } }));
    expect(second).toBe(first);
    expect(h.actions.since(0)).toHaveLength(1);
    // When it was first known stays; when it was last changed moves.
    expect(h.actions.since(0)[0]).toMatchObject({ outcome: 'done', how: 'said', at: 1000, updatedAt: 61_000 });
  });

  test('may have gone, then found: the same entry says done, and keeps what the owner saw and how they decided', () => {
    const h = made();
    h.actions.record(reply({ outcome: 'unsure' }));
    expect(h.actions.settle('mail:p1', 'done')).toBe(true);
    expect(h.actions.since(0)).toHaveLength(1);
    expect(h.actions.since(0)[0]).toMatchObject({ outcome: 'done', seen: 'sheet', how: 'key', fuseMs: 5000 });
  });

  test('found with nothing written down for it: nothing is written, unless whoever found it says what it was', () => {
    const h = made();
    expect(h.actions.settle('mail:none', 'done')).toBe(false);
    expect(h.actions.since(0)).toEqual([]);
    expect(h.actions.settle('chase:c1:1', 'done', { otherwise: { kind: 'chase_followup', what: 'Follow-up to Sam', asked: { seen: 'sheet', how: 'system' }, outcome: 'unsure' } })).toBe(true);
    expect(h.actions.since(0)).toMatchObject([{ kind: 'chase_followup', outcome: 'done', ref: 'chase:c1:1', how: 'system' }]);
  });

  test('taken back: the entry says so, and nothing is added', () => {
    const h = made();
    h.actions.record({ kind: 'put', what: 'Put 3 rows from Notepad into Excel', asked: { seen: 'line', how: 'key' }, outcome: 'done', ref: 'job:j1' });
    expect(h.actions.undone('job:j1')).toBe(true);
    expect(h.actions.undone('job:j1')).toBe(true);
    expect(h.actions.since(0)).toMatchObject([{ outcome: 'undone', ref: 'job:j1', how: 'key' }]);
    expect(h.actions.undone('job:never')).toBe(false);
  });

  test('a sentence that changes with what came of it: a file that was offered is sent once they have it', () => {
    const h = made();
    h.actions.record({ kind: 'people_file', what: 'File offered to Leo: deck.pdf', target: 'Leo', asked: { seen: 'line', how: 'said', fuseMs: 4000 }, outcome: 'done', ref: 'file:f1' });
    expect(h.actions.settle('file:f1', 'done', { what: 'File sent to Leo: deck.pdf' })).toBe(true);
    expect(h.actions.since(0)).toMatchObject([{ what: 'File sent to Leo: deck.pdf', outcome: 'done', how: 'said' }]);
    // The same outcome: the audit trail is told nothing a second time.
    expect(h.trail.query({})).toHaveLength(1);
  });
});

describe('after a restart', () => {
  test('what was written down is still there, a mail that may have gone can still be found, and nothing is cleared with age', () => {
    const old = made({ now: () => Date.UTC(2025, 0, 1) });
    old.actions.record(reply({ outcome: 'unsure' }));
    // A new brain over the same vault, a long time later: more than any 90 days.
    const next = made({ now: () => Date.UTC(2026, 10, 26) });
    expect(next.actions.since(0)).toMatchObject([{ outcome: 'unsure', ref: 'mail:p1' }]);
    expect(next.actions.settle('mail:p1', 'done')).toBe(true);
    expect(next.actions.since(0)).toMatchObject([{ outcome: 'done', at: Date.UTC(2025, 0, 1), updatedAt: Date.UTC(2026, 10, 26) }]);
    expect(next.actions.since(0)).toHaveLength(1);
  });
});

describe('the audit trail gets every entry, as one ledger entry', () => {
  test('a reply the owner said yes to: allowed, on the notch, by the notch, succeeded, under the mail category', () => {
    const h = made();
    const id = h.actions.record(reply())!;
    const rows = h.trail.query({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_id: 'notch', agent_name: NOTCH_NAME, tool_name: 'notch_mail_reply', action_category: 'send_email', authority_decision: 'allowed',
      approval_id: null, executed: 1, channel: 'notch', decided_by: 'notch', effect_id: id, entry_key: id, outcome: 'succeeded',
    });
  });

  test('the readers the dashboard uses take it: the ledger, the rows, the filters and the statistics', () => {
    const h = made();
    h.actions.record(reply());
    h.actions.record({ kind: 'people_tell', what: 'Message to Leo', target: 'Leo', asked: { seen: 'line', how: 'said', fuseMs: 3000 }, outcome: 'not_done' });
    h.actions.record({ kind: 'job_rounds', what: 'Pasted 0 in Excel', asked: { seen: 'line', how: 'key' }, outcome: 'not_done' });
    // GET /api/authority/audit reads `queryEntries`, with `rows=all` it reads `query`; /stats reads `getStats`.
    const entries = h.trail.queryEntries();
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      // What the Authority room, the Logs room and the Now widget read of a row.
      expect(typeof entry.agent_name).toBe('string');
      expect(typeof entry.tool_name).toBe('string');
      expect(typeof entry.action_category).toBe('string');
      expect(typeof entry.created_at).toBe('number');
      expect(entry.authority_decision).toBe('allowed');
      expect(entry.events).toBe(1);
    }
    // A mail entry is asked for the detail of a workflow effect, and there is none: null, not a throw.
    expect(h.trail.queryEntries({ action: 'send_email' })).toMatchObject([{ tool_name: 'notch_mail_reply', outcome: 'succeeded', executed: 1, email: null }]);
    expect(h.trail.queryEntries({ tool: 'notch_people_tell' })).toMatchObject([{ outcome: 'not_started', executed: 0 }]);
    // Something done in a window that did not work ran and failed.
    expect(h.trail.queryEntries({ action: 'control_app' })).toMatchObject([{ outcome: 'failed', executed: 0 }]);
    expect(h.trail.queryEntries({ agentId: 'notch', decision: 'allowed' })).toHaveLength(3);
    expect(h.trail.queryEntries({ decision: 'denied' })).toEqual([]);
    expect(h.trail.getStats()).toMatchObject({
      total: 3, allowed: 3, denied: 0, approvalRequired: 0,
      byCategory: { send_email: 1, send_message: 1, control_app: 1 }, byOutcome: { succeeded: 1, not_started: 1, failed: 1 },
    });
  });

  test('the channel and the decider are ones the audit already knows', () => {
    const channels: ResolutionChannel[] = ['click', 'voice', 'chat', 'notification', 'notch', 'system'];
    expect(NOTCH_ACTION_DECIDER).toBe(NOTCH_DECIDER);
    expect(NOTCH_ACTION_SYSTEM).toBe(SYSTEM_DECIDER);
    expect(resolutionChannel(NOTCH_ACTION_DECIDER)).toBe('notch');
    expect(resolutionChannel(NOTCH_ACTION_SYSTEM)).toBe('system');
    const h = made();
    for (const how of ['key', 'said', 'pick', 'fuse', 'system'] as const) h.actions.record({ kind: 'question', what: `Answered by ${how}`, asked: { seen: 'line', how }, outcome: 'done' });
    for (const row of h.trail.query({})) expect(channels).toContain(row.channel!);
  });

  test('nobody decided it just then (a follow-up by the clock, a fuse with no yes): the channel is the system, not the notch', () => {
    const h = made();
    h.actions.record({ kind: 'chase_followup', what: 'Follow-up to Sam', asked: { seen: 'sheet', how: 'system' }, outcome: 'done' });
    h.actions.record({ kind: 'promise', what: 'Promised: water the plants', asked: { seen: 'line', how: 'fuse', fuseMs: 30_000 }, outcome: 'done' });
    expect(h.trail.query({}).map((row) => [row.tool_name, row.channel, row.decided_by])).toEqual(expect.arrayContaining([
      ['notch_chase_followup', 'system', 'system'], ['notch_promise', 'system', 'system'],
    ]));
  });

  test('may have gone, then found: one ledger entry, whose outcome is the last word', () => {
    const h = made();
    const id = h.actions.record(reply({ outcome: 'unsure' }))!;
    expect(h.trail.queryEntries()).toMatchObject([{ outcome: 'unknown', executed: 0, events: 1 }]);
    h.tick(5);
    h.actions.settle('mail:p1', 'done');
    const entries = h.trail.queryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entry_key: id, outcome: 'succeeded', executed: 1, events: 2, tool_name: 'notch_mail_reply' });
    expect(h.trail.getStats()).toMatchObject({ total: 1, byOutcome: { succeeded: 1 } });
  });

  test('taken back: the same ledger entry gets a row that says so, and still says the thing was done', () => {
    const h = made();
    h.actions.record({ kind: 'put', what: 'Put 3 rows from Notepad into Excel', asked: { seen: 'line', how: 'key' }, outcome: 'done', ref: 'job:j1' });
    h.tick(5);
    h.actions.undone('job:j1');
    expect(h.trail.queryEntries()).toMatchObject([{ tool_name: 'notch_put', outcome: 'succeeded', events: 2 }]);
    expect(h.trail.query({ tool: 'notch_put_undo' })).toMatchObject([{ executed: 1, channel: 'notch', outcome: null }]);
  });

  test('a yes to an approval is written here and not to the audit: the product has already written that one', () => {
    const h = made();
    h.actions.record({ kind: 'approval', what: 'Look up where Steam is installed', target: 'run_command', asked: { seen: 'line', how: 'key', fuseMs: 3000 }, outcome: 'handed', ref: 'approval:a1', approvalId: 'a1' });
    expect(h.actions.since(0)).toMatchObject([{ kind: 'approval', outcome: 'handed', approvalId: 'a1' }]);
    expect(h.trail.query({})).toEqual([]);
  });

  test('every kind has a category the product knows', () => {
    const known = ['read_data', 'write_data', 'delete_data', 'send_message', 'send_email', 'execute_command', 'install_software', 'make_payment', 'modify_settings', 'spawn_agent', 'terminate_agent', 'access_browser', 'control_app'];
    for (const category of Object.values(NOTCH_ACTION_CATEGORY)) expect(known).toContain(category);
    // Nothing the notch does by itself is a payment.
    expect(Object.values(NOTCH_ACTION_CATEGORY)).not.toContain('make_payment');
  });
});

describe('writing it down never stands in the way of the action', () => {
  test('a list that cannot be written to: null, a line in the log, and no throw', () => {
    const h = made();
    getDb().run('DROP TABLE notch_actions');
    expect(h.actions.record(reply())).toBeNull();
    expect(h.actions.settle('mail:p1', 'done')).toBe(false);
    expect(h.actions.undone('mail:p1')).toBe(false);
    expect(h.actions.today(0)).toEqual([]);
    expect(h.actions.byRef('mail:p1')).toBeNull();
    expect(h.logged.length).toBeGreaterThanOrEqual(3);
    for (const line of h.logged) expect(line).toStartWith('[notch] ');
    // What is said of the failure quotes nothing of what was being written.
    expect(h.logged.join('\n')).not.toContain('Leo');
  });

  test('an audit trail that throws: the entry stands, the failure is said, and nothing is thrown', () => {
    const logged: string[] = [];
    const actions = attachNotchActions(getDb(), { audit: { log: () => { throw new Error('the audit is locked'); } }, log: (line) => logged.push(line) });
    expect(actions.record(reply())).not.toBeNull();
    expect(actions.since(0)).toHaveLength(1);
    expect(logged).toEqual(['[notch] an action was written down, but not in the audit trail: Error']);
  });

  test('a log that throws does not make it throw either', () => {
    const actions = attachNotchActions(getDb(), { log: () => { throw new Error('no console'); } });
    getDb().run('DROP TABLE notch_actions');
    expect(actions.record(reply())).toBeNull();
  });

  test('with no audit trail given, entries are kept here only', () => {
    const actions = attachNotchActions(getDb(), {});
    expect(actions.record(reply())).not.toBeNull();
    expect(new AuditTrail().query({})).toEqual([]);
  });
});

describe('the rows Today gets from the list', () => {
  const kinds = (rows: { text: string }[]): string[] => rows.map((row) => row.text);

  test('what has a row from somewhere else gets no second one: a reply that went, a job, a chase, an agent that was made, a kept promise, an approval', () => {
    const h = made();
    const elsewhere: [NotchActionKind, string][] = [['mail_reply', 'r'], ['mail_slot', 's'], ['chase_mail', 'c'], ['agent_made', 'a'], ['job_rounds', 'j'], ['job_skill', 'k'], ['put', 'p'], ['promise', 'm']];
    for (const [kind, what] of elsewhere) h.actions.record({ kind, what, asked: { seen: 'line', how: 'key' }, outcome: 'done' });
    h.actions.record({ kind: 'approval', what: 'v', asked: { seen: 'line', how: 'key' }, outcome: 'handed' });
    h.actions.record({ kind: 'approval', what: 'w', asked: { seen: 'line', how: 'key' }, outcome: 'done' });
    expect(h.actions.today(0)).toEqual([]);
    expect(h.actions.since(0)).toHaveLength(10);
  });

  test('what only the list has is a row: a follow-up, a call follow-up, a word to somebody, an answer to a workflow, an agent that was changed', () => {
    const h = made();
    const only: NotchActionKind[] = ['chase_followup', 'call_followup', 'people_tell', 'people_file', 'question', 'agent_rung', 'agent_gone'];
    for (const kind of only) { h.tick(1); h.actions.record({ kind, what: kind, asked: { seen: 'line', how: 'key' }, outcome: 'done' }); }
    const rows = h.actions.today(0);
    // Newest first, each with its small word, and none with Undo: these cannot be taken back.
    expect(kinds(rows)).toEqual([...only].reverse());
    expect(rows.map((row) => row.small)).toEqual(['done', 'done', 'done', 'sent', 'sent', 'sent', 'sent']);
    expect(rows.every((row) => row.undo === false && row.id.startsWith('action:'))).toBe(true);
  });

  test('what may have gone is a row whatever it is, and what was not done is none', () => {
    const h = made();
    h.actions.record(reply({ outcome: 'unsure' }));
    h.actions.record({ kind: 'chase_mail', what: 'First mail to Sam', asked: { seen: 'sheet', how: 'key', fuseMs: 5000 }, outcome: 'unsure' });
    h.actions.record({ kind: 'promise', what: 'Promised: call the bank', asked: { seen: 'nothing', how: 'system' }, outcome: 'unsure' });
    h.actions.record({ kind: 'people_tell', what: 'Message to Leo', asked: { seen: 'line', how: 'said' }, outcome: 'not_done' });
    expect(h.actions.today(0).map((row) => [row.text, row.small]).sort()).toEqual([
      ['First mail to Sam', 'may have gone'], ['Promised: call the bank', 'may have happened'], ['Reply to Leo: Deck for Thursday?', 'may have gone'],
    ]);
  });

  test('only from the moment that is asked for', () => {
    const h = made();
    h.actions.record({ kind: 'people_tell', what: 'early', asked: { seen: 'line', how: 'said' }, outcome: 'done' });
    h.tick(10_000);
    h.actions.record({ kind: 'people_tell', what: 'late', asked: { seen: 'line', how: 'said' }, outcome: 'done' });
    expect(kinds(h.actions.today(5_000))).toEqual(['late']);
    expect(h.actions.since(0, 5_000)).toMatchObject([{ what: 'early' }]);
  });
});

describe('small things', () => {
  test('what came of something sent to somebody: it went, it did not, or the line broke and it may have', () => {
    expect(notchSentOutcome({ ok: true })).toBe('done');
    expect(notchSentOutcome({ ok: false, why: 'unknown' })).toBe('unsure');
    for (const why of ['down', 'signed_out', 'offline', 'withheld', 'refused']) expect(notchSentOutcome({ ok: false, why })).toBe('not_done');
  });

  test('a yes given in words is written down as said, whatever the page would have called it', () => {
    expect(notchAskedHow({ answeredHow: () => 'key' })).toBe('key');
    expect(notchAskedHow({ answeredHow: () => 'key' }, 'pick')).toBe('pick');
    expect(notchAskedHow({ answeredHow: () => 'said' }, 'pick')).toBe('said');
  });
});
