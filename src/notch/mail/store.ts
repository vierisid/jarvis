/**
 * What the mail layer remembers between two looks at the mailbox.
 *
 * Two things, in the brain's own database:
 *
 *  - Each thread it has read: what the list showed of it then (so a thread
 *    that has not changed is not read again), and, when a person's message
 *    was too new to speak of, the moment it will have waited long enough.
 *  - Each message it was asked about: one row per message a person was
 *    waiting on, with what came of it. A message is put to the model once.
 *    The reply that was prepared is kept here as prepared work, with what it
 *    cost, until it is sent, turned down, or overtaken by the thread.
 *
 * The mail itself is not kept: a thread is read again from the mailbox when
 * it is needed. What is kept of it is the prepared reply, who it goes to and
 * the subject line.
 *
 * The tables exist only on a brain that has had the notch on: they are made
 * when the mail layer is attached, not with the rest of the vault.
 */
import type { Database } from 'bun:sqlite';
import { mailRowSlots, type MailRowSlot } from './slots.ts';
import type { MailPerson } from './thread.ts';

/**
 *   ready     a reply is prepared and waits for the owner's word
 *   silent    the model judged that the message needs no reply
 *   declined  the owner turned the reply down
 *   sent      the reply went out
 *   answered  the thread moved on by itself: the owner answered by hand, began a draft, or the other side wrote again
 *   failed    the model gave nothing that could be used
 */
export type MailProposalState = 'ready' | 'silent' | 'declined' | 'sent' | 'answered' | 'failed';

export interface MailProposalRow {
  /** The thread and the moment the waiting message was sent: one row per message waited on. */
  id: string;
  thread: string;
  messageAt: number;
  state: MailProposalState;
  who: MailPerson;
  subject: string;
  to: MailPerson[];
  cc: MailPerson[];
  draft: string;
  /** The words in the draft that name a proposed time, or null. */
  time: string | null;
  missing: string;
  lookFor: string;
  /** Files found for `lookFor`, when it was looked for. */
  found: { id: string; name: string; kind: string }[] | null;
  /** How the draft was asked to be written, when the owner asked for another manner. Empty: as they write. */
  tone: string;
  /** What the owner told Jarvis for this reply, after it said what it did not know. Empty: nothing. */
  told: string;
  /** What the thread is, for the owner, in one short sentence. Empty when none was made. */
  about: string;
  /**
   * Free times the reply can offer, the one it names among them, each with
   * its words in the reply (./slots.ts). Null or absent: the reply offers no
   * time, or the calendar could not be read.
   */
  slots?: MailRowSlot[] | null;
  /** What they asked for, as the end of "Anna asked ...". Empty or absent when not known. */
  asked?: string;
  model: string;
  /** Tokens read and written for this message, every draft of it counted. */
  tokensIn: number;
  tokensOut: number;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
}

export interface MailThreadSeen {
  /** What the list showed when the thread was last read. */
  signature: string;
  readAt: number;
  /** When a message that was too new will have waited long enough, or null. */
  dueAt: number | null;
}

export const mailProposalId = (thread: string, messageAt: number): string => `${thread}:${messageAt}`;

/**
 * The manners a person can always be written to in: what a reply can be
 * written again in on its draft (./notch.ts, MAIL_TONES), less the owner's
 * own. Anything else that is found stored is taken as none.
 */
export const MAIL_STANDING_TONES: readonly string[] = ['shorter', 'more warmly', 'more formally'];

/** The manner one person is always written to in: "Always use a short tone with Marco?", answered yes. */
export interface MailTone { address: string; name: string; tone: string; at: number }

interface StoredProposal {
  id: string; thread_id: string; message_at: number; state: string;
  who_name: string; who_address: string; subject: string; to_json: string; cc_json: string;
  draft: string; time: string | null; missing: string; look_for: string; found_json: string | null; tone: string; told?: string | null; about?: string | null; slots_json?: string | null; asked?: string | null;
  model: string; tokens_in: number; tokens_out: number; created_at: number; updated_at: number; sent_at: number | null;
}

function people(json: string): MailPerson[] {
  try {
    const raw: unknown = JSON.parse(json);
    return Array.isArray(raw) ? raw.filter((who): who is MailPerson => !!who && typeof who.name === 'string' && typeof who.address === 'string') : [];
  } catch {
    return [];
  }
}

function rowOf(stored: StoredProposal): MailProposalRow {
  let found: MailProposalRow['found'] = null;
  try { found = stored.found_json ? JSON.parse(stored.found_json) as MailProposalRow['found'] : null; } catch { found = null; }
  let slots: MailRowSlot[] | null = null;
  try { slots = stored.slots_json ? mailRowSlots(JSON.parse(stored.slots_json)) : null; } catch { slots = null; }
  return {
    id: stored.id,
    thread: stored.thread_id,
    messageAt: stored.message_at,
    state: stored.state as MailProposalState,
    who: { name: stored.who_name, address: stored.who_address },
    subject: stored.subject,
    to: people(stored.to_json),
    cc: people(stored.cc_json),
    draft: stored.draft,
    time: stored.time,
    missing: stored.missing,
    lookFor: stored.look_for,
    found,
    tone: stored.tone,
    told: stored.told ?? '',
    about: stored.about ?? '',
    slots,
    asked: stored.asked ?? '',
    model: stored.model,
    tokensIn: stored.tokens_in,
    tokensOut: stored.tokens_out,
    createdAt: stored.created_at,
    updatedAt: stored.updated_at,
    sentAt: stored.sent_at,
  };
}

export class MailStore {
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS notch_mail_threads (
      thread_id TEXT PRIMARY KEY,
      signature TEXT NOT NULL,
      read_at INTEGER NOT NULL,
      due_at INTEGER
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS notch_mail_proposals (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_at INTEGER NOT NULL,
      state TEXT NOT NULL,
      who_name TEXT NOT NULL DEFAULT '',
      who_address TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      to_json TEXT NOT NULL DEFAULT '[]',
      cc_json TEXT NOT NULL DEFAULT '[]',
      draft TEXT NOT NULL DEFAULT '',
      time TEXT,
      missing TEXT NOT NULL DEFAULT '',
      look_for TEXT NOT NULL DEFAULT '',
      found_json TEXT,
      tone TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      sent_at INTEGER
    )`);
    // Added after the table was first made: a brain that already has the table gets the column.
    const columns = (db.query('PRAGMA table_info(notch_mail_proposals)').all() as { name: string }[]).map((column) => column.name);
    if (!columns.includes('told')) db.run(`ALTER TABLE notch_mail_proposals ADD COLUMN told TEXT NOT NULL DEFAULT ''`);
    if (!columns.includes('about')) db.run(`ALTER TABLE notch_mail_proposals ADD COLUMN about TEXT NOT NULL DEFAULT ''`);
    if (!columns.includes('slots_json')) db.run('ALTER TABLE notch_mail_proposals ADD COLUMN slots_json TEXT');
    if (!columns.includes('asked')) db.run(`ALTER TABLE notch_mail_proposals ADD COLUMN asked TEXT NOT NULL DEFAULT ''`);
    // What the owner said about how one person is written to: the manner that stands, and the one they were
    // last asked about and turned down, so that the same question is not put twice.
    db.run(`CREATE TABLE IF NOT EXISTS notch_mail_tones (
      address TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      tone TEXT NOT NULL DEFAULT '',
      asked TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL
    )`);
    db.run('CREATE INDEX IF NOT EXISTS notch_mail_proposals_thread ON notch_mail_proposals (thread_id)');
    db.run('CREATE INDEX IF NOT EXISTS notch_mail_proposals_state ON notch_mail_proposals (state)');
  }

  /** What is remembered of a thread, or null when it was never read. */
  seen(thread: string): MailThreadSeen | null {
    const row = this.db.query('SELECT signature, read_at, due_at FROM notch_mail_threads WHERE thread_id = ?').get(thread) as
      { signature: string; read_at: number; due_at: number | null } | null;
    return row ? { signature: row.signature, readAt: row.read_at, dueAt: row.due_at } : null;
  }

  /** A thread was read: what the list showed of it, and when to look again by the clock, if ever. */
  saw(thread: string, signature: string, readAt: number, dueAt: number | null): void {
    this.db.run(
      `INSERT INTO notch_mail_threads (thread_id, signature, read_at, due_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET signature = excluded.signature, read_at = excluded.read_at, due_at = excluded.due_at`,
      [thread, signature, readAt, dueAt],
    );
  }

  /** Threads whose too-new message has now waited long enough. */
  due(now: number): string[] {
    return (this.db.query('SELECT thread_id FROM notch_mail_threads WHERE due_at IS NOT NULL AND due_at <= ? ORDER BY due_at').all(now) as { thread_id: string }[])
      .map((row) => row.thread_id);
  }

  proposal(id: string): MailProposalRow | null {
    const row = this.db.query('SELECT * FROM notch_mail_proposals WHERE id = ?').get(id) as StoredProposal | null;
    return row ? rowOf(row) : null;
  }

  /** The replies that wait for the owner's word, the newest message first. */
  ready(): MailProposalRow[] {
    return (this.db.query(`SELECT * FROM notch_mail_proposals WHERE state = 'ready' ORDER BY message_at DESC`).all() as StoredProposal[]).map(rowOf);
  }

  /** A new row, or the whole of an old one written again. */
  put(row: MailProposalRow): void {
    this.db.run(
      `INSERT OR REPLACE INTO notch_mail_proposals
       (id, thread_id, message_at, state, who_name, who_address, subject, to_json, cc_json, draft, time, missing, look_for, found_json, tone, told, about,
        slots_json, asked, model, tokens_in, tokens_out, created_at, updated_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.thread, row.messageAt, row.state, row.who.name, row.who.address, row.subject, JSON.stringify(row.to), JSON.stringify(row.cc),
        row.draft, row.time, row.missing, row.lookFor, row.found ? JSON.stringify(row.found) : null, row.tone, row.told, row.about,
        row.slots?.length ? JSON.stringify(row.slots) : null, row.asked ?? '', row.model, row.tokensIn, row.tokensOut, row.createdAt, row.updatedAt, row.sentAt],
    );
  }

  /**
   * Moves a row from one state to another, and only from that one: two things
   * that both want to end a reply (a send, and the thread moving on) cannot
   * both do it. True when this call was the one that did.
   */
  move(id: string, from: MailProposalState, to: MailProposalState, at: number): boolean {
    const result = this.db.run(
      `UPDATE notch_mail_proposals SET state = ?, updated_at = ?, sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END WHERE id = ? AND state = ?`,
      [to, at, to, at, id, from],
    );
    return result.changes === 1;
  }

  /** Every other row of the thread that still waits is overtaken: the thread has a newer message, or none waits any more. */
  overtake(thread: string, keep: string | null, at: number): string[] {
    const rows = this.db.query(`SELECT id FROM notch_mail_proposals WHERE thread_id = ? AND state = 'ready' AND id != ?`).all(thread, keep ?? '') as { id: string }[];
    for (const row of rows) this.move(row.id, 'ready', 'answered', at);
    return rows.map((row) => row.id);
  }

  /** How many rows are in each state: what the mail layer has done, as numbers. */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of this.db.query('SELECT state, COUNT(*) AS n FROM notch_mail_proposals GROUP BY state').all() as { state: string; n: number }[]) out[row.state] = row.n;
    out.threads = (this.db.query('SELECT COUNT(*) AS n FROM notch_mail_threads').get() as { n: number }).n;
    return out;
  }

  /** Replies sent since a moment, the newest first: for the list of what was done today. */
  sentSince(since: number): MailProposalRow[] {
    return (this.db.query(`SELECT * FROM notch_mail_proposals WHERE state = 'sent' AND sent_at >= ? ORDER BY sent_at DESC`).all(since) as StoredProposal[]).map(rowOf);
  }

  /**
   * The people who wrote to the owner and were waited on, by the name their
   * mail gives, the ones who wrote last first. Each once. For telling
   * whether a name that was heard is somebody's (../names.ts): nothing of
   * what they wrote is read here.
   */
  people(most = 400): { name: string; address: string }[] {
    return (this.db.query(
      `SELECT who_name AS name, who_address AS address FROM notch_mail_proposals
       WHERE who_name != '' AND who_address != '' GROUP BY who_address ORDER BY MAX(message_at) DESC LIMIT ?`,
    ).all(most) as { name: string; address: string }[]);
  }

  /** The mail of one address that was waited on, the newest first: for what is known before a call with them (../before.ts). */
  withPerson(address: string, most = 6): MailProposalRow[] {
    return (this.db.query('SELECT * FROM notch_mail_proposals WHERE who_address = ? COLLATE NOCASE ORDER BY message_at DESC LIMIT ?').all(address, most) as StoredProposal[]).map(rowOf);
  }

  /** The manner this person is always written to in, or '' when none was ever said. */
  tone(address: string): string {
    const row = this.db.query('SELECT tone FROM notch_mail_tones WHERE address = ?').get(address.toLowerCase()) as { tone: string } | null;
    return row && MAIL_STANDING_TONES.includes(row.tone) ? row.tone : '';
  }

  /** The manner the owner was last asked about for this person and turned down, or ''. */
  toneAsked(address: string): string {
    const row = this.db.query('SELECT asked FROM notch_mail_tones WHERE address = ?').get(address.toLowerCase()) as { asked: string } | null;
    return row?.asked ?? '';
  }

  /** The owner said yes: this person is written to in that manner from now on. Anything that is no such manner is not kept. */
  setTone(who: MailPerson, tone: string, at: number): boolean {
    if (!who.address || !MAIL_STANDING_TONES.includes(tone)) return false;
    this.db.run(
      `INSERT INTO notch_mail_tones (address, name, tone, asked, at) VALUES (?, ?, ?, '', ?)
       ON CONFLICT(address) DO UPDATE SET name = excluded.name, tone = excluded.tone, asked = '', at = excluded.at`,
      [who.address.toLowerCase(), who.name, tone, at],
    );
    return true;
  }

  /** The owner said no to that manner for this person: it is not asked again. What stood before stands. */
  declineTone(who: MailPerson, tone: string, at: number): void {
    if (!who.address) return;
    this.db.run(
      `INSERT INTO notch_mail_tones (address, name, tone, asked, at) VALUES (?, ?, '', ?, ?)
       ON CONFLICT(address) DO UPDATE SET asked = excluded.asked`,
      [who.address.toLowerCase(), who.name, tone, at],
    );
  }

  /** Everybody who is always written to in some manner, the newest first. */
  tones(): MailTone[] {
    return (this.db.query(`SELECT address, name, tone, at FROM notch_mail_tones WHERE tone != '' ORDER BY at DESC`).all() as MailTone[])
      .filter((row) => MAIL_STANDING_TONES.includes(row.tone));
  }

  /** Forgets how this person is written to. True when there was something to forget. */
  forgetTone(address: string): boolean {
    return this.db.run(`UPDATE notch_mail_tones SET tone = '' WHERE address = ? AND tone != ''`, [address.toLowerCase()]).changes === 1;
  }

  /** What every message asked about since a moment has cost, in tokens, whatever came of it. */
  costSince(since: number): { asked: number; tokensIn: number; tokensOut: number } {
    const row = this.db.query('SELECT COUNT(*) AS asked, COALESCE(SUM(tokens_in), 0) AS tokens_in, COALESCE(SUM(tokens_out), 0) AS tokens_out FROM notch_mail_proposals WHERE created_at >= ?').get(since) as
      { asked: number; tokens_in: number; tokens_out: number };
    return { asked: row.asked, tokensIn: row.tokens_in, tokensOut: row.tokens_out };
  }
}
