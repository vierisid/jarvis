/**
 * Gmail, read in Jarvis's own browser.
 *
 * Two things are read. The list of threads a search gives, a page at a time,
 * from the list Gmail shows (page/list.js). And a thread in full, from the
 * page Gmail makes for printing it (page/threads.js): every message, who
 * wrote it, to whom, when, and its text, in a build that has changed far
 * less over the years than the mailbox's own.
 *
 * The scripts that touch the page live in ./page. This file is what stays
 * the same whatever Gmail's page looks like: going from page to page, asking
 * for threads a few at a time, and turning what the scripts answer into
 * threads (./thread.ts). Whatever the page says is checked here before it is
 * believed: a thread whose dates or people could not be read is left out and
 * counted, never guessed at.
 */
import { mailPerson, type MailMessage, type MailPerson, type MailThread } from './thread.ts';

/** Runs one of the page scripts in Gmail and gives back its answer. */
export interface GmailPage { run<T>(name: string, args?: unknown): Promise<T> }

/** One row of Gmail's list, as page/list.js answers it. */
export interface GmailRow {
  /** The thread's id: sixteen hex digits. */
  id: string;
  /** Who is shown as taking part, in Gmail's order: oldest first. */
  people: { name: string; address: string }[];
  /** How many messages Gmail says it has. */
  count: number;
  /** The owner has a draft in it. */
  draft: boolean;
  subject: string;
}

export interface GmailListed {
  /** False when the list never showed for the place asked for. */
  there: boolean;
  rows: GmailRow[];
}

/** A thread as page/threads.js answers it. */
export interface GmailRawThread {
  id: string;
  /** Why it could not be read, when it could not. */
  failed?: string;
  subject: string;
  messages: { from: string; to: string; cc: string; at: number | null; text: string }[];
}

const THREAD_ID = /^[0-9a-f]{16}$/;
/** Gmail shows at most this many threads to a page, whatever the setting. */
export const GMAIL_PAGE_MOST = 100;

/** The place in Gmail that shows a search, and its further pages. */
export function gmailSearchPlace(query: string, page = 1): string {
  return `#search/${encodeURIComponent(query)}${page > 1 ? `/p${page}` : ''}`;
}

function rowOf(raw: unknown): GmailRow | null {
  const row = raw as Partial<GmailRow> | null;
  if (!row || typeof row.id !== 'string' || !THREAD_ID.test(row.id) || !Array.isArray(row.people)) return null;
  return {
    id: row.id,
    people: row.people.filter((who) => who && typeof who.address === 'string' && who.address.includes('@'))
      .map((who) => mailPerson(typeof who.name === 'string' ? who.name : '', who.address)),
    count: typeof row.count === 'number' && row.count >= 1 ? Math.floor(row.count) : 1,
    draft: row.draft === true,
    subject: typeof row.subject === 'string' ? row.subject : '',
  };
}

/**
 * Every thread a search gives, by going through its pages. It stops at a
 * page that is short of a full one, empty, or the same as the one before
 * (Gmail shows the last page again when asked for one past it).
 */
export async function gmailSearch(page: GmailPage, query: string, options: { pages?: number; each?: (page: number, rows: number) => void } = {}): Promise<GmailRow[]> {
  const found = new Map<string, GmailRow>();
  let full = 0;
  let before = '';
  for (let at = 1; at <= (options.pages ?? 60); at++) {
    const place = gmailSearchPlace(query, at);
    await page.run('go', { place });
    const listed = await page.run<GmailListed>('list', { place, not: before });
    if (!listed.there) {
      // The first page not showing is a failure. A later one is the end of the list.
      if (at === 1) throw new Error('Gmail did not show the list for that search');
      break;
    }
    const rows = listed.rows.map(rowOf).filter((row): row is GmailRow => !!row);
    options.each?.(at, rows.length);
    const first = rows[0]?.id ?? '';
    if (rows.length === 0 || first === before) break;
    before = first;
    let fresh = 0;
    for (const row of rows) {
      if (!found.has(row.id)) fresh++;
      found.set(row.id, row);
    }
    full = Math.max(full, rows.length);
    if (fresh === 0 || rows.length < full) break;
  }
  return [...found.values()];
}

const ADDRESS = /(?:"((?:[^"\\]|\\.)*)"|([^<>,;"]*?))\s*<([^<>\s]+@[^<>\s]+)>|([^\s<>,;"]+@[^\s<>,;"]+)/g;

/** The people in a line like `Leo Bianchi <leo@x>, "Conti, Anna" <anna@y>, nora@z`. */
export function gmailPeople(line: string): MailPerson[] {
  const people: MailPerson[] = [];
  const seen = new Set<string>();
  for (const match of line.matchAll(ADDRESS)) {
    const who = mailPerson((match[1] ?? match[2] ?? '').replace(/\\(.)/g, '$1'), match[3] ?? match[4] ?? '');
    if (seen.has(who.address)) continue;
    seen.add(who.address);
    people.push(who);
  }
  return people;
}

/** Where the quoted history under a reply begins, in the ways mail programs write it. */
const QUOTED = [
  /^[ \t]*On .{6,200}wrote:[ \t]*$/m,
  /^[ \t]*On .{6,120}\n.{0,120}wrote:[ \t]*$/m,
  /^[ \t]*Il (?:giorno )?.{6,200}ha scritto:[ \t]*$/m,
  /^[ \t]*Le .{6,200}a écrit\s*:[ \t]*$/m,
  /^[ \t]*Am .{6,200}schrieb.{0,80}:[ \t]*$/m,
  /^[ \t]*El .{6,200}escribió:[ \t]*$/m,
  /^[ \t]*-{2,} ?(?:Original Message|Messaggio originale|Ursprüngliche Nachricht|Message d'origine) ?-{2,}[ \t]*$/im,
  /^[ \t]*(?:From|Da|Von|De):[ \t].{1,200}\n[ \t]*(?:Sent|Inviato|Gesendet|Envoyé|Date|Data):[ \t]/m,
  /^_{20,}[ \t]*$/m,
];

/**
 * A message without the history quoted under it. A reply carries every
 * earlier message again; the thread already has them, and a model reading
 * the same text five times reads it worse.
 */
export function gmailOwnText(text: string): string {
  let cut = text.replace(/\r\n?/g, '\n');
  for (const mark of QUOTED) {
    const at = cut.search(mark);
    // Never down to nothing: a message that begins with such a line keeps its text.
    if (at > 0 && cut.slice(0, at).trim()) cut = cut.slice(0, at);
  }
  // Lines quoted with ">" at the very end are history too.
  const lines = cut.split('\n');
  while (lines.length > 1 && /^\s*(?:>.*)?$/.test(lines.at(-1)!)) lines.pop();
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** A thread from what the page answered, or the reason it cannot be trusted. */
export function gmailThread(raw: GmailRawThread, row?: Pick<GmailRow, 'draft' | 'subject'>): MailThread | { failed: string } {
  if (raw.failed) return { failed: raw.failed };
  if (!THREAD_ID.test(raw.id)) return { failed: 'no thread id' };
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) return { failed: 'no messages' };
  const messages: MailMessage[] = [];
  for (const message of raw.messages) {
    const from = gmailPeople(String(message.from ?? ''))[0];
    if (!from) return { failed: 'a message with no sender' };
    if (typeof message.at !== 'number' || !Number.isFinite(message.at) || message.at < Date.UTC(2004, 3, 1)) return { failed: 'a message with no date' };
    messages.push({
      from,
      to: gmailPeople(String(message.to ?? '')),
      cc: gmailPeople(String(message.cc ?? '')),
      at: message.at,
      text: gmailOwnText(String(message.text ?? '')),
    });
  }
  // Gmail prints them oldest first. If that is ever not so, order is not guessed at.
  for (let at = 1; at < messages.length; at++) {
    if (messages[at]!.at < messages[at - 1]!.at - 60_000) return { failed: 'messages out of order' };
  }
  return { id: raw.id, subject: (raw.subject || row?.subject || '').trim(), messages, ...(row?.draft ? { draft: true } : {}) };
}

/**
 * Threads in full, asked for a few at a time: each one is a page Gmail has
 * to make, and one answer has to come back within the desktop app's patience.
 */
export async function gmailThreads(
  page: GmailPage,
  rows: Pick<GmailRow, 'id' | 'draft' | 'subject'>[],
  options: { batch?: number; each?: (done: number, of: number) => void } = {},
): Promise<{ threads: MailThread[]; failed: Record<string, number> }> {
  const threads: MailThread[] = [];
  const failed: Record<string, number> = {};
  const batch = Math.max(1, options.batch ?? 6);
  for (let at = 0; at < rows.length; at += batch) {
    const asked = rows.slice(at, at + batch);
    let answered: GmailRawThread[];
    try {
      answered = await page.run<GmailRawThread[]>('threads', { ids: asked.map((row) => row.id) });
    } catch {
      // One bad batch is not the end of the reading: its threads are counted as not read.
      answered = asked.map((row) => ({ id: row.id, failed: 'the page did not answer', subject: '', messages: [] }));
    }
    for (const row of asked) {
      const raw = Array.isArray(answered) ? answered.find((entry) => entry && entry.id === row.id) : undefined;
      const thread = raw ? gmailThread(raw, row) : { failed: 'not in the answer' };
      if ('failed' in thread) failed[thread.failed] = (failed[thread.failed] ?? 0) + 1;
      else threads.push(thread);
    }
    options.each?.(Math.min(at + batch, rows.length), rows.length);
  }
  return { threads, failed };
}
