/**
 * What the notch did in the world, as one list (fix 05, the owner's decision
 * of 26 November 2026: one log that also writes the audit, no approval rows).
 *
 * A mail that went from the notch, a word to somebody's Jarvis, a job done in
 * a window, an agent switched on: none of these is an approval, so none left
 * a row anywhere that says "this went out in your name". Each of them writes
 * one entry here, at the point where what came of it is known:
 *
 *   what      one sentence, as Today says it. Who it went to or what it was
 *             done to is `target`
 *   asked     what the owner had before them when they decided (a line, a
 *             sheet, the letter on paper, nothing), how long the fuse burnt,
 *             and how it was decided: the yes key, words, a pick, a fuse that
 *             burnt out with no yes asked, or by the system (a follow-up that
 *             an earlier yes covers, a clock)
 *   outcome   done, not done, may have been done, taken back. And `handed`:
 *             a yes that was passed on to the product, which writes the
 *             result itself (an approval)
 *
 * One action is one entry. An action that is tried again, a mail that may
 * have gone and is then found, a paste that is taken back: these change the
 * entry they belong to (`ref`), and add no second one that says otherwise.
 *
 * Each entry is also written to the product's audit trail, through its own
 * `log`, as one ledger entry (`effect_id` is the entry's id, so a later
 * change is read as the same entry with its last outcome). The channel is
 * `notch` when the owner decided there, `system` when nobody did just then.
 * An approval is not written to the audit from here: the product's own
 * decision function has already written it.
 *
 * What is not kept: the words of a mail or of a message, in any form, and
 * nothing a model was asked. The audit trail keeps none for a send that was
 * approved on the dashboard either. The sentence names who and about what, as
 * the rows of Today already did.
 *
 * Kept for as long as the audit trail is: nothing is cleared.
 *
 * The table exists only on a brain that has had the notch on: it is made when
 * the notch is attached, not with the rest of the vault. Writing an entry
 * never stands in the way of the action it is about: whatever fails here is
 * said in the log and nowhere else.
 */
import type { Database } from 'bun:sqlite';
import type { AuditOutcome, AuditTrail } from '../authority/audit.ts';
import type { ActionCategory } from '../roles/authority.ts';
import { NOTCH_NAME } from './name.ts';

/** What kind of thing was done. Each is one tool name in the audit: `notch_<kind>`. */
export type NotchActionKind =
  | 'mail_reply' | 'mail_slot' | 'chase_mail' | 'chase_followup' | 'call_followup'
  | 'people_tell' | 'people_ask' | 'people_answer' | 'people_request' | 'people_share' | 'people_agent' | 'people_file' | 'people_file_ask'
  | 'people_job' | 'people_time' | 'people_request_answer' | 'people_agent_yes'
  | 'agent_made' | 'agent_rung' | 'agent_paused' | 'agent_run' | 'agent_gone'
  | 'job_rounds' | 'job_skill' | 'put'
  | 'promise' | 'question' | 'approval';

/** What the owner had before them when it was decided. */
export type NotchActionSeen = 'line' | 'sheet' | 'letter' | 'nothing';
/** How it was decided. */
export type NotchActionHow = 'key' | 'said' | 'pick' | 'fuse' | 'system';
/** `partly`: some of it was done, and then it failed (a job). */
export type NotchActionOutcome = 'done' | 'partly' | 'not_done' | 'unsure' | 'undone' | 'handed';

export interface NotchActionAsked {
  seen: NotchActionSeen;
  how: NotchActionHow;
  /** How long the fuse burnt before it went. Not given: there was none. */
  fuseMs?: number;
}

export interface NotchActionEntry {
  kind: NotchActionKind;
  /** One sentence, as a row of Today says it. Never the words of a mail or a message. */
  what: string;
  /** Who it went to, or what it was done to. */
  target?: string | null;
  asked: NotchActionAsked;
  outcome: NotchActionOutcome;
  /**
   * What names this action among the feature's own things ("mail:<id>",
   * "job:<id>"). An entry with the same `ref` is the same action: it is
   * changed, and no second one is added.
   */
  ref?: string;
  /** The approval this was a yes to, when it was one. */
  approvalId?: string;
}

export interface NotchActionRow {
  id: string;
  /** When what came of it was first known. */
  at: number;
  /** When the entry was last changed. */
  updatedAt: number;
  kind: NotchActionKind;
  what: string;
  target: string | null;
  seen: NotchActionSeen;
  fuseMs: number | null;
  how: NotchActionHow;
  outcome: NotchActionOutcome;
  ref: string | null;
  approvalId: string | null;
}

export interface NotchActions {
  /**
   * Writes down what came of an action: a new entry, or the one with the same
   * `ref` changed. The entry's id, or null when it could not be written (said
   * in the log). Never throws.
   */
  record(entry: NotchActionEntry): string | null;
  /**
   * What came of an action that is already written down turned out to be
   * something else: a mail that may have gone was found, a file that was
   * offered was taken. The entry keeps what the owner saw and how they
   * decided, and its sentence unless `what` gives another. With no such
   * entry, `otherwise` is written as a new one when given. Whether anything
   * was written. Never throws.
   */
  settle(ref: string, outcome: NotchActionOutcome, more?: { what?: string; otherwise?: NotchActionEntry }): boolean;
  /** The action was taken back. False when nothing is written down for it. Never throws. */
  undone(ref: string): boolean;
  /** Everything written down from a moment on, newest first. */
  since(since: number, until?: number): NotchActionRow[];
  /** The entry with that `ref`, or null. */
  byRef(ref: string): NotchActionRow | null;
  /**
   * The rows of Today that only this list has: what was done and has no row
   * from anywhere else, and what may have been done. Something that was not
   * done is not a row of what was done.
   */
  today(since: number): { id: string; at: number; text: string; small: string; undo: boolean }[];
}

export interface NotchActionsDeps {
  /** The product's audit trail. Without one, entries are kept here only. */
  audit?: Pick<AuditTrail, 'log'> | null;
  now?: () => number;
  log?: (line: string) => void;
}

/** The longest sentence an entry keeps. */
export const NOTCH_ACTION_WHAT_MAX = 220;

/** The audit's own category of each kind. */
export const NOTCH_ACTION_CATEGORY: Record<Exclude<NotchActionKind, 'approval'>, ActionCategory> = {
  mail_reply: 'send_email', mail_slot: 'send_email', chase_mail: 'send_email', chase_followup: 'send_email', call_followup: 'send_email',
  people_tell: 'send_message', people_ask: 'send_message', people_answer: 'send_message', people_request: 'send_message', people_share: 'send_message',
  people_agent: 'send_message', people_file: 'send_message', people_file_ask: 'send_message', people_job: 'send_message', people_time: 'send_message',
  people_request_answer: 'send_message', people_agent_yes: 'send_message',
  agent_made: 'spawn_agent', agent_rung: 'modify_settings', agent_paused: 'modify_settings', agent_run: 'spawn_agent', agent_gone: 'terminate_agent',
  job_rounds: 'control_app', job_skill: 'control_app', put: 'control_app',
  promise: 'write_data', question: 'write_data',
};

/**
 * The deciders the audit already knows (src/authority/approval.ts
 * `NOTCH_DECIDER`, src/daemon/approval-decision.ts `SYSTEM_DECIDER`). Written
 * out here so that nothing of the daemon is loaded for a word; a test holds
 * them equal.
 */
export const NOTCH_ACTION_DECIDER = 'notch';
export const NOTCH_ACTION_SYSTEM = 'system';

/** Whether the owner decided it on the notch just then: a key, words, a pick. */
const byOwner = (how: NotchActionHow): boolean => how === 'key' || how === 'said' || how === 'pick';

/** How the audit calls what came of it. Something done in a window that did not work ran and failed; a send that did not go never started. */
function auditOutcome(kind: Exclude<NotchActionKind, 'approval'>, outcome: NotchActionOutcome): AuditOutcome | null {
  if (outcome === 'done') return 'succeeded';
  if (outcome === 'unsure') return 'unknown';
  // Done in part, then it failed: the audit has no word for half, and it did not succeed.
  if (outcome === 'partly') return 'failed';
  if (outcome === 'not_done') return NOTCH_ACTION_CATEGORY[kind] === 'control_app' ? 'failed' : 'not_started';
  return null;
}

/**
 * The kinds that have a row in Today from somewhere else, and for which
 * outcomes: a reply that went is a row of the mail layer, a job is a row of
 * the jobs, a chase is a row from its start, an agent that was made is a row
 * of the agents, a promise that was kept is a row of the promises, an
 * approval is a row of the approvals. This list adds no second row for them.
 */
const ROW_ELSEWHERE: Partial<Record<NotchActionKind, readonly NotchActionOutcome[]>> = {
  mail_reply: ['done'], mail_slot: ['done'], chase_mail: ['done'],
  agent_made: ['done', 'undone'],
  // A job's own row is there however it ended, may have happened too (it keeps its Undo there). A thing put
  // that may have landed has none: the job of it is only opened once it is there. Nor has an approval whose
  // outcome is not known: Today lists those only once their receipt says done.
  job_rounds: ['done', 'partly', 'unsure', 'undone'], job_skill: ['done', 'partly', 'unsure', 'undone'], put: ['done', 'undone'],
  promise: ['done'],
  approval: ['done', 'undone', 'handed'],
};

/** The small word on the right of a row of Today. */
function small(row: NotchActionRow): string {
  if (row.outcome === 'undone') return 'taken back';
  const sends = row.kind !== 'approval' && (NOTCH_ACTION_CATEGORY[row.kind] === 'send_email' || NOTCH_ACTION_CATEGORY[row.kind] === 'send_message');
  if (row.outcome === 'unsure') return sends ? 'may have gone' : 'may have happened';
  if (row.outcome === 'partly') return 'partly done';
  return sends ? 'sent' : 'done';
}

interface Stored {
  id: string; at: number; updated_at: number; kind: string; what: string; target: string | null; seen: string; fuse_ms: number | null;
  how: string; outcome: string; ref: string | null; approval_id: string | null;
}

const rowOf = (stored: Stored): NotchActionRow => ({
  id: stored.id, at: stored.at, updatedAt: stored.updated_at, kind: stored.kind as NotchActionKind, what: stored.what, target: stored.target,
  seen: stored.seen as NotchActionSeen, fuseMs: stored.fuse_ms, how: stored.how as NotchActionHow, outcome: stored.outcome as NotchActionOutcome,
  ref: stored.ref, approvalId: stored.approval_id,
});

const oneLine = (text: string, most: number): string => {
  const points = [...text.replace(/\s+/g, ' ').trim()];
  return points.length <= most ? points.join('') : `${points.slice(0, most - 3).join('').trimEnd()}...`;
};

/** Makes the list on a brain that has the notch on. Throws when its table cannot be made: then the notch does not start, and says so. */
export function attachNotchActions(db: Database, deps: NotchActionsDeps = {}): NotchActions {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  db.run(`CREATE TABLE IF NOT EXISTS notch_actions (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    what TEXT NOT NULL,
    target TEXT,
    seen TEXT NOT NULL,
    fuse_ms INTEGER,
    how TEXT NOT NULL,
    outcome TEXT NOT NULL,
    ref TEXT,
    approval_id TEXT
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_notch_actions_at ON notch_actions(at)');
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_notch_actions_ref ON notch_actions(ref) WHERE ref IS NOT NULL');

  const failed = (what: string, error: unknown): void => {
    // The kind of failure only: an error's own words may quote what was being written.
    try { log(`[notch] ${what}: ${error instanceof Error ? error.name : 'error'}`); } catch { /* a log that fails says nothing */ }
  };

  const byRef = (ref: string): NotchActionRow | null => {
    const stored = db.query('SELECT * FROM notch_actions WHERE ref = ?').get(ref) as Stored | null;
    return stored ? rowOf(stored) : null;
  };

  /** One row of the audit for an entry as it stands now. Its own failure is said, and the entry stands. */
  function audit(row: NotchActionRow, undo = false): void {
    if (!deps.audit || row.kind === 'approval' || row.outcome === 'handed') return;
    try {
      const owner = byOwner(row.how);
      deps.audit.log({
        agent_id: 'notch', agent_name: NOTCH_NAME,
        tool_name: undo ? `notch_${row.kind}_undo` : `notch_${row.kind}`,
        action_category: NOTCH_ACTION_CATEGORY[row.kind],
        authority_decision: 'allowed',
        // An undo is something that was done, too: the taking back ran. The entry keeps its outcome.
        executed: undo || row.outcome === 'done' || row.outcome === 'partly',
        channel: undo || owner ? 'notch' : 'system',
        decided_by: undo || owner ? NOTCH_ACTION_DECIDER : NOTCH_ACTION_SYSTEM,
        effect_id: row.id,
        // Taken back is the last word of the ledger entry: a reader of the entry sees it, not "succeeded".
        outcome: undo ? 'undone' : auditOutcome(row.kind, row.outcome),
      });
    } catch (error) {
      failed('an action was written down, but not in the audit trail', error);
    }
  }

  function insert(entry: NotchActionEntry): NotchActionRow {
    const at = now();
    const row: NotchActionRow = {
      id: `na-${crypto.randomUUID()}`, at, updatedAt: at, kind: entry.kind, what: oneLine(entry.what, NOTCH_ACTION_WHAT_MAX),
      target: entry.target ? oneLine(entry.target, 200) : null, seen: entry.asked.seen, fuseMs: entry.asked.fuseMs ?? null, how: entry.asked.how,
      outcome: entry.outcome, ref: entry.ref ?? null, approvalId: entry.approvalId ?? null,
    };
    db.run(
      `INSERT INTO notch_actions (id, at, updated_at, kind, what, target, seen, fuse_ms, how, outcome, ref, approval_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.at, row.updatedAt, row.kind, row.what, row.target, row.seen, row.fuseMs, row.how, row.outcome, row.ref, row.approvalId],
    );
    return row;
  }

  function record(entry: NotchActionEntry): string | null {
    try {
      const before = entry.ref ? byRef(entry.ref) : null;
      if (!before) {
        const row = insert(entry);
        audit(row);
        return row.id;
      }
      // The same action again: tried a second time, gone on with, or ended another way. What the owner saw and
      // how they decided is what led to this outcome.
      const row: NotchActionRow = {
        ...before, updatedAt: now(), what: oneLine(entry.what, NOTCH_ACTION_WHAT_MAX), target: entry.target ? oneLine(entry.target, 200) : before.target,
        seen: entry.asked.seen, fuseMs: entry.asked.fuseMs ?? null, how: entry.asked.how, outcome: entry.outcome,
      };
      db.run('UPDATE notch_actions SET updated_at = ?, what = ?, target = ?, seen = ?, fuse_ms = ?, how = ?, outcome = ? WHERE id = ?',
        [row.updatedAt, row.what, row.target, row.seen, row.fuseMs, row.how, row.outcome, row.id]);
      if (row.outcome !== before.outcome) audit(row);
      return row.id;
    } catch (error) {
      failed('an action could not be written down', error);
      return null;
    }
  }

  function settle(ref: string, outcome: NotchActionOutcome, more: { what?: string; otherwise?: NotchActionEntry } = {}): boolean {
    try {
      const before = byRef(ref);
      if (!before) return more.otherwise ? record({ ...more.otherwise, ref, outcome }) !== null : false;
      const what = more.what ? oneLine(more.what, NOTCH_ACTION_WHAT_MAX) : before.what;
      if (before.outcome === outcome && before.what === what) return true;
      const row: NotchActionRow = { ...before, updatedAt: now(), outcome, what };
      db.run('UPDATE notch_actions SET updated_at = ?, outcome = ?, what = ? WHERE id = ?', [row.updatedAt, row.outcome, row.what, row.id]);
      if (row.outcome !== before.outcome) audit(row, outcome === 'undone');
      return true;
    } catch (error) {
      failed('what came of an action could not be written down', error);
      return false;
    }
  }

  const since = (from: number, until = Number.MAX_SAFE_INTEGER): NotchActionRow[] =>
    (db.query('SELECT * FROM notch_actions WHERE at >= ? AND at <= ? ORDER BY at DESC, rowid DESC').all(from, until) as Stored[]).map(rowOf);

  return {
    record,
    settle,
    undone: (ref) => settle(ref, 'undone'),
    since,
    byRef: (ref) => { try { return byRef(ref); } catch { return null; } },
    today(from) {
      try {
        return since(from)
          .filter((row) => row.outcome !== 'not_done' && row.outcome !== 'handed' && !(ROW_ELSEWHERE[row.kind] ?? []).includes(row.outcome))
          .map((row) => ({ id: `action:${row.id}`, at: row.at, text: row.what, small: small(row), undo: false }));
      } catch (error) {
        failed('what was done could not be read for Today', error);
        return [];
      }
    },
  };
}

/**
 * How a yes that a script has just been handed was given: in words (said or
 * typed over the line, ./said.ts), or on the page. `on` is what the page's
 * own answer was: the yes key, or a pick.
 */
export function notchAskedHow(stage: { answeredHow(): 'key' | 'said' }, on: 'key' | 'pick' = 'key'): NotchActionHow {
  return stage.answeredHow() === 'said' ? 'said' : on;
}

/**
 * What came of something sent to another person's Jarvis (src/peers/link.ts
 * `PeerSent`): it went, it did not, or the line broke before the answer and
 * it may have gone.
 */
export function notchSentOutcome(sent: { ok: boolean; why?: string }): NotchActionOutcome {
  return sent.ok ? 'done' : sent.why === 'unknown' ? 'unsure' : 'not_done';
}
