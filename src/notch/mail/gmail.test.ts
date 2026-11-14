import { describe, expect, test } from 'bun:test';
import { gmailOwnText, gmailPeople, gmailSearch, gmailSearchPlace, gmailThread, gmailThreads, type GmailListed, type GmailPage, type GmailRawThread, type GmailRow } from './gmail.ts';
import { mailPerson } from './thread.ts';

const id = (n: number) => n.toString(16).padStart(16, '0');
const row = (n: number, extra: Partial<GmailRow> = {}): GmailRow =>
  ({ id: id(n), people: [{ name: 'Leo Bianchi', address: 'leo@lumen.example' }], count: 1, draft: false, subject: `Subject ${n}`, ...extra });

/** A Gmail whose search has `total` threads, `size` to a page, and shows the last page again past the end. */
function gmail(total: number, size = 50) {
  const asked: { name: string; args: unknown }[] = [];
  let place = '';
  const page: GmailPage = {
    run: async <T,>(name: string, args?: unknown) => {
      asked.push({ name, args });
      if (name === 'go') { place = (args as { place: string }).place; return { there: false } as T; }
      const pages = Math.max(1, Math.ceil(total / size));
      const wanted = Number(/\/p(\d+)$/.exec(place)?.[1] ?? 1);
      const at = Math.min(wanted, pages);
      const rows = Array.from({ length: Math.max(0, Math.min(size, total - (at - 1) * size)) }, (_, n) => row((at - 1) * size + n + 1));
      return { there: true, rows } as T;
    },
  };
  return { page, asked };
}

describe('the list a search gives', () => {
  test('is read page by page to the end', async () => {
    const { page, asked } = gmail(120);
    const rows = await gmailSearch(page, 'newer_than:30d');
    expect(rows.length).toBe(120);
    expect(asked.filter((entry) => entry.name === 'go').map((entry) => (entry.args as { place: string }).place))
      .toEqual(['#search/newer_than%3A30d', '#search/newer_than%3A30d/p2', '#search/newer_than%3A30d/p3']);
  });

  test('stops when Gmail shows the last page again, and at an empty list', async () => {
    const exact = gmail(100);
    expect((await gmailSearch(exact.page, 'q')).length).toBe(100);
    expect(exact.asked.filter((entry) => entry.name === 'go').length).toBe(3);
    expect(await gmailSearch(gmail(0).page, 'q')).toEqual([]);
  });

  test('never goes past the pages it was allowed', async () => {
    const { page, asked } = gmail(10_000);
    expect((await gmailSearch(page, 'q', { pages: 2 })).length).toBe(100);
    expect(asked.filter((entry) => entry.name === 'go').length).toBe(2);
  });

  test('tells the list script which rows it has already seen, so that old rows are not read twice', async () => {
    const { page, asked } = gmail(60);
    await gmailSearch(page, 'q');
    expect(asked.filter((entry) => entry.name === 'list').map((entry) => (entry.args as { not: string }).not)).toEqual(['', id(1)]);
  });

  test('a first page that never shows is a failure, and rows that are not rows are left out', async () => {
    const never: GmailPage = { run: async <T,>(name: string) => (name === 'go' ? {} : { there: false, rows: [] }) as T };
    await expect(gmailSearch(never, 'q')).rejects.toThrow('did not show');
    const odd: GmailPage = { run: async <T,>(name: string) => (name === 'go' ? {} : { there: true, rows: [row(1), { id: 'not-an-id', people: [] }, null, row(2, { people: [{ name: 'x', address: 'no-at-sign' }] })] } as unknown as GmailListed) as T };
    const rows = await gmailSearch(odd, 'q');
    expect(rows.map((entry) => entry.id)).toEqual([id(1), id(2)]);
    expect(rows[1]!.people).toEqual([]);
  });

  test('a search is put in the address the way Gmail reads it', () => {
    expect(gmailSearchPlace('newer_than:30d -in:chats')).toBe('#search/newer_than%3A30d%20-in%3Achats');
    expect(gmailSearchPlace('q', 3)).toBe('#search/q/p3');
  });
});

describe('the people in a line', () => {
  test('names, quoted names with commas, and bare addresses', () => {
    expect(gmailPeople('Leo Bianchi <Leo@Lumen.example>, "Conti, Anna" <anna@lumen.example>, nora@lumen.example; <otto@lumen.example>'))
      .toEqual([mailPerson('Leo Bianchi', 'leo@lumen.example'), mailPerson('Conti, Anna', 'anna@lumen.example'), mailPerson('', 'nora@lumen.example'), mailPerson('', 'otto@lumen.example')]);
    expect(gmailPeople('')).toEqual([]);
    expect(gmailPeople('undisclosed-recipients:;')).toEqual([]);
    // The same person twice is one person.
    expect(gmailPeople('Leo <leo@lumen.example>, leo@lumen.example').length).toBe(1);
  });
});

describe('a message without its quoted history', () => {
  test('is cut where the history begins, in the ways mail programs write it', () => {
    for (const mark of [
      'On Tue, Nov 10, 2026 at 3:04 PM Leo Bianchi <leo@lumen.example> wrote:',
      'On Tue, Nov 10, 2026 at 3:04 PM Leo Bianchi\n<leo@lumen.example> wrote:',
      'Il giorno mar 10 nov 2026 alle ore 15:04 Leo Bianchi <leo@lumen.example> ha scritto:',
      '-----Original Message-----',
      'From: Leo Bianchi\nSent: Tuesday, November 10, 2026 3:04 PM',
      'Da: Leo Bianchi\nInviato: martedì 10 novembre 2026 15:04',
    ]) {
      expect(gmailOwnText(`Yes, Thursday works.\n\nSam\n\n${mark}\n> Does Thursday work?\n> Leo`)).toBe('Yes, Thursday works.\n\nSam');
    }
  });

  test('keeps what is the message itself', () => {
    expect(gmailOwnText('Hi,\n\nOn the price: fine.\n\n\n\nSam')).toBe('Hi,\n\nOn the price: fine.\n\nSam');
    expect(gmailOwnText('> quoted first\nThen my answer under it.')).toBe('> quoted first\nThen my answer under it.');
    expect(gmailOwnText('See what he says below.\n\n---------- Forwarded message ---------\nFrom: Leo\nThe forwarded text.')).toContain('The forwarded text.');
    // A message that is nothing but such a line is not cut to nothing.
    expect(gmailOwnText('On Tue, Nov 10, 2026 at 3:04 PM Leo wrote:\n> text')).toContain('wrote:');
  });

  test('drops lines quoted with > at the very end', () => {
    expect(gmailOwnText('Fine by me.\n\n> Does Thursday work?\n>\n> Leo\n')).toBe('Fine by me.');
  });
});

describe('a thread from what the page answered', () => {
  const at = Date.UTC(2026, 10, 10, 15, 4);
  const raw = (extra: Partial<GmailRawThread> = {}): GmailRawThread => ({
    id: id(77), subject: 'Deck for Thursday?',
    messages: [
      { from: 'Leo Bianchi <leo@lumen.example>', to: 'Sam Rossi <sam@northwind.example>', cc: '', at, text: 'Does Thursday work?' },
      { from: 'Sam Rossi <sam@northwind.example>', to: 'Leo Bianchi <leo@lumen.example>', cc: 'Anna <anna@lumen.example>', at: at + 3_600_000, text: 'Yes.\n\nOn Tue, Nov 10, 2026 at 3:04 PM Leo Bianchi <leo@lumen.example> wrote:\n> Does Thursday work?' },
    ],
    ...extra,
  });

  test('is its messages, oldest first, each without its quoted history', () => {
    expect(gmailThread(raw(), { draft: true, subject: 'ignored' })).toEqual({
      id: id(77), subject: 'Deck for Thursday?', draft: true,
      messages: [
        { from: mailPerson('Leo Bianchi', 'leo@lumen.example'), to: [mailPerson('Sam Rossi', 'sam@northwind.example')], cc: [], at, text: 'Does Thursday work?' },
        { from: mailPerson('Sam Rossi', 'sam@northwind.example'), to: [mailPerson('Leo Bianchi', 'leo@lumen.example')], cc: [mailPerson('Anna', 'anna@lumen.example')], at: at + 3_600_000, text: 'Yes.' },
      ],
    });
  });

  // What could not be read is left out and counted, never guessed at.
  test('is refused when a sender or a date could not be read, or the order is not the order of time', () => {
    const first = raw().messages[0]!;
    expect(gmailThread(raw({ failed: 'status 404' }))).toEqual({ failed: 'status 404' });
    expect(gmailThread(raw({ messages: [] }))).toEqual({ failed: 'no messages' });
    expect(gmailThread(raw({ messages: [{ ...first, from: 'Somebody' }] }))).toEqual({ failed: 'a message with no sender' });
    expect(gmailThread(raw({ messages: [{ ...first, at: null }] }))).toEqual({ failed: 'a message with no date' });
    expect(gmailThread(raw({ messages: [{ ...first, at: 12 }] }))).toEqual({ failed: 'a message with no date' });
    expect(gmailThread(raw({ messages: [...raw().messages].reverse() }))).toEqual({ failed: 'messages out of order' });
    expect(gmailThread(raw({ id: 'thread-1' }))).toEqual({ failed: 'no thread id' });
  });

  test('are asked for a few at a time, and one bad batch does not end the reading', async () => {
    const asked: string[][] = [];
    const page: GmailPage = {
      run: async <T,>(_name: string, args?: unknown) => {
        const ids = (args as { ids: string[] }).ids;
        asked.push(ids);
        if (ids.includes(id(3))) throw new Error('the page navigated');
        return ids.filter((entry) => entry !== id(5)).map((entry) => raw({ id: entry, ...(entry === id(6) ? { failed: 'status 500' } : {}) })) as T;
      },
    };
    const steps: number[] = [];
    const read = await gmailThreads(page, [1, 2, 3, 4, 5, 6, 7].map((n) => row(n)), { batch: 2, each: (done) => steps.push(done), pauses: [] });
    expect(asked.map((ids) => ids.length)).toEqual([2, 2, 2, 1]);
    expect(read.threads.map((thread) => thread.id)).toEqual([id(1), id(2), id(7)]);
    expect(read.failed).toEqual({ 'the page did not answer': 2, 'not in the answer': 1, 'status 500': 1 });
    expect(steps).toEqual([2, 4, 6, 7]);
  });

  // Gmail asked too fast answers with a page that has no mail in it. That says nothing about the thread.
  test('what Gmail did not give because it was asked too fast is asked for again after a pause', async () => {
    let calls = 0;
    const slept: number[] = [];
    const kept: string[] = [];
    const page: GmailPage = {
      run: async <T,>(_name: string, args?: unknown) => {
        calls++;
        const ids = (args as { ids: string[] }).ids;
        // Throttled until the second pause has passed; thread 4 is truly unreadable.
        return ids.map((entry) => (entry === id(4) ? raw({ id: entry, messages: [{ ...raw().messages[0]!, at: null }] })
          : slept.length < 2 && entry !== id(1) ? { id: entry, failed: 'no messages in the print page', subject: '', messages: [] }
          : raw({ id: entry }))) as T;
      },
    };
    const read = await gmailThreads(page, [1, 2, 3, 4].map((n) => row(n)), {
      batch: 4, pauses: [10, 20, 30], sleep: async (ms) => { slept.push(ms); }, got: (threads) => { kept.push(...threads.map((thread) => thread.id)); },
    });
    expect(slept).toEqual([10, 20]);
    expect(calls).toBe(3);
    expect(read.threads.map((thread) => thread.id).sort()).toEqual([id(1), id(2), id(3)]);
    expect(kept.sort()).toEqual([id(1), id(2), id(3)]);
    // A thread whose date cannot be read is not asked for again: waiting will not help it.
    expect(read.failed).toEqual({ 'a message with no date': 1 });
  });

  test('gives up after the last pause and says how many it could not read', async () => {
    const slept: number[] = [];
    const page: GmailPage = { run: async <T,>(_name: string, args?: unknown) => (args as { ids: string[] }).ids.map((entry) => ({ id: entry, failed: 'no messages in the print page', subject: '', messages: [] })) as T };
    const read = await gmailThreads(page, [1, 2].map((n) => row(n)), { pauses: [1, 2], sleep: async (ms) => { slept.push(ms); } });
    expect(slept).toEqual([1, 2]);
    expect(read).toEqual({ threads: [], failed: { 'no messages in the print page': 2 } });
  });
});
