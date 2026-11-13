/**
 * The ledger: every instruction given on the notch, typed or spoken, as one
 * row that says what was heard, what was understood and what was done.
 *
 * It is also what makes two promises hold:
 *
 *   - A recording that was turned away can never run. A row only runs by
 *     being claimed, and a claim moves it from `heard` to `running` in one
 *     statement. A row that is `dismissed` is not `heard`, so there is nothing
 *     to claim, whatever arrives late and from wherever.
 *   - Nothing runs twice. A row is claimed once. What it starts carries the
 *     row's id as its request id, which the turn store refuses to accept a
 *     second time.
 *
 * The table exists only on a brain that has had the notch on: it is made when
 * the notch is attached, not with the rest of the vault.
 */
import type { Database } from 'bun:sqlite';

export type NotchAskSource = 'typed' | 'spoken';

/**
 *   listening     spoken: the keys are down
 *   transcribing  spoken: let go, being made into words
 *   heard         the words exist; nothing has run
 *   running       claimed: a turn or a memory write is under way
 *   done, failed, stopped   it ran, and this is how it ended
 *   dismissed     turned away before it ran
 *   missed        nothing was caught
 *   refused       it could not start (no model, something else running)
 */
export type NotchAskState =
  | 'listening' | 'transcribing' | 'heard' | 'running'
  | 'done' | 'failed' | 'stopped' | 'dismissed' | 'missed' | 'refused';

export interface NotchAskRow {
  id: string;
  createdAt: number;
  source: NotchAskSource;
  state: NotchAskState;
  /** What was typed, or what the speech was made into. Empty when nothing was caught. */
  heard: string;
  /** `turn`: it went to the agent. `remember`: it was written to memory. */
  kind: 'turn' | 'remember' | null;
  understood: string | null;
  /** What was done, one sentence each, in order. */
  did: string[];
  /** The answer, whole. */
  answer: string | null;
  /** Why it was missed, refused or failed. */
  note: string | null;
  conversationId: string | null;
  turnId: string | null;
  requestId: string | null;
  endedAt: number | null;
  /** When its result was shown and closed. Null until then: it is shown again after a restart. */
  seenAt: number | null;
}

interface Stored {
  id: string; created_at: number; source: string; state: string; heard: string; kind: string | null;
  understood: string | null; did: string | null; answer: string | null; note: string | null;
  conversation_id: string | null; turn_id: string | null; request_id: string | null;
  ended_at: number | null; seen_at: number | null;
}

/** The most of an answer the ledger keeps. The whole reply stays in the conversation. */
export const NOTCH_ANSWER_MAX = 20_000;

const BEFORE_RUNNING: NotchAskState[] = ['listening', 'transcribing', 'heard'];
const ENDED: NotchAskState[] = ['done', 'failed', 'stopped', 'dismissed', 'missed', 'refused'];

function parse(row: Stored): NotchAskRow {
  let did: string[] = [];
  try {
    const value: unknown = row.did ? JSON.parse(row.did) : [];
    if (Array.isArray(value)) did = value.filter((item): item is string => typeof item === 'string');
  } catch { /* an unreadable list is an empty one */ }
  return {
    id: row.id, createdAt: row.created_at, source: row.source === 'spoken' ? 'spoken' : 'typed',
    state: row.state as NotchAskState, heard: row.heard, kind: row.kind === 'turn' || row.kind === 'remember' ? row.kind : null,
    understood: row.understood, did, answer: row.answer, note: row.note,
    conversationId: row.conversation_id, turnId: row.turn_id, requestId: row.request_id,
    endedAt: row.ended_at, seenAt: row.seen_at,
  };
}

const marks = (states: NotchAskState[]): string => states.map(() => '?').join(', ');

export class NotchLedger {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {
    db.run(`CREATE TABLE IF NOT EXISTS notch_asks (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      state TEXT NOT NULL,
      heard TEXT NOT NULL DEFAULT '',
      kind TEXT,
      understood TEXT,
      did TEXT,
      answer TEXT,
      note TEXT,
      conversation_id TEXT,
      turn_id TEXT,
      request_id TEXT,
      ended_at INTEGER,
      seen_at INTEGER
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_notch_asks_created ON notch_asks(created_at)');
  }

  /** A new instruction. Typed ones begin as `heard`; spoken ones as `listening`. */
  open(id: string, source: NotchAskSource, heard = ''): NotchAskRow {
    this.db.run('INSERT INTO notch_asks (id, created_at, source, state, heard) VALUES (?, ?, ?, ?, ?)',
      [id, this.now(), source, source === 'typed' ? 'heard' : 'listening', heard]);
    return this.get(id)!;
  }

  get(id: string): NotchAskRow | null {
    const row = this.db.query<Stored, [string]>('SELECT * FROM notch_asks WHERE id = ?').get(id);
    return row ? parse(row) : null;
  }

  /** Moves a row from one of `from` to `to`. False when it was in none of them: nothing changed. */
  private move(id: string, from: NotchAskState[], to: NotchAskState, set: Record<string, string | number | null> = {}): boolean {
    const columns = Object.keys(set);
    const ended = ENDED.includes(to) ? ', ended_at = ?' : '';
    const sql = `UPDATE notch_asks SET state = ?${columns.map((column) => `, ${column} = ?`).join('')}${ended}
      WHERE id = ? AND state IN (${marks(from)})`;
    const args = [to, ...columns.map((column) => set[column]!), ...(ended ? [this.now()] : []), id, ...from];
    return this.db.run(sql, args).changes === 1;
  }

  /** The keys came up: the recording is being made into words. */
  transcribing(id: string): boolean {
    return this.move(id, ['listening'], 'transcribing');
  }

  /** The words are in. False if the row was turned away while they were being made. */
  heard(id: string, words: string): boolean {
    return this.move(id, ['listening', 'transcribing'], 'heard', { heard: words });
  }

  /**
   * Takes the row to run it. True exactly once, and only for a row that is
   * `heard`: this is the one way anything on the notch starts.
   */
  claim(id: string, kind: 'turn' | 'remember', turn?: { conversationId: string; turnId: string; requestId: string }): boolean {
    return this.move(id, ['heard'], 'running', {
      kind, conversation_id: turn?.conversationId ?? null, turn_id: turn?.turnId ?? null, request_id: turn?.requestId ?? null,
    });
  }

  /** Turned away before it ran. False if it had already been claimed, or was over. */
  dismiss(id: string, note: string | null = null): boolean {
    return this.move(id, BEFORE_RUNNING, 'dismissed', { note });
  }

  /** Nothing was caught. */
  missed(id: string, note: string): boolean {
    return this.move(id, BEFORE_RUNNING, 'missed', { note });
  }

  /** It could not start. */
  refused(id: string, note: string): boolean {
    return this.move(id, BEFORE_RUNNING, 'refused', { note });
  }

  /** One more thing that was done for a running row. */
  did(id: string, sentence: string): void {
    const row = this.get(id);
    if (!row || row.state !== 'running' || row.did.at(-1) === sentence || row.did.length >= 40) return;
    this.db.run('UPDATE notch_asks SET did = ? WHERE id = ?', [JSON.stringify([...row.did, sentence]), id]);
  }

  /** What a running row was understood as. */
  understood(id: string, understood: string): void {
    this.db.run("UPDATE notch_asks SET understood = ? WHERE id = ? AND state = 'running'", [understood.slice(0, 500), id]);
  }

  /** How a running row ended. */
  finish(id: string, state: 'done' | 'failed' | 'stopped', result: { answer?: string | null; note?: string | null } = {}): boolean {
    const answer = result.answer ? [...result.answer].slice(0, NOTCH_ANSWER_MAX).join('') : null;
    return this.move(id, ['running'], state, { answer, note: result.note ?? null });
  }

  /** Its result was shown and closed. */
  seen(id: string): void {
    this.db.run('UPDATE notch_asks SET seen_at = ? WHERE id = ? AND seen_at IS NULL', [this.now(), id]);
  }

  /** The newest rows first. */
  recent(limit = 50): NotchAskRow[] {
    return this.db.query<Stored, [number]>('SELECT * FROM notch_asks ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit).map(parse);
  }

  /** Rows that ran and whose result nobody has closed yet, oldest first. */
  unseen(): NotchAskRow[] {
    return this.db.query<Stored, []>(
      "SELECT * FROM notch_asks WHERE seen_at IS NULL AND state IN ('done', 'failed', 'stopped') ORDER BY created_at, rowid",
    ).all().map(parse);
  }

  /** Rows that were under way when the brain last stopped. */
  unfinished(): NotchAskRow[] {
    return this.db.query<Stored, []>(
      "SELECT * FROM notch_asks WHERE state IN ('listening', 'transcribing', 'heard', 'running') ORDER BY created_at, rowid",
    ).all().map(parse);
  }
}
