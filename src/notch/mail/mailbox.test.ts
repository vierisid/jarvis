import { describe, expect, test } from 'bun:test';
import { browserMailbox } from './mailbox.ts';
import type { GooglePage } from './page.ts';
import { MailSignedOut, MailTabTurn } from './tab.ts';

const T1 = '19a1b2c3d4e5f601';
const NOW = Date.UTC(2026, 10, 14, 9, 0);
const row = (id: string, last = 'leo@lumen.example') => ({ id, people: [{ name: 'Sam Rossi', address: 'sam@northwind.example' }, { name: 'Leo', address: last }], count: 2, draft: false, subject: 'Deck' });
const printed = (id: string, from = 'Leo Bianchi <leo@lumen.example>', at = NOW) => ({ id, subject: 'Deck', messages: [{ from, to: 'Sam Rossi <sam@northwind.example>', cc: '', at, text: 'Does Thursday work?', files: [] }] });

/** A tab that is somewhere, and answers the page scripts the mailbox runs. */
function tab(options: { up?: boolean; signedOut?: boolean; lists?: Record<string, unknown[]>; reply?: (args: Record<string, unknown>) => unknown; open?: boolean; threads?: (ids: string[]) => unknown[] } = {}) {
  const calls: { name: string; args?: unknown }[] = [];
  let up = options.up ?? false;
  let place = '';
  const page: Required<GooglePage> = {
    go: async (site, path) => { calls.push({ name: `go ${site}`, args: path }); if (options.signedOut) throw new MailSignedOut(); up = site === 'mail'; },
    run: async <T>(name: string, args?: unknown) => {
      calls.push({ name, args });
      if (options.signedOut) throw new MailSignedOut();
      if (name === 'where') return { up } as T;
      if (!up) throw new Error('mail tab: not on a site it reads');
      if (name === 'owner') return { address: 'sam@northwind.example' } as T;
      if (name === 'go') { place = decodeURIComponent((args as { place: string }).place); return { there: false } as T; }
      if (name === 'list') {
        const query = place.replace(/^#search\//, '').replace(/\/p\d+$/, '');
        const page1 = !/\/p\d+$/.test(place);
        return { there: true, rows: page1 ? (options.lists?.[query] ?? []) : [] } as T;
      }
      if (name === 'threads') return (options.threads ?? ((ids: string[]) => ids.map((id) => printed(id))))((args as { ids: string[] }).ids) as T;
      if (name === 'thread-open') return { open: options.open ?? true } as T;
      if (name === 'reply') return (options.reply?.(args as Record<string, unknown>) ?? { ok: true }) as T;
      throw new Error(`no such script: ${name}`);
    },
  };
  return { page, calls, names: () => calls.map((call) => call.name), away: () => { up = false; } };
}

describe('reading the mailbox through the tab', () => {
  test('brings Gmail up when the tab is elsewhere, and not again when it is there', async () => {
    const { page, names } = tab();
    const box = browserMailbox(page, new MailTabTurn());
    const reader = await box.reader();
    expect(reader).not.toBeNull();
    expect(names()).toEqual(['where', 'go mail']);
    expect(await reader!.owner()).toBe('sam@northwind.example');
    expect(names().slice(2)).toEqual(['where', 'owner']);
  });

  // Not signed in: this way to the mailbox is not here, and the caller goes on to say so.
  test('a browser that is not signed in gives no reader', async () => {
    const { page } = tab({ signedOut: true });
    expect(await browserMailbox(page, new MailTabTurn()).reader()).toBeNull();
  });

  test('lists the month without advertising, social notices and mailing lists, and mailing lists the owner wrote in as such', async () => {
    const { page, calls } = tab({ lists: {
      'newer_than:30d -category:promotions -category:social -category:forums': [row(T1)],
      'newer_than:30d category:forums from:me': [row(T1), row('19a1b2c3d4e5f602')],
    } });
    const reader = (await browserMailbox(page, new MailTabTurn()).reader())!;
    const rows = await reader.list(30);
    expect(rows.map((entry) => [entry.id, entry.filed])).toEqual([[T1, undefined], ['19a1b2c3d4e5f602', 'forums']]);
    // A search that names chats shows no mail at all in Gmail: neither search names them.
    expect(calls.filter((call) => call.name === 'go').every((call) => !decodeURIComponent((call.args as { place: string }).place).includes('chat'))).toBe(true);
    expect(await reader.list(2)).toEqual([]);
  });

  test('reads threads in full, and brings Gmail back up when something else left the tab elsewhere', async () => {
    const { page, names, away } = tab({ up: true });
    const reader = (await browserMailbox(page, new MailTabTurn()).reader())!;
    away();
    const threads = await reader.read([row(T1)]);
    expect(threads.map((thread) => [thread.id, thread.messages.length])).toEqual([[T1, 1]]);
    expect(names().slice(-3)).toEqual(['where', 'go mail', 'threads']);
  });
});

describe('one reply through the tab', () => {
  const plan = { thread: T1, to: ['leo@lumen.example'], cc: ['anna@lumen.example'], text: 'Hi Leo,\nThursday works.\nSam' };

  test('opens the thread at its own address, afresh, and writes, with who it goes to handed to the page every time', async () => {
    const { page, calls } = tab({ up: true });
    const box = browserMailbox(page, new MailTabTurn(), { now: () => NOW });
    const steps = await box.reply(plan, async (reply) => [await reply.write(), await reply.send()]);
    expect(steps).toEqual([{ ok: true }, { ok: true }]);
    expect(calls[0]).toEqual({ name: 'go mail', args: `/mail/u/0/?zx=${NOW.toString(36)}#all/${T1}` });
    expect(calls[1]).toEqual({ name: 'thread-open', args: { id: T1 } });
    expect(calls[2]).toEqual({ name: 'reply', args: { do: 'write', thread: T1, to: plan.to, cc: plan.cc, text: plan.text } });
    expect(calls[3]).toEqual({ name: 'reply', args: { do: 'send', thread: T1, to: plan.to, cc: plan.cc, text: plan.text } });
  });

  test('a step the page refuses is a no with its reason, and a thread that did not open is not written in', async () => {
    const refused = tab({ up: true, reply: () => ({ ok: false, why: 'the reply does not go to exactly the expected people' }) });
    expect(await browserMailbox(refused.page, new MailTabTurn()).reply(plan, (reply) => reply.write())).toEqual({ ok: false, why: 'the reply does not go to exactly the expected people' });
    const shut = tab({ up: true, open: false });
    expect(await browserMailbox(shut.page, new MailTabTurn()).reply(plan, (reply) => reply.write())).toEqual({ ok: false, why: 'the thread did not open' });
    expect(shut.names()).not.toContain('reply');
  });

  test('a step during which the page went away is a step that did not happen, with a reason and no address in it', async () => {
    const { page } = tab({ up: true, reply: () => { throw new Error('Execution context was destroyed at https://mail.google.com/mail/u/0/#inbox/abc'); } });
    const step = await browserMailbox(page, new MailTabTurn()).reply(plan, (reply) => reply.write());
    expect(step).toEqual({ ok: false, why: 'Execution context was destroyed at (an address)' });
  });

  // Nothing may navigate the tab away between the draft being written and it being sent or thrown away.
  test('a reply has the tab to itself from its first step to its last', async () => {
    const { page, names } = tab({ up: true });
    const turn = new MailTabTurn();
    const box = browserMailbox(page, turn);
    const reader = (await box.reader())!;
    let release!: () => void;
    const fuse = new Promise<void>((resolve) => { release = resolve; });
    const replying = box.reply(plan, async (reply) => { await reply.write(); await fuse; return reply.send(); });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const looking = reader.read([row(T1)]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(names().filter((name) => name === 'threads')).toEqual([]);
    release();
    await replying;
    await looking;
    const order = names();
    expect(order.lastIndexOf('reply')).toBeLessThan(order.indexOf('threads'));
  });

  test('after a send, says whether the mailbox shows it as the last word, to the minute', async () => {
    const mine = tab({ up: true, threads: (ids) => ids.map((id) => printed(id, 'Sam Rossi <sam@northwind.example>', NOW)) });
    const sent = await browserMailbox(mine.page, new MailTabTurn()).reply(plan, (reply) => reply.sent(NOW + 40_000));
    expect(sent).toBe(true);
    const theirs = tab({ up: true });
    expect(await browserMailbox(theirs.page, new MailTabTurn()).reply(plan, (reply) => reply.sent(NOW))).toBe(false);
    const gone = tab({ up: true, threads: () => [] });
    expect(await browserMailbox(gone.page, new MailTabTurn()).reply(plan, (reply) => reply.sent(NOW))).toBeNull();
  });
});
