import { describe, expect, test } from 'bun:test';
import { MAIL_SENT_ASKS, MAIL_WENT_SLACK_MS, MAIL_WHY_UNSURE, browserMailbox } from './mailbox.ts';
import type { GooglePage } from './page.ts';
import { MailSignedOut, MailTabTurn } from './tab.ts';

const T1 = '19a1b2c3d4e5f601';
const NOW = Date.UTC(2026, 10, 14, 9, 0);
const row = (id: string, last = 'leo@lumen.example') => ({ id, people: [{ name: 'Sam Rossi', address: 'sam@northwind.example' }, { name: 'Leo', address: last }], count: 2, draft: false, subject: 'Deck' });
const printed = (id: string, from = 'Leo Bianchi <leo@lumen.example>', at = NOW, text = 'Does Thursday work?') => ({ id, subject: 'Deck', messages: [{ from, to: 'Sam Rossi <sam@northwind.example>', cc: '', at, text, files: [] }] });

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

  test('a draft that is there with the same words is said to be so, by that word from the page and no other', async () => {
    const DRAFT = 'a reply is already being written in that thread';
    for (const [said, step] of [
      [{ ok: false, why: DRAFT, same: true }, { ok: false, why: DRAFT, same: true }],
      [{ ok: false, why: DRAFT, same: false }, { ok: false, why: DRAFT }],
      [{ ok: false, why: DRAFT, same: 'yes' }, { ok: false, why: DRAFT }],
      // The word means something only beside that refusal.
      [{ ok: false, why: 'the reply did not open', same: true }, { ok: false, why: 'the reply did not open' }],
      [{ ok: true, same: true }, { ok: true }],
    ] as const) {
      const { page } = tab({ up: true, reply: () => said });
      expect(await browserMailbox(page, new MailTabTurn(), { now: () => NOW }).reply(plan, (reply) => reply.write())).toEqual(step);
    }
  });

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

  // Whoever asked must never send a second time a mail that may be on its way.
  test('a send that did not go says whether Send was pressed, and one that gave no answer may have been', async () => {
    const send = (reply: (args: Record<string, unknown>) => unknown) => browserMailbox(tab({ up: true, reply }).page, new MailTabTurn()).reply(plan, (session) => session.send());
    expect(await send(() => ({ ok: false, why: 'no way to send was found', pressed: false }))).toEqual({ ok: false, why: 'no way to send was found', pressed: false });
    expect(await send(() => ({ ok: false, why: 'Gmail did not say it was sent', pressed: true }))).toEqual({ ok: false, why: 'Gmail did not say it was sent', pressed: true });
    expect(await send(() => { throw new Error('the page went away'); })).toEqual({ ok: false, why: 'the page went away', pressed: true });
    expect(await send(() => ({}))).toEqual({ ok: false, why: 'the page did not answer', pressed: true });
    expect(await send(() => ({ ok: true, pressed: true }))).toEqual({ ok: true });
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

  test('after a send, says whether the mailbox shows it as the last word, to the minute, and by how it begins', async () => {
    const me = 'Sam Rossi <sam@northwind.example>';
    const mine = tab({ up: true, threads: (ids) => ids.map((id) => printed(id, me, NOW, 'Hi Leo,\n\nThursday  works.\nSam\n\nOn Monday Leo wrote: Does Thursday work?')) });
    const sent = await browserMailbox(mine.page, new MailTabTurn()).reply(plan, (reply) => reply.sent(NOW + 40_000));
    expect(sent).toBe(true);
    const theirs = tab({ up: true });
    expect(await browserMailbox(theirs.page, new MailTabTurn()).reply(plan, (reply) => reply.sent(NOW))).toBe(false);
    const gone = tab({ up: true, threads: () => [] });
    expect(await browserMailbox(gone.page, new MailTabTurn()).reply(plan, (reply) => reply.sent(NOW))).toBeNull();
    // The owner answered by hand in the same minute: a mail of theirs, and not the one that was sent.
    // "An owner mail in the last two minutes" was taken for ours.
    const byHand = tab({ up: true, threads: (ids) => ids.map((id) => printed(id, me, NOW, 'Leo, call me instead.')) });
    expect(await browserMailbox(byHand.page, new MailTabTurn()).reply(plan, (reply) => reply.sent(NOW))).toBe(false);
  });

  // Before anything is sent a second time, it is asked whether the first one went.
  test('a mail that may have gone is looked for: anywhere in its thread, since then, by how it begins', async () => {
    const me = 'Sam Rossi <sam@northwind.example>';
    const ask = { to: 'leo@lumen.example', thread: T1, subject: 'Deck', text: plan.text };
    // It went, and Leo has answered since: it is no longer the last word, and it is still there.
    const answered = tab({ up: true, threads: (ids) => ids.map((id) => ({ id, subject: 'Deck', messages: [printed(id, me, NOW, plan.text).messages[0]!, printed(id, undefined, NOW + 60_000, 'Fine.').messages[0]!] })) });
    expect(await browserMailbox(answered.page, new MailTabTurn()).went(ask, NOW)).toBe(true);
    expect(await browserMailbox(tab({ up: true }).page, new MailTabTurn()).went(ask, NOW)).toBe(false);
    expect(await browserMailbox(tab({ up: true, threads: () => [] }).page, new MailTabTurn()).went(ask, NOW)).toBeNull();
    // A day-old mail of the owner's with the same words is not this one.
    const older = tab({ up: true, threads: (ids) => ids.map((id) => printed(id, me, NOW - 20 * 3_600_000, plan.text)) });
    expect(await browserMailbox(older.page, new MailTabTurn()).went(ask, NOW)).toBe(false);
    // One that reads as hours older is: a time read in another zone than the account's must not
    // make a mail that went look like one that did not. Missing it sends it twice.
    const zoned = tab({ up: true, threads: (ids) => ids.map((id) => printed(id, me, NOW - 9 * 3_600_000, plan.text)) });
    expect(await browserMailbox(zoned.page, new MailTabTurn()).went(ask, NOW)).toBe(true);
    expect(MAIL_WENT_SLACK_MS).toBeGreaterThan(14 * 3_600_000);
    // Right after the press it is still to the minute.
    expect(await browserMailbox(zoned.page, new MailTabTurn()).reply(plan, (reply) => reply.sent(NOW))).toBe(false);
  });
});

// A chase's first mail to someone there is no thread with (pass 11): one new
// mail, to one person, sent only when the writing window holds exactly it.
describe('writing a new mail to one person', () => {
  const plan = { to: 'leo@lumen.example', subject: 'The contract', text: 'Hi Leo,\n\nA quick nudge on this: could you get back to me by Friday?\n\nThanks,\nSam' };
  /** A tab whose writing window says what it holds, and whose Send answers as told. */
  function writing(options: {
    window?: Record<string, unknown>;
    sent?: Record<string, unknown> | Error;
    /**
     * What the Sent folder shows each time it is asked: the mail, nothing of it, an old one, one
     * with the same subject and other words, or it cannot be read. The last answer stands.
     */
    folder?: ('shows' | 'empty' | 'old' | 'other' | 'unreadable' | 'half')[];
  } = {}) {
    const calls: { name: string; args?: unknown }[] = [];
    const folder = [...(options.folder ?? ['shows'])];
    let shown = 'shows';
    const page: Required<GooglePage> = {
      go: async (site, path) => { calls.push({ name: `go ${site}`, args: path }); },
      run: async <T>(name: string, args?: unknown) => {
        calls.push({ name, args });
        if (name === 'where') return { up: true } as T;
        if (name === 'shape-compose') return (options.window ?? { subject: 12, body: 40, send: true }) as T;
        if (name === 'compose-send') {
          if (options.sent instanceof Error) throw options.sent;
          return (options.sent ?? { sent: true, pressed: true, why: '' }) as T;
        }
        if (name === 'owner') return { address: 'sam@northwind.example' } as T;
        if (name === 'go') return { there: false } as T;
        if (name === 'list') {
          shown = folder.length > 1 ? folder.shift()! : folder[0]!;
          if (shown === 'unreadable') throw new Error('Gmail did not answer');
          // Another mail to the same person is in Sent too: only the one with this subject counts.
          // "half": two threads with this subject, and only one of them can be read.
          return { there: true, rows: [{ ...row('19a1b2c3d4e5f6ff'), subject: 'Lunch' }, ...(shown === 'empty' ? [] : [{ ...row(T1), subject: 'The  contract' }]), ...(shown === 'half' ? [{ ...row('19a1b2c3d4e5f6aa'), subject: 'The contract' }] : [])] } as T;
        }
        if (name === 'threads') return (args as { ids: string[] }).ids.filter((id) => shown !== 'half' || id === T1).map((id) => printed(id, 'Sam Rossi <sam@northwind.example>', shown === 'old' ? NOW - 20 * 3_600_000 : NOW, shown === 'other' || shown === 'half' ? 'Leo, about the contract: call me.' : plan.text)) as T;
        throw new Error(`no such script: ${name}`);
      },
    };
    return { page, calls, names: () => calls.map((call) => call.name), box: () => browserMailbox(page, new MailTabTurn(), { now: () => NOW + 30_000, sleep: async () => {} }) };
  }
  const silent = { sent: false, pressed: true, why: 'Gmail did not say it was sent' };

  test('the writing window is opened with the mail in it, checked, and Send is pressed once', async () => {
    const { box, calls, names } = writing();
    expect(await box().write(plan)).toEqual({ ok: true });
    expect(names()).toEqual(['go mail', 'shape-compose', 'compose-send', 'go mail']);
    // Who it goes to, what it is called and what it says travel in the address that opens the window.
    const opened = String(calls[0]!.args);
    expect(opened.startsWith('/mail/u/0/?view=cm&fs=1&tf=1&to=leo%40lumen.example&su=The%20contract&body=Hi%20Leo')).toBe(true);
    // Send is told exactly which mail it may send, and to whom.
    expect(calls[2]!.args).toEqual({ subject: 'The contract', to: 'leo@lumen.example' });
    // The tab is left on the list again for whoever reads next.
    expect(calls[3]!.args).toBe('/mail/u/0/#inbox');
  });

  // The hardening audit, 17 November 2026, kept: a mail that went is not called "not confirmed"
  // and then sent again. Gmail saying so after the press is enough, whatever the folder shows yet.
  test('Gmail says it went: sent, whatever the Sent folder shows yet, and the folder is not asked', async () => {
    for (const folder of [['empty'], ['unreadable']] as const) {
      const { box, names } = writing({ folder: [...folder] });
      expect(await box().write(plan)).toEqual({ ok: true });
      expect(names()).not.toContain('list');
    }
  });

  test('Gmail says nothing: the Sent folder is asked, and a mail it shows is sent, and not sent again', async () => {
    const { box, calls, names } = writing({ sent: silent });
    expect(await box().write(plan)).toEqual({ ok: true });
    expect(names()).toEqual(['go mail', 'shape-compose', 'compose-send', 'go mail', 'owner', 'go', 'list', 'threads', 'go mail']);
    // The Sent folder is asked for what went to that person, and only the thread with this subject is read.
    expect(decodeURIComponent((calls[5]!.args as { place: string }).place)).toContain('in:sent to:leo@lumen.example newer_than:');
    expect(calls[7]!.args).toEqual({ ids: [T1] });
  });

  test('Gmail says nothing and the Sent folder shows it a moment later: sent', async () => {
    const { box, names } = writing({ sent: silent, folder: ['empty', 'shows'] });
    expect(await box().write(plan)).toEqual({ ok: true });
    expect(names().filter((name) => name === 'list')).toHaveLength(2);
  });

  test('Gmail says nothing and the Sent folder does not show it: it may have gone, and when to look from is kept', async () => {
    for (const folder of [['empty'], ['old'], ['other'], ['unreadable']] as const) {
      const { box } = writing({ sent: silent, folder: [...folder] });
      expect(await box().write(plan)).toEqual({ ok: false, why: MAIL_WHY_UNSURE, pressed: true, since: NOW + 30_000 });
    }
    // Asked more than once: the folder takes a moment to show a mail.
    const asked = writing({ sent: silent, folder: ['empty'] });
    await asked.box().write(plan);
    expect(asked.names().filter((name) => name === 'list')).toHaveLength(MAIL_SENT_ASKS);
    expect(MAIL_WHY_UNSURE.length).toBeLessThanOrEqual(80);
  });

  test('a mail of its own that may have gone is looked for in the Sent folder', async () => {
    const ask = { to: 'Leo@Lumen.example', thread: null, subject: 'The contract', text: plan.text };
    expect(await writing().box().went(ask, NOW)).toBe(true);
    expect(await writing({ folder: ['other'] }).box().went(ask, NOW)).toBe(false);
    expect(await writing({ folder: ['empty'] }).box().went(ask, NOW)).toBe(false);
    expect(await writing({ folder: ['unreadable'] }).box().went(ask, NOW)).toBeNull();
    // One of the threads that could hold it was not read: "not there" is the answer that sends
    // a mail again, and it is not given on half a reading.
    expect(await writing({ folder: ['half'] }).box().went(ask, NOW)).toBeNull();
  });

  test('a writing window that does not hold the mail is not sent from', async () => {
    for (const window of [{ subject: 3, body: 40, send: true }, { subject: 12, body: 0, send: true }, { subject: 12, body: 40, send: false }, { subject: null, body: null, send: false }]) {
      const { page, names } = writing({ window });
      expect(await browserMailbox(page, new MailTabTurn()).write(plan)).toEqual({ ok: false, why: 'the writing window did not open as expected', pressed: false });
      expect(names()).not.toContain('compose-send');
    }
  });

  test('a send the page refused before pressing anything sent nothing: the reason is given, and the Sent folder is not asked', async () => {
    const refused = writing({ sent: { sent: false, pressed: false, why: 'it does not go to the one expected person' } });
    expect(await refused.box().write(plan)).toEqual({ ok: false, why: 'it does not go to the one expected person', pressed: false });
    expect(refused.names()).not.toContain('list');
  });

  // Only a page that says it did not press is believed. It was the other way round for a new mail.
  test('a page that does not say whether it pressed: the mail may have gone, and the Sent folder says', async () => {
    expect(await writing({ sent: { sent: false, why: '' } }).box().write(plan)).toEqual({ ok: true });
    expect(await writing({ sent: { sent: false, why: '' }, folder: ['empty'] }).box().write(plan)).toEqual({ ok: false, why: MAIL_WHY_UNSURE, pressed: true, since: NOW + 30_000 });
  });

  test('a page that went away while Send was pressed: the mail may have gone, and the Sent folder says', async () => {
    const gone = new Error('the tab left https://mail.google.com/mail/u/0/?view=cm for elsewhere');
    expect(await writing({ sent: gone }).box().write(plan)).toEqual({ ok: true });
    expect(await writing({ sent: gone, folder: ['empty'] }).box().write(plan)).toEqual({ ok: false, why: MAIL_WHY_UNSURE, pressed: true, since: NOW + 30_000 });
  });

  test('a mail to several people the owner named goes to exactly those, and Send is told so', async () => {
    const { box, calls } = writing();
    expect(await box().write({ ...plan, also: ['Anna@Acme.example', 'leo@lumen.example', 'tony@acme.example'] })).toEqual({ ok: true });
    // Each of them once, in the address that opens the window.
    expect(String(calls[0]!.args).startsWith('/mail/u/0/?view=cm&fs=1&tf=1&to=leo%40lumen.example,anna%40acme.example,tony%40acme.example&su=The%20contract')).toBe(true);
    expect(calls[2]!.args).toEqual({ subject: 'The contract', to: ['leo@lumen.example', 'anna@acme.example', 'tony@acme.example'] });
  });

  test('one of several that is not an address, or too many of them, is no mail at all', async () => {
    for (const also of [['Anna'], ['anna@acme.example, tony@acme.example'], ['a@x.example', 'b@x.example', 'c@x.example', 'd@x.example', 'e@x.example', 'f@x.example']]) {
      const { page, names } = writing();
      expect((await browserMailbox(page, new MailTabTurn()).write({ ...plan, also })).ok).toBe(false);
      expect(names()).toEqual([]);
    }
  });

  test('what is not one mail to one person is refused before the tab is touched', async () => {
    for (const bad of [{ ...plan, to: 'leo@lumen.example, anna@lumen.example' }, { ...plan, to: 'Leo' }, { ...plan, subject: ' ' }, { ...plan, text: '' }, { ...plan, text: 'x'.repeat(901) }]) {
      const { page, names } = writing();
      expect((await browserMailbox(page, new MailTabTurn()).write(bad)).ok).toBe(false);
      expect(names()).toEqual([]);
    }
  });
});
