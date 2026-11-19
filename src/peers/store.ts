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

export class PeerStore {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {
    db.run('CREATE TABLE IF NOT EXISTS notch_peer_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.run(`CREATE TABLE IF NOT EXISTS notch_peer_sent (
      id TEXT PRIMARY KEY, to_id TEXT NOT NULL, kind TEXT NOT NULL, words TEXT NOT NULL, options_json TEXT NOT NULL DEFAULT '[]',
      sent_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'sent', answer TEXT, nudged_at INTEGER, first_id TEXT)`);
    db.run('CREATE TABLE IF NOT EXISTS notch_peer_got (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0)');
    const before = this.now() - PEER_KEEP_MS;
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

  /** Questions that are out since before `before`, were not answered, and the person was not yet told so. */
  unanswered(before: number): PeerSentRow[] {
    return (this.db.query("SELECT * FROM notch_peer_sent WHERE kind = 'ask' AND state IN ('sent', 'seen') AND nudged_at IS NULL AND sent_at <= ? ORDER BY sent_at").all(before) as Record<string, unknown>[])
      .map((raw) => this.read(raw)).filter((row): row is PeerSentRow => !!row);
  }

  nudged(id: string): void {
    this.db.run('UPDATE notch_peer_sent SET nudged_at = ? WHERE id = ?', [this.now(), id]);
  }

  /** Whether an arrival was already taken in, and whether the person is done with it. */
  got(id: string): { done: boolean } | null {
    const row = this.db.query('SELECT done FROM notch_peer_got WHERE id = ?').get(id) as { done: number } | null;
    return row ? { done: row.done === 1 } : null;
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
