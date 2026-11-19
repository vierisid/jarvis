/**
 * What the brain itself keeps about other people's Jarvises.
 *
 * The engine keeps the keys, the contacts and the messages. This is the
 * little the notch needs on top: what the organisation is called, what was
 * sent and is still waited on, and what arrived and was already shown. The
 * last is what makes a no an answer: an item that was shown and answered is
 * not put to the person again, whatever the engine still lists as unread.
 *
 * It lives in the brain's own data, like the mail the notch reads. Rows
 * older than PEER_KEEP_MS are dropped.
 */
import type { Database } from 'bun:sqlite';

export const PEER_KEEP_MS = 30 * 24 * 3_600_000;

export type PeerSentKind = 'tell' | 'ask';
/** sent: out, nothing heard. seen: the other person saw it. answered: they picked. back: taken back. */
export type PeerSentState = 'sent' | 'seen' | 'answered' | 'back';

export interface PeerSentRow {
  id: string;
  to: string;
  kind: PeerSentKind;
  words: string;
  options: string[];
  sentAt: number;
  state: PeerSentState;
  answer: string | null;
  /** When the person was told that no answer came. Told once. */
  nudgedAt: number | null;
}

/**
 * Where a request stands here.
 *
 *   new      asked, nothing decided (in), or out and nothing back (out).
 *   working  the person said yes and it is being done (in).
 *   ready    its answer is found and waits to be shown before it goes (in).
 *   done     ended with an answer.
 *   no       ended without one.
 */
export const PEER_REQUEST_STATES = ['new', 'working', 'ready', 'done', 'no'] as const;
export type PeerRequestState = (typeof PEER_REQUEST_STATES)[number];

export interface PeerRequestRow {
  id: string;
  dir: 'in' | 'out';
  peer: string;
  words: string;
  at: number;
  state: PeerRequestState;
  /** The answer that was found and not yet sent (in), or that came back (out). */
  answer: string | null;
  /** The arrival it came as (in). */
  item: string | null;
  nudgedAt: number | null;
}

export class PeerStore {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {
    db.run('CREATE TABLE IF NOT EXISTS notch_peer_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.run(`CREATE TABLE IF NOT EXISTS notch_peer_sent (
      id TEXT PRIMARY KEY, to_id TEXT NOT NULL, kind TEXT NOT NULL, words TEXT NOT NULL, options_json TEXT NOT NULL DEFAULT '[]',
      sent_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'sent', answer TEXT, nudged_at INTEGER, first_id TEXT)`);
    db.run('CREATE TABLE IF NOT EXISTS notch_peer_got (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0)');
    db.run(`CREATE TABLE IF NOT EXISTS notch_peer_requests (
      id TEXT PRIMARY KEY, dir TEXT NOT NULL, peer_id TEXT NOT NULL, words TEXT NOT NULL, at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'new', answer TEXT, item_id TEXT, nudged_at INTEGER)`);
    const before = this.now() - PEER_KEEP_MS;
    db.run('DELETE FROM notch_peer_requests WHERE at < ?', [before]);
    db.run('DELETE FROM notch_peer_sent WHERE sent_at < ?', [before]);
    db.run('DELETE FROM notch_peer_got WHERE at < ?', [before]);
  }

  /** What the organisation is called here. Null until it has a name. */
  org(): string | null {
    const row = this.db.query('SELECT value FROM notch_peer_meta WHERE key = ?').get('org') as { value: string } | null;
    return row?.value || null;
  }

  setOrg(name: string): void {
    this.db.run('INSERT INTO notch_peer_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', ['org', name]);
  }

  /** Notes something that went out. `again` is the id it was first sent under, when it is asked once more. */
  sent(row: { id: string; to: string; kind: PeerSentKind; words: string; options?: string[]; again?: string }): void {
    this.db.run('INSERT OR REPLACE INTO notch_peer_sent (id, to_id, kind, words, options_json, sent_at, first_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [row.id, row.to, row.kind, row.words, JSON.stringify(row.options ?? []), this.now(), row.again ?? null]);
  }

  private read(raw: Record<string, unknown> | null): PeerSentRow | null {
    if (!raw) return null;
    let options: string[] = [];
    try { const parsed: unknown = JSON.parse(String(raw.options_json ?? '[]')); if (Array.isArray(parsed)) options = parsed.filter((one): one is string => typeof one === 'string'); } catch { options = []; }
    return {
      id: String(raw.id), to: String(raw.to_id), kind: raw.kind === 'ask' ? 'ask' : 'tell', words: String(raw.words), options,
      sentAt: Number(raw.sent_at), state: (['sent', 'seen', 'answered', 'back'] as const).find((one) => one === raw.state) ?? 'sent',
      answer: typeof raw.answer === 'string' ? raw.answer : null, nudgedAt: typeof raw.nudged_at === 'number' ? raw.nudged_at : null,
    };
  }

  /** What was sent under that id, to that person. Null for an id nothing was sent under, or sent to somebody else. */
  sentTo(id: string, to: string): PeerSentRow | null {
    return this.read(this.db.query('SELECT * FROM notch_peer_sent WHERE id = ? AND to_id = ?').get(id, to) as Record<string, unknown> | null);
  }

  /** Moves a sent thing on. Only forward: an answer or a taking back is the end. */
  mark(id: string, state: PeerSentState, answer?: string): boolean {
    const allowed = state === 'seen' ? ['sent'] : state === 'answered' ? ['sent', 'seen'] : state === 'back' ? ['sent', 'seen'] : [];
    if (!allowed.length) return false;
    const marks = allowed.map(() => '?').join(',');
    const done = this.db.run(`UPDATE notch_peer_sent SET state = ?, answer = COALESCE(?, answer) WHERE id = ? AND state IN (${marks})`, [state, answer ?? null, id, ...allowed]);
    // Asked once more: every sending of the same question ends with it.
    if (done.changes > 0 && state !== 'seen') {
      const first = (this.db.query('SELECT first_id FROM notch_peer_sent WHERE id = ?').get(id) as { first_id: string | null } | null)?.first_id ?? id;
      this.db.run("UPDATE notch_peer_sent SET state = ?, answer = COALESCE(?, answer) WHERE (id = ? OR first_id = ?) AND state IN ('sent', 'seen')", [state, answer ?? null, first, first]);
    }
    return done.changes > 0;
  }

  /** Every id one question was sent under: the first sending, and each time it was asked again. */
  sendings(id: string): string[] {
    const first = (this.db.query('SELECT first_id FROM notch_peer_sent WHERE id = ?').get(id) as { first_id: string | null } | null)?.first_id ?? id;
    return (this.db.query('SELECT id FROM notch_peer_sent WHERE id = ? OR first_id = ? ORDER BY sent_at').all(first, first) as { id: string }[]).map((row) => row.id);
  }

  /** Questions that are out since before `before`, were not answered, and the person was not yet told so. */
  unanswered(before: number): PeerSentRow[] {
    return (this.db.query("SELECT * FROM notch_peer_sent WHERE kind = 'ask' AND state IN ('sent', 'seen') AND nudged_at IS NULL AND sent_at <= ? ORDER BY sent_at").all(before) as Record<string, unknown>[])
      .map((raw) => this.read(raw)).filter((row): row is PeerSentRow => !!row);
  }

  nudged(id: string): void {
    this.db.run('UPDATE notch_peer_sent SET nudged_at = ? WHERE id = ?', [this.now(), id]);
  }

  // Requests: what this machine asked of another's Jarvis (out), and what was asked of this one (in).

  /** Notes a request. One that is known already is left as it is. */
  request(row: { id: string; dir: 'in' | 'out'; peer: string; words: string; item?: string }): void {
    this.db.run('INSERT OR IGNORE INTO notch_peer_requests (id, dir, peer_id, words, at, item_id) VALUES (?, ?, ?, ?, ?, ?)', [row.id, row.dir, row.peer, row.words, this.now(), row.item ?? null]);
  }

  private readRequest(raw: Record<string, unknown> | null): PeerRequestRow | null {
    if (!raw) return null;
    return {
      id: String(raw.id), dir: raw.dir === 'in' ? 'in' : 'out', peer: String(raw.peer_id), words: String(raw.words), at: Number(raw.at),
      state: (PEER_REQUEST_STATES as readonly string[]).includes(String(raw.state)) ? raw.state as PeerRequestState : 'new',
      answer: typeof raw.answer === 'string' ? raw.answer : null, item: typeof raw.item_id === 'string' ? raw.item_id : null,
      nudgedAt: typeof raw.nudged_at === 'number' ? raw.nudged_at : null,
    };
  }

  requestOf(id: string): PeerRequestRow | null {
    return this.readRequest(this.db.query('SELECT * FROM notch_peer_requests WHERE id = ?').get(id) as Record<string, unknown> | null);
  }

  /** Requests of one direction that have not ended, the oldest first. */
  openRequests(dir: 'in' | 'out'): PeerRequestRow[] {
    return (this.db.query("SELECT * FROM notch_peer_requests WHERE dir = ? AND state NOT IN ('done', 'no') ORDER BY at").all(dir) as Record<string, unknown>[])
      .map((raw) => this.readRequest(raw)).filter((row): row is PeerRequestRow => !!row);
  }

  /** Moves a request on. One that has ended stays ended. */
  requestState(id: string, state: PeerRequestState, answer?: string | null): boolean {
    return this.db.run("UPDATE notch_peer_requests SET state = ?, answer = CASE WHEN ? THEN ? ELSE answer END WHERE id = ? AND state NOT IN ('done', 'no')", [state, answer !== undefined ? 1 : 0, answer ?? null, id]).changes > 0;
  }

  requestNudged(id: string): void {
    this.db.run('UPDATE notch_peer_requests SET nudged_at = ? WHERE id = ?', [this.now(), id]);
  }

  /** Whether an arrival was already taken in, and whether the person is done with it. */
  got(id: string): { done: boolean } | null {
    const row = this.db.query('SELECT done FROM notch_peer_got WHERE id = ?').get(id) as { done: number } | null;
    return row ? { done: row.done === 1 } : null;
  }

  /** The device an arrival came from. Null for one that was never taken in. */
  gotFrom(id: string): string | null {
    return (this.db.query('SELECT from_id FROM notch_peer_got WHERE id = ?').get(id) as { from_id: string } | null)?.from_id ?? null;
  }

  take(id: string, from: string): void {
    this.db.run('INSERT OR IGNORE INTO notch_peer_got (id, from_id, at) VALUES (?, ?, ?)', [id, from, this.now()]);
  }

  /** The person is done with it: it is never put to them again. */
  done(id: string): void {
    this.db.run('UPDATE notch_peer_got SET done = 1 WHERE id = ?', [id]);
  }

  /** What arrived, was taken in, and still waits for the person: read again from the engine after a restart. */
  waiting(): string[] {
    return (this.db.query('SELECT id FROM notch_peer_got WHERE done = 0 ORDER BY at').all() as { id: string }[]).map((row) => row.id);
  }
}
