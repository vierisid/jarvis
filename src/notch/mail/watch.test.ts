import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { MailThought } from './proposer.ts';
import { MailStore, mailProposalId } from './store.ts';
import { mailPerson, type MailMessage, type MailPerson, type MailThread } from './thread.ts';
import { MailWatch, mailCandidate, mailSignature, type MailListed, type MailReader } from './watch.ts';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 14, 9, 0);
const me = mailPerson('Sam Rossi', 'sam@northwind.example');
const owner = new Set([me.address]);
const leo = mailPerson('Leo Bianchi', 'leo@lumen.example');
const anna = mailPerson('Anna Conti', 'anna@lumen.example');
const robot = mailPerson('Lumen', 'no-reply@lumen.example');

const message = (from: MailPerson, hoursAgo: number, text = 'Does Thursday at 10 work?', extra: Partial<MailMessage> = {}): MailMessage =>
  ({ from, to: [from === me ? leo : me], cc: [], at: NOW - hoursAgo * HOUR, text, ...extra });
const thread = (id: string, messages: MailMessage[]): MailThread => ({ id, subject: `Subject of ${id}`, messages });
const listed = (item: MailThread, extra: Partial<MailListed> = {}): MailListed => ({
  id: item.id, subject: item.subject, count: item.messages.length, draft: false,
  people: [...new Map(item.messages.map((entry) => [entry.from.address, entry.from])).values()].sort((a, b) =>
    item.messages.findLastIndex((entry) => entry.from.address === a.address) - item.messages.findLastIndex((entry) => entry.from.address === b.address)),
  ...extra,
});

const T1 = '19a1b2c3d4e5f601';
const T2 = '19a1b2c3d4e5f602';

/** A mailbox, a model and a store, with what each was asked. */
function world(threads: MailThread[], options: { answer?: (text: string) => string | Error; rows?: (item: MailThread) => Partial<MailListed>; signedOut?: boolean; calendar?: boolean } = {}) {
  const box = new Map(threads.map((item) => [item.id, item]));
  const store = new MailStore(new Database(':memory:'));
  const asked = { lists: [] as number[], reads: [] as string[][], thinks: [] as string[], calendar: 0, files: [] as string[], changed: 0 };
  let now = NOW;
  const reader: MailReader = {
    owner: async () => me.address,
    list: async (days, pages) => { asked.lists.push(pages ? -pages : days); return [...box.values()].map((item) => listed(item, options.rows?.(item))); },
    read: async (rows) => { asked.reads.push(rows.map((row) => row.id)); return rows.flatMap((row) => { const item = box.get(row.id); return item ? [item] : []; }); },
  };
  const reply = (fields: Record<string, unknown> = {}) => JSON.stringify({ needs_reply: true, why: 'Asked for a time.', reply: 'Hi Leo,\nThursday at 10:00 works.\nSam', missing: '', time: 'Thursday at 10:00', look_for: '', about: 'Leo asks if Thursday at 10 works.', ...fields });
  const watch = new MailWatch({
    reader: async () => (options.signedOut ? null : { reader, through: 'browser' }),
    store,
    think: async (messages): Promise<MailThought> => {
      const text = messages[1]!.content;
      asked.thinks.push(text);
      const answer = options.answer?.(text) ?? reply();
      if (answer instanceof Error) throw answer;
      return { content: answer, model: 'test-model', input: 1000, output: 50, cached: 200 };
    },
    calendar: options.calendar === false ? undefined : async () => { asked.calendar++; return [{ summary: 'Board call', start: '2026-11-19T10:00:00Z', end: '2026-11-19T11:00:00Z' }]; },
    files: async (words) => { asked.files.push(words); return [{ id: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345', name: 'Lumen deck v3', kind: 'Google Slides' }]; },
    changed: () => { asked.changed++; },
    now: () => now,
    zone: 'UTC',
    log: () => {},
  });
  return { watch, store, asked, box, reply, later: (ms: number) => { now += ms; } };
}

describe('what the list alone can rule out', () => {
  test('a thread is read when the one shown last is a person who is not the owner', () => {
    const item = thread(T1, [message(me, 48), message(leo, 24)]);
    expect(mailCandidate(listed(item), owner)).toBe(true);
    expect(mailCandidate(listed(thread(T1, [message(leo, 48), message(me, 24)])), owner)).toBe(false);
    expect(mailCandidate(listed(thread(T1, [message(robot, 24)])), owner)).toBe(false);
    expect(mailCandidate(listed(item, { draft: true }), owner)).toBe(false);
    // Filed away by Gmail: a person only when the owner has been writing with them.
    expect(mailCandidate(listed(thread(T1, [message(leo, 24)]), { filed: 'forums' }), owner)).toBe(false);
    expect(mailCandidate(listed(item, { filed: 'forums' }), owner)).toBe(true);
    expect(mailCandidate(listed(thread(T1, [message(leo, 24)]), { filed: 'updates' }), owner)).toBe(true);
  });

  test('the signature changes when a message is added, when another person writes last, and when a draft appears', () => {
    const item = listed(thread(T1, [message(me, 48), message(leo, 24)]));
    expect(mailSignature(item)).toBe('2|leo@lumen.example|');
    expect(mailSignature({ ...item, count: 3 })).not.toBe(mailSignature(item));
    expect(mailSignature({ ...item, draft: true })).not.toBe(mailSignature(item));
    expect(mailSignature({ ...item, people: [leo, me] })).not.toBe(mailSignature(item));
  });
});

describe('a look at the mailbox', () => {
  test('prepares a reply for a thread where a person is waiting, once', async () => {
    const { watch, store, asked } = world([thread(T1, [message(me, 48, 'Here is the deck.'), message(leo, 24)])]);
    const look = await watch.look('sweep');
    expect(look).toEqual({ through: 'browser', listed: 1, read: 1, asked: 1, prepared: 1, overtaken: 0 });
    expect(asked.lists).toEqual([30]);
    const [row] = store.ready();
    expect(row).toMatchObject({
      id: mailProposalId(T1, NOW - 24 * HOUR), thread: T1, state: 'ready', who: leo, to: [leo], cc: [],
      draft: 'Hi Leo,\nThursday at 10:00 works.\nSam', time: 'Thursday at 10:00', model: 'test-model', tokensIn: 1200, tokensOut: 50,
    });
    expect(asked.changed).toBe(1);
    // The owner's own name, as their mail signs them, and their calendar reach the model.
    expect(asked.thinks[0]).toContain('(this is Sam)');
    expect(asked.thinks[0]).toContain('Board call');
    expect(watch.name()).toBe('Sam');

    // The next looks find the list unchanged: nothing is read, and the model is not asked again.
    expect(await watch.look('recent')).toMatchObject({ read: 0, asked: 0, prepared: 0, overtaken: 0 });
    expect(await watch.look('glance')).toMatchObject({ read: 0, asked: 0, prepared: 0, overtaken: 0 });
    // A glance is the top of the list of the last two days.
    expect(asked.lists).toEqual([30, 2, -1]);
    expect(asked.thinks.length).toBe(1);
    // A full look takes nothing on trust: the reply that waits is checked against its thread.
    expect(await watch.look('sweep')).toMatchObject({ read: 1, asked: 0, overtaken: 0 });
  });

  test('reads only what may matter: not the owner\'s last word, not a machine', async () => {
    const { watch, asked, store } = world([
      thread(T1, [message(leo, 48), message(me, 24)]),
      thread(T2, [message(robot, 24)]),
    ]);
    expect(await watch.look('sweep')).toMatchObject({ listed: 2, read: 0, asked: 0 });
    expect(asked.reads).toEqual([]);
    expect(store.ready()).toEqual([]);
  });

  test('a message the model says needs no reply is not asked about again, and is not on the notch', async () => {
    const { watch, store, asked, reply } = world([thread(T1, [message(leo, 24, 'Thanks, all good!')])], { answer: () => reply({ needs_reply: false, reply: '' }) });
    await watch.look('sweep');
    expect(store.ready()).toEqual([]);
    expect(store.proposal(mailProposalId(T1, NOW - 24 * HOUR))!.state).toBe('silent');
    expect(asked.changed).toBe(0);
    await watch.look('recent');
    expect(asked.thinks.length).toBe(1);
  });

  test('a message that is too new is looked at again when it has waited long enough', async () => {
    const { watch, store, asked, later } = world([thread(T1, [message(leo, 1)])]);
    expect(await watch.look('sweep')).toMatchObject({ read: 1, asked: 0 });
    expect(store.seen(T1)!.dueAt).toBe(NOW + 3 * HOUR);
    later(2 * HOUR);
    expect(await watch.look('recent')).toMatchObject({ read: 0, asked: 0 });
    later(HOUR + 1);
    expect(await watch.look('recent')).toMatchObject({ read: 1, asked: 1, prepared: 1 });
    expect(asked.thinks.length).toBe(1);
    expect(store.seen(T1)!.dueAt).toBeNull();
  });

  test('a reply leaves when the owner answers by hand', async () => {
    const { watch, store, box, asked } = world([thread(T1, [message(leo, 24)])]);
    await watch.look('sweep');
    box.set(T1, thread(T1, [message(leo, 24), message(me, 0.1, 'Yes, see you then.')]));
    // The owner's answer puts the thread at the top of the list with a new last word: a glance is enough.
    expect(await watch.look('glance')).toMatchObject({ overtaken: 1, read: 1 });
    expect(store.ready()).toEqual([]);
    expect(store.proposal(mailProposalId(T1, NOW - 24 * HOUR))!.state).toBe('answered');
    expect(asked.changed).toBe(2);
  });

  test('a reply leaves when the owner begins a draft of their own, without the thread being read', async () => {
    const drafted = new Set<string>();
    const { watch, store, asked } = world([thread(T1, [message(leo, 24)])], { rows: (item) => ({ draft: drafted.has(item.id) }) });
    await watch.look('sweep');
    drafted.add(T1);
    const reads = asked.reads.length;
    expect(await watch.look('recent')).toMatchObject({ overtaken: 1, read: 0 });
    expect(asked.reads.length).toBe(reads);
    expect(store.ready()).toEqual([]);
  });

  test('when the other side writes again, the old reply is overtaken and a new one prepared for the new message', async () => {
    const { watch, store, box } = world([thread(T1, [message(leo, 24)])]);
    await watch.look('sweep');
    box.set(T1, thread(T1, [message(leo, 24), message(leo, 5, 'Any news?')]));
    expect(await watch.look('recent')).toMatchObject({ overtaken: 1, asked: 1, prepared: 1 });
    expect(store.ready().map((row) => row.id)).toEqual([mailProposalId(T1, NOW - 5 * HOUR)]);
  });

  test('a reply the notch is acting on is left alone by a look', async () => {
    const { watch, store, box } = world([thread(T1, [message(leo, 24)])]);
    await watch.look('sweep');
    const [row] = store.ready();
    watch.hold(row!.id);
    // The notch has just sent it: the mailbox shows the owner's reply.
    box.set(T1, thread(T1, [message(leo, 24), message(me, 0, 'Hi Leo,\nThursday at 10:00 works.\nSam')]));
    expect(await watch.look('recent')).toMatchObject({ read: 0, overtaken: 0 });
    expect(store.proposal(row!.id)!.state).toBe('ready');
    watch.release(row!.id);
    expect(await watch.look('recent')).toMatchObject({ overtaken: 1 });
  });

  test('a file the reply would need is looked for before anyone is told it is missing', async () => {
    const { watch, store, asked, reply } = world([thread(T1, [message(leo, 24, 'Can you send the deck?')])], { answer: () => reply({ missing: 'The deck.', look_for: 'Lumen deck', time: '' }) });
    await watch.look('sweep');
    expect(asked.files).toEqual(['Lumen deck']);
    expect(store.ready()[0]).toMatchObject({ lookFor: 'Lumen deck', found: [{ id: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345', name: 'Lumen deck v3', kind: 'Google Slides' }] });
  });

  // No way to the mailbox is not an empty mailbox: nothing is concluded, nothing is forgotten.
  test('with no way to the mailbox it says so and changes nothing', async () => {
    const { watch, store, asked } = world([thread(T1, [message(leo, 24)])], { signedOut: true });
    expect(await watch.look('sweep')).toEqual({ through: null, listed: 0, read: 0, asked: 0, prepared: 0, overtaken: 0 });
    expect(asked.lists).toEqual([]);
    expect(store.ready()).toEqual([]);
  });

  test('a model that cannot be reached leaves the thread to be asked about by the next look', async () => {
    let down = true;
    const { watch, store, asked, reply } = world([thread(T1, [message(leo, 24)])], { answer: () => (down ? new Error('no model') : reply()) });
    expect(await watch.look('sweep')).toMatchObject({ asked: 1, prepared: 0 });
    expect(store.proposal(mailProposalId(T1, NOW - 24 * HOUR))).toBeNull();
    down = false;
    expect(await watch.look('recent')).toMatchObject({ asked: 1, prepared: 1 });
    expect(asked.thinks.length).toBe(2);
  });

  test('an answer of the model that cannot be used is kept as failed and not asked for again', async () => {
    const { watch, store, asked } = world([thread(T1, [message(leo, 24)])], { answer: () => 'I think you should reply.' });
    await watch.look('sweep');
    expect(store.proposal(mailProposalId(T1, NOW - 24 * HOUR))!.state).toBe('failed');
    await watch.look('recent');
    expect(asked.thinks.length).toBe(1);
  });

  test('one look at a time: a second call is the same look', async () => {
    const { watch, asked } = world([thread(T1, [message(leo, 24)])]);
    const [a, b] = await Promise.all([watch.look('sweep'), watch.look('recent')]);
    expect(a).toBe(b);
    expect(asked.lists).toEqual([30]);
  });

  test('nothing is looked at while everything is stopped', async () => {
    const box = world([thread(T1, [message(leo, 24)])]);
    const paused = new MailWatch({ reader: async () => { throw new Error('asked'); }, store: box.store, think: async () => { throw new Error('asked'); }, paused: () => true, log: () => {} });
    expect(await paused.look('sweep')).toMatchObject({ through: null, read: 0 });
  });
});

describe('what a thread is, for the owner', () => {
  test('is kept with the reply when the model gave it', async () => {
    const { watch, store, reply } = world([thread(T1, [message(leo, 24)])], { answer: () => reply({ about: 'Leo wants to know if Thursday at 10 works.' }) });
    await watch.look('sweep');
    expect(store.ready()[0]!.about).toBe('Leo wants to know if Thursday at 10 works.');
  });

  // Replies prepared before replies carried one: the owner's test brain had some.
  test('a reply without it is given one by a later look, asked for once, and what it cost is added', async () => {
    let about = '';
    const { watch, store, asked, reply } = world([thread(T1, [message(leo, 24)])], { answer: () => (asked.thinks.length > 1 ? JSON.stringify({ about }) : reply({ about: '' })) });
    await watch.look('sweep');
    // The model that drafted gave none, and so did the small question after it.
    expect(store.ready()[0]!.about).toBe('');
    expect(asked.thinks.length).toBe(2);
    about = 'Leo wants to know if Thursday at 10 works.';
    // Asked once since the brain started: not again every minute.
    await watch.look('glance');
    expect(asked.thinks.length).toBe(2);
    // A brain that starts again asks again, and this time is told.
    const again = new MailWatch({
      reader: async () => ({ through: 'browser', reader: { owner: async () => me.address, list: async () => [], read: async () => [thread(T1, [message(leo, 24)])] } }),
      store,
      think: async (messages) => { asked.thinks.push(messages[0]!.content); return { content: JSON.stringify({ about }), model: 'm', input: 300, output: 20, cached: 0 }; },
      now: () => NOW,
      log: () => {},
    });
    const before = store.ready()[0]!;
    await again.look('glance');
    expect(store.ready()[0]).toMatchObject({ about, tokensIn: before.tokensIn + 300, tokensOut: before.tokensOut + 20, draft: before.draft });
    // The small question, not the drafting one.
    expect(asked.thinks.at(-1)).toContain('in one plain sentence of at most twenty words');
    expect(asked.thinks.at(-1)).not.toContain('needs_reply');
  });
});

describe('the owner\'s voice', () => {
  test('a full look reads their own latest mail first, so that the first reply is already in their voice and by their name', async () => {
    const mineOnly = thread(T2, [message(me, 30, 'Ciao Leo,\nva benissimo, a giovedì.\nSam')]);
    const { watch, asked, box } = world([thread(T1, [message(leo, 24)])]);
    const store = new MailStore(new Database(':memory:'));
    const sentAsked: number[] = [];
    const voiced = new MailWatch({
      reader: async () => ({ through: 'browser', reader: {
        owner: async () => me.address,
        list: async () => [...box.values()].map((item) => listed(item)),
        read: async (rows) => rows.flatMap((row) => (row.id === T2 ? [mineOnly] : box.get(row.id) ? [box.get(row.id)!] : [])),
        sent: async (days) => { sentAsked.push(days); return [listed(mineOnly)]; },
      } }),
      store,
      think: async (messages) => { asked.thinks.push(messages[1]!.content); return { content: JSON.stringify({ needs_reply: false, why: '', reply: '' }), model: 'm', input: 1, output: 1, cached: 0 }; },
      now: () => NOW,
      log: () => {},
    });
    await voiced.look('sweep');
    expect(sentAsked).toEqual([14]);
    expect(asked.thinks[0]).toContain('va benissimo, a giovedì.');
    expect(asked.thinks[0]).toContain('mails Sam wrote, for their voice');
    expect(voiced.name()).toBe('Sam');
    // After that only a full look does: the lighter ones do not go back for it.
    await voiced.look('recent');
    expect(sentAsked).toEqual([14]);
    await voiced.look('sweep');
    expect(sentAsked).toEqual([14, 14]);
    expect(watch.name()).toBe('');
  });

  // The first look after the brain starts is a short one, so that a reply is ready within a minute.
  test('the first look, whatever its kind, reads their own mail first: no reply is written without their voice', async () => {
    const mineOnly = thread(T2, [message(me, 30, 'Ciao Leo,\nva benissimo, a giovedì.\nSam')]);
    const box = new Map([[T1, thread(T1, [message(leo, 24)])]]);
    const thinks: string[] = [];
    const sentAsked: number[] = [];
    const first = new MailWatch({
      reader: async () => ({ through: 'browser', reader: {
        owner: async () => me.address,
        list: async () => [...box.values()].map((item) => listed(item)),
        read: async (rows) => rows.flatMap((row) => (row.id === T2 ? [mineOnly] : box.get(row.id) ? [box.get(row.id)!] : [])),
        sent: async (days) => { sentAsked.push(days); return [listed(mineOnly)]; },
      } }),
      store: new MailStore(new Database(':memory:')),
      think: async (messages) => { thinks.push(messages[1]!.content); return { content: JSON.stringify({ needs_reply: false, why: '', reply: '' }), model: 'm', input: 1, output: 1, cached: 0 }; },
      now: () => NOW,
      log: () => {},
    });
    await first.look('recent');
    expect(sentAsked).toEqual([14]);
    expect(thinks[0]).toContain('va benissimo, a giovedì.');
    await first.look('glance');
    expect(sentAsked).toEqual([14]);
  });

  test('a look that was cut short says so, and what it had done stands', async () => {
    let reads = 0;
    const cut = new MailWatch({
      reader: async () => ({ through: 'browser', reader: {
        owner: async () => me.address,
        list: async () => [listed(thread(T1, [message(leo, 24)]))],
        read: async () => { reads++; throw new Error('the browser went away'); },
      } }),
      store: new MailStore(new Database(':memory:')),
      think: async () => { throw new Error('not asked'); },
      now: () => NOW,
      log: () => {},
    });
    expect(await cut.look('sweep')).toMatchObject({ failed: true });
    expect(reads).toBe(1);
    // It is not taken for the state of the mailbox: nothing is remembered as the last look.
    expect(cut.lastLook()).toBeNull();
  });
});

describe('a reply written again in another manner', () => {
  test('is drafted again for the thread as it stands, and what it cost is added', async () => {
    const { watch, store, asked, reply } = world([thread(T1, [message(leo, 24)])], { answer: (text) => (text.includes('asked for this reply to be written shorter') ? reply({ reply: 'Thursday 10 works. Sam', time: '' }) : reply()) });
    await watch.look('sweep');
    const [row] = store.ready();
    const next = await watch.redraft(row!.id, { tone: 'shorter' });
    expect(next).toMatchObject({ draft: 'Thursday 10 works. Sam', time: null, tone: 'shorter', tokensIn: 2400, tokensOut: 100, state: 'ready' });
    expect(store.proposal(row!.id)!.draft).toBe('Thursday 10 works. Sam');
    expect(asked.thinks.length).toBe(2);
  });

  test('with what the owner told: it reaches the model as theirs, outside the mail, and is kept with the reply', async () => {
    const { watch, store, asked, reply } = world([thread(T1, [message(leo, 24)])], { answer: (text) => (text.includes('told you, for this reply') ? reply({ reply: 'Hi Leo,\nI am on Central European Time.\nSam', time: '', missing: '' }) : reply({ missing: 'Their time zone.' })) });
    await watch.look('sweep');
    const [row] = store.ready();
    const next = await watch.redraft(row!.id, { told: '  I am on "Central European Time"\n ' });
    expect(next).toMatchObject({ draft: 'Hi Leo,\nI am on Central European Time.\nSam', missing: '', told: 'I am on "Central European Time"', tone: '' });
    const said = asked.thinks[1]!;
    expect(said).toContain(`told you, for this reply: "I am on 'Central European Time'". It is theirs to say and theirs to decide.`);
    // Before the mail's marks, never inside them.
    expect(said.indexOf('told you, for this reply')).toBeLessThan(said.indexOf('<<<UNTRUSTED_CONTENT'));
    // A later change of tone keeps what was told.
    await watch.redraft(row!.id, { tone: 'shorter' });
    expect(asked.thinks[2]).toContain('told you, for this reply');
    expect(asked.thinks[2]).toContain('written shorter');
  });

  test('is not drafted when the thread has moved on, and the reply that was there stays', async () => {
    const { watch, store, box } = world([thread(T1, [message(leo, 24)])]);
    await watch.look('sweep');
    const [row] = store.ready();
    box.set(T1, thread(T1, [message(leo, 24), message(anna, 1, 'I can take this one.')]));
    expect(await watch.redraft(row!.id, { tone: 'shorter' })).toBeNull();
    expect(store.proposal(row!.id)!.draft).toBe(row!.draft);
  });
});

describe('free times for a reply that offers one', () => {
  const offers = { reply: 'Hi Leo,\nMonday at 15:00 would suit me.\nSam', time: 'Monday at 15:00', times: ['Monday at 15:00', 'Tuesday at 10:00', 'Wednesday at 9:30'], asked: 'to move Thursday' };

  test('are read off the calendar by rule, given to the model, and kept with the reply, each with its words', async () => {
    const { watch, store, asked, reply } = world([thread(T1, [message(leo, 24, 'Can we move Thursday?')])], { answer: () => reply(offers) });
    await watch.look('sweep');
    // It is Saturday: the next working days, at the times the rule likes, by their whole dates.
    expect(asked.thinks[0]).toContain('1. Monday 16 November 2026, 15:00 to 15:30\n2. Tuesday 17 November 2026, 10:00 to 10:30\n3. Wednesday 18 November 2026, 09:30 to 10:00');
    expect(store.ready()[0]).toMatchObject({
      time: 'Monday at 15:00', asked: 'to move Thursday',
      slots: [
        { at: Date.UTC(2026, 10, 16, 15, 0), minutes: 30, words: 'Monday at 15:00' },
        { at: Date.UTC(2026, 10, 17, 10, 0), minutes: 30, words: 'Tuesday at 10:00' },
        { at: Date.UTC(2026, 10, 18, 9, 30), minutes: 30, words: 'Wednesday at 9:30' },
      ],
    });
  });

  test('a reply that accepts their time, or names none, has none', async () => {
    const { watch, store } = world([thread(T1, [message(leo, 24)])]);
    await watch.look('sweep');
    expect(store.ready()[0]).toMatchObject({ time: 'Thursday at 10:00', slots: null, asked: '' });
  });

  test('with no calendar the model is given none, and whatever it lists is not kept', async () => {
    const { watch, store, asked, reply } = world([thread(T1, [message(leo, 24)])], { calendar: false, answer: () => reply(offers) });
    await watch.look('sweep');
    expect(asked.thinks[0]).not.toContain('These times are free');
    expect(store.ready()[0]).toMatchObject({ slots: null, asked: '' });
  });

  test('written again later, the times are the calendar\'s as it is then', async () => {
    const { watch, store, asked, reply, later } = world([thread(T1, [message(leo, 24, 'Can we move Thursday?')])], {
      answer: (text) => (text.includes('1. Wednesday 18 November 2026, 15:00')
        ? reply({ reply: 'Hi Leo,\nWednesday at 15:00 would suit me.\nSam', time: 'Wednesday at 15:00', times: ['Wednesday at 15:00', 'Thursday at 11:00', 'Friday at 9:30'], asked: 'to move Thursday' })
        : reply(offers)),
    });
    await watch.look('sweep');
    const [row] = store.ready();
    // Three days on, Monday and Tuesday are gone. Thursday at 10:00 holds the board call.
    later(3 * 24 * HOUR);
    const next = await watch.redraft(row!.id, {});
    expect(asked.thinks[1]).toContain('1. Wednesday 18 November 2026, 15:00 to 15:30\n2. Thursday 19 November 2026, 11:00 to 11:30\n3. Friday 20 November 2026, 09:30 to 10:00');
    expect(next).toMatchObject({ time: 'Wednesday at 15:00', asked: 'to move Thursday' });
    expect(next!.slots!.map((slot) => [new Date(slot.at).toISOString(), slot.words])).toEqual([
      ['2026-11-18T15:00:00.000Z', 'Wednesday at 15:00'], ['2026-11-19T11:00:00.000Z', 'Thursday at 11:00'], ['2026-11-20T09:30:00.000Z', 'Friday at 9:30'],
    ]);
  });

  test('written again as something that offers no time, the times it had are gone with it', async () => {
    const { watch, store, reply } = world([thread(T1, [message(leo, 24, 'Can we move Thursday?')])], {
      answer: (text) => (text.includes('told you, for this reply') ? reply({ reply: 'Hi Leo,\nLet us keep Thursday.\nSam', time: '', times: [], asked: '' }) : reply(offers)),
    });
    await watch.look('sweep');
    const [row] = store.ready();
    expect(row!.slots).toHaveLength(3);
    const next = await watch.redraft(row!.id, { told: 'keep Thursday' });
    expect(next).toMatchObject({ time: null, slots: null, asked: '' });
  });
});

describe('a person who is always written to in one manner', () => {
  test('gets a reply that is prepared in it, and the draft says so', async () => {
    const { watch, store, asked } = world([thread(T1, [message(leo, 24)])]);
    store.setTone(leo, 'shorter', NOW - HOUR);
    await watch.look('sweep');
    expect(asked.thinks[0]).toContain('asked for this reply to be written shorter');
    expect(store.ready()[0]).toMatchObject({ tone: 'shorter', state: 'ready' });
  });

  test('somebody else is written to as the owner writes', async () => {
    const { watch, store, asked } = world([thread(T1, [message(anna, 24)])]);
    store.setTone(leo, 'shorter', NOW - HOUR);
    await watch.look('sweep');
    expect(asked.thinks[0]).not.toContain('asked for this reply to be written');
    expect(store.ready()[0]).toMatchObject({ tone: '' });
  });

  test('a message that needs no reply has no manner', async () => {
    const { watch, store } = world([thread(T1, [message(leo, 24)])], { answer: () => '{"needs_reply": false, "why": "Thanks only."}' });
    store.setTone(leo, 'shorter', NOW - HOUR);
    await watch.look('sweep');
    expect(store.proposal(mailProposalId(T1, NOW - 24 * HOUR))).toMatchObject({ state: 'silent', tone: '' });
  });
});

describe('is a reply still an answer to the last word', () => {
  // Three questions to the mailbox, each waiting its turn behind a look, made a draft slow to open.
  test('is one question to the mailbox: whose mailbox it is was learned by the look', async () => {
    let owners = 0;
    let reads = 0;
    const store = new MailStore(new Database(':memory:'));
    const item = thread(T1, [message(leo, 24)]);
    const watch = new MailWatch({
      reader: async () => ({ through: 'browser', reader: {
        owner: async () => { owners++; return me.address; },
        list: async () => [listed(item)],
        read: async (rows) => { reads++; return rows.map(() => item); },
      } }),
      store,
      think: async () => ({ content: JSON.stringify({ needs_reply: true, why: '', reply: 'Yes.', missing: '', time: '', look_for: '', about: 'Leo asks about Thursday.' }), model: 'm', input: 1, output: 1, cached: 0 }),
      now: () => NOW,
      log: () => {},
    });
    await watch.look('sweep');
    const [row] = store.ready();
    const ownersBefore = owners;
    const readsBefore = reads;
    expect(await watch.stillWaits(row!.id, 0)).toBe(true);
    expect(owners).toBe(ownersBefore);
    expect(reads).toBe(readsBefore + 1);
  });

  test('yes while the thread stands as it did, no once it has moved on, and nothing is concluded without the mailbox', async () => {
    const { watch, store, box } = world([thread(T1, [message(leo, 24)])]);
    await watch.look('sweep');
    const [row] = store.ready();
    expect(await watch.stillWaits(row!.id)).toBe(true);
    box.set(T1, thread(T1, [message(leo, 24), message(me, 0.1, 'Done.')]));
    // Seen to wait a moment ago by the look: the mailbox is not asked again so soon.
    expect(await watch.stillWaits(row!.id)).toBe(true);
    expect(await watch.stillWaits(row!.id, 0)).toBe(false);
    expect(store.proposal(row!.id)!.state).toBe('answered');
    // Gone from the mailbox's reach: not known, so not changed.
    const other = world([thread(T2, [message(leo, 24)])]);
    await other.watch.look('sweep');
    const [waiting] = other.store.ready();
    other.box.delete(T2);
    expect(await other.watch.stillWaits(waiting!.id, 0)).toBeNull();
    expect(other.store.proposal(waiting!.id)!.state).toBe('ready');
  });
});
