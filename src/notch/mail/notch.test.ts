/**
 * The mail line on the notch, with the real surface, inbox and store. The
 * mailbox and the watcher are stand-ins that say what was asked of them.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NotchInbox } from '../inbox.ts';
import type { NotchAnswerAct, NotchBlock, NotchLine, NotchPart, NotchToPage } from '../protocol.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface, type NotchSurfacePort } from '../surface.ts';
import type { MailReplyPlan, MailReplySession, MailStep, Mailbox } from './mailbox.ts';
import { MAIL_FUSE_MS, attachNotchMail, mailDraftBlocks } from './notch.ts';
import { MailStore, mailProposalId, type MailProposalRow } from './store.ts';
import { mailPerson } from './thread.ts';
import type { MailLook } from './watch.ts';

const leo = mailPerson('Leo Bianchi', 'leo@lumen.example');
const anna = mailPerson('Anna Conti', 'anna@lumen.example');
const T1 = '19a1b2c3d4e5f601';
const T2 = '19a1b2c3d4e5f602';
const AT = Date.UTC(2026, 10, 14, 9, 0);

const row = (extra: Partial<MailProposalRow> = {}): MailProposalRow => ({
  id: mailProposalId(T1, AT), thread: T1, messageAt: AT, state: 'ready', who: leo, subject: 'Deck for Thursday?', to: [leo], cc: [anna],
  draft: 'Hi Leo,\nThursday at 10:00 works for me.\nSam', time: 'Thursday at 10:00', missing: 'The deck itself.', lookFor: '', found: null, tone: '', told: '', about: '',
  model: 'm', tokensIn: 1200, tokensOut: 80, createdAt: AT + 1, updatedAt: AT + 1, sentAt: null, ...extra,
});

const settle = async (): Promise<void> => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | undefined): string => (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : 'word' in part ? `[${part.word.value}]` : '')).join('');
/** The quiet lines of a sheet, as text: everything but the paper and the links. */
const notes = (blocks: NotchBlock[]): string[] => blocks.flatMap((block) => (block.kind === 'note' ? [text(block.say)] : []));

function harness(rows: MailProposalRow[], options: {
  steps?: Partial<Record<'write' | 'send' | 'discard', MailStep>>;
  sent?: (boolean | null)[];
  stillWaits?: boolean | null;
  /** Read at each asking: so that a test can change the answer while a line is up. */
  stillWaitsFrom?: (boolean | null)[];
  /** The mailbox takes its time: the answer comes when this does. */
  stillWaitsWhen?: Promise<boolean | null>;
  noMailbox?: boolean;
  look?: MailLook | null;
  /** A look (the month, say) is under way. */
  reading?: boolean;
  /** Whether Gmail is the site in front. */
  inGmail?: () => boolean;
  /** Whether the whole month has been gone through. */
  monthRead?: () => boolean;
} = {}) {
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const pushed: NotchToPage[] = [];
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { onEvent = listener; },
    onSidecarDisconnected() {},
  };
  const timers: { fn: () => void; at: number }[] = [];
  let now = 0;
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
  const surface = new NotchSurface(port, () => {});
  const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 1 });
  const inbox = new NotchInbox(surface, { clock, log: () => {} });
  const store = new MailStore(new Database(':memory:'));
  for (const entry of rows) store.put(entry);

  const did: string[] = [];
  const plans: MailReplyPlan[] = [];
  const sent = [...(options.sent ?? [true])];
  const mailbox: Mailbox = {
    reader: async () => null,
    reply: async (plan, work) => {
      plans.push(plan);
      const session: MailReplySession = {
        write: async () => { did.push('write'); return options.steps?.write ?? { ok: true }; },
        send: async () => { did.push('send'); return options.steps?.send ?? { ok: true }; },
        discard: async () => { did.push('discard'); return options.steps?.discard ?? { ok: true }; },
        sent: async () => { did.push('sent?'); return sent.length > 1 ? sent.shift()! : sent[0]!; },
      };
      return work(session);
    },
  };
  const redrafts: [string, { tone?: string; told?: string }][] = [];
  const held: string[] = [];
  let looks = 0;
  const asks = { still: 0 };
  const stillWaits = async (): Promise<boolean | null> =>
    options.stillWaitsWhen ? options.stillWaitsWhen : options.stillWaitsFrom ? options.stillWaitsFrom[0]! : options.stillWaits === undefined ? true : options.stillWaits;
  const mail = attachNotchMail(inbox, {
    store,
    watch: {
      hold: (id) => { held.push(`hold ${id}`); },
      release: (id) => { held.push(`release ${id}`); },
      redraft: async (id, change) => {
        redrafts.push([id, change]);
        const before = store.proposal(id)!;
        if (change.tone === 'more formally' || change.told === 'cannot be written') return null;
        const next = change.told
          ? { ...before, draft: `Hi Leo,\n${change.told}.\nSam`, time: null, missing: '', told: change.told }
          : { ...before, draft: 'Thursday 10 works. Sam', time: null, tone: change.tone ?? before.tone };
        store.put(next);
        return next;
      },
      stillWaits: async () => { asks.still++; return stillWaits(); },
      look: async () => { looks++; return options.look ?? { through: 'browser', listed: 1, read: 0, asked: 0, prepared: 0, overtaken: 0 }; },
      lastLook: () => null,
      busy: () => options.reading === true,
    },
    mailbox: () => (options.noMailbox ? null : mailbox),
    inGmail: options.inGmail,
    monthRead: options.monthRead,
    now: () => AT + 10_000 + now,
    log: () => {},
  });
  const line = (): NotchLine | null => surface.current().line;
  return {
    mail, store, inbox, did, plans, redrafts, held, line, surface, asks,
    looks: () => looks,
    said: (): string => text(line()?.say),
    count: (): number => surface.current().count,
    blocks: (): NotchBlock[] => { const shown = line(); return shown?.kind === 'sheet' ? shown.blocks : []; },
    async answer(act: NotchAnswerAct, more: Record<string, unknown> = {}): Promise<void> { fromPage({ type: 'answer', id: line()!.id, act, ...more }); await settle(); },
    async open(): Promise<void> { fromPage({ type: 'open' }); await settle(); },
    async arrive(): Promise<void> { await mail.arrived(); await settle(); },
    async advance(ms: number): Promise<void> {
      now += ms;
      for (const timer of [...timers].filter((entry) => entry.at <= now)) {
        const at = timers.indexOf(timer);
        if (at >= 0) { timers.splice(at, 1); timer.fn(); }
      }
      await settle();
    },
  };
}

describe('the draft as it is shown', () => {
  test('who it goes to, the reply with its time as a word that can be changed, what was not known, and the tone', () => {
    const blocks = mailDraftBlocks(row({ found: [{ id: 'x'.repeat(30), name: 'Lumen deck v3', kind: 'Google Slides' }] }));
    const paper = blocks[0] as Extract<NotchBlock, { kind: 'paper' }>;
    expect(text(paper.to)).toBe('To Leo Bianchi  ·  Copy to Anna Conti  ·  Re: Deck for Thursday?');
    expect(paper.lines.map(text)).toEqual(['Hi Leo,', '[Thursday at 10:00] works for me.', 'Sam']);
    expect(paper.lines[1]![1]).toEqual({ word: { name: 'when', value: 'Thursday at 10:00', options: ['Thursday at 10:00'], label: 'Time', read: 'dayTime' } });
    expect(notes(blocks)).toEqual([
      'I did not know: The deck itself. [tell me]',
      'Found in your Drive: Lumen deck v3',
      'Not sent yet. Tone [yours]',
    ]);
    // Under it all, the one way to turn the reply down for good.
    expect(blocks.at(-1)).toEqual({ kind: 'buttons', buttons: [{ id: 'not-needed', label: 'Not needed', quiet: true }] });
    // The word beside what was not known takes a sentence, not a word.
    const missing = blocks[1] as { say: NotchPart[] };
    expect(missing.say.at(-1)).toEqual({ word: { name: 'told', value: 'tell me', options: [], label: 'Tell Jarvis', free: true, long: true } });
  });

  test('what the owner told is shown, with the one word to change it, and nothing missing has no word to tell', () => {
    const told = mailDraftBlocks(row({ told: 'Central European Time', missing: 'Whether Thursday still suits Leo.' }));
    expect(notes(told)).toEqual([
      'I did not know: Whether Thursday still suits Leo.',
      'You told me: Central European Time [change]',
      'Not sent yet. Tone [yours]',
    ]);
    const none = mailDraftBlocks(row({ missing: '' }));
    expect(none.map((block) => JSON.stringify(block)).join('')).not.toContain('"told"');
  });

  // The owner, 15 November 2026: "I've got no context on what the thread was about ... a very small summary".
  test('what the thread is comes first, above the reply, in one line', () => {
    const blocks = mailDraftBlocks(row({ about: 'Leo wants the deck before Thursday\'s call with Northwind.', missing: '' }));
    expect(blocks[0]).toEqual({ kind: 'note', say: ['Leo wants the deck before Thursday\'s call with Northwind.'] });
    expect(blocks[1]!.kind).toBe('paper');
    expect(notes(blocks)).toEqual(['Leo wants the deck before Thursday\'s call with Northwind.', 'Not sent yet. Tone [yours]']);
    // One line it stays, whatever the model wrote.
    expect(text((mailDraftBlocks(row({ about: 'x'.repeat(400) }))[0] as { say: NotchPart[] }).say).length).toBeLessThanOrEqual(180);
    // None made: the paper is first, as before.
    expect(mailDraftBlocks(row())[0]!.kind).toBe('paper');
  });

  test('the empty lines of a reply are the gaps between its paragraphs, not paragraphs of their own', () => {
    const blocks = mailDraftBlocks(row({ draft: 'Hi Leo,\n\nThursday at 10:00 works for me.\n  \nSam', missing: '' }));
    expect((blocks[0] as Extract<NotchBlock, { kind: 'paper' }>).lines.map(text)).toEqual(['Hi Leo,', '[Thursday at 10:00] works for me.', 'Sam']);
  });

  test('a reply with no time has no lit word, and one with nothing missing says nothing of it', () => {
    const blocks = mailDraftBlocks(row({ time: null, missing: '' }));
    expect((blocks[0] as Extract<NotchBlock, { kind: 'paper' }>).lines.map(text)).toEqual(['Hi Leo,', 'Thursday at 10:00 works for me.', 'Sam']);
    expect(notes(blocks)).toEqual(['Not sent yet. Tone [yours]']);
  });
});

describe('a prepared reply on the notch', () => {
  test('waits in the count, and speaks up when the owner comes to Gmail', async () => {
    const h = harness([row()]);
    expect(h.count()).toBe(1);
    expect(h.line()).toBeNull();
    await h.arrive();
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'show', src: 'mail', unasked: true });
    expect(h.said()).toBe('You have not replied to Leo. I drafted a reply.');
    expect(h.count()).toBe(0);
  });

  test('yes shows the draft; yes again writes it into the thread, burns the fuse, sends it, and it is gone', async () => {
    const h = harness([row()]);
    await h.arrive();
    await h.answer('yes');
    expect(h.line()).toMatchObject({ kind: 'sheet', yes: 'send', stay: true });
    expect(h.said()).toBe('Reply to Leo');
    expect(h.did).toEqual([]);
    await h.answer('yes');
    // Into the thread first, as a draft, to the people decided on and nobody else.
    expect(h.plans).toEqual([{ thread: T1, to: ['leo@lumen.example'], cc: ['anna@lumen.example'], text: 'Hi Leo,\nThursday at 10:00 works for me.\nSam' }]);
    expect(h.did).toEqual(['write']);
    expect(h.line()).toMatchObject({ kind: 'send', ms: MAIL_FUSE_MS });
    expect(h.said()).toBe('Sending to Leo…');
    expect(h.store.proposal(row().id)!.state).toBe('ready');
    await h.answer('done');
    expect(h.did).toEqual(['write', 'send', 'sent?']);
    expect(h.said()).toBe('Sent to Leo.');
    expect(h.store.proposal(row().id)).toMatchObject({ state: 'sent', sentAt: AT + 10_000 });
    await h.answer('done');
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
    // The watcher was told to leave the thread alone for exactly as long as it took.
    expect(h.held).toEqual([`hold ${row().id}`, `release ${row().id}`]);
  });

  // Esc inside a fuse takes back the yes just given, and nothing else.
  test('Esc while the fuse burns: nothing is sent, no draft is left, and the reply waits again', async () => {
    const h = harness([row()]);
    await h.arrive();
    await h.answer('yes');
    await h.answer('yes');
    await h.answer('undo');
    expect(h.did).toEqual(['write', 'discard']);
    expect(h.said()).toBe('Not sent. No draft is left in Gmail.');
    await h.answer('done');
    // It waits again: kept, and one step away in Home. It has been seen, so it is not in the count.
    expect(h.store.proposal(row().id)!.state).toBe('ready');
    expect(h.count()).toBe(0);
    expect(text((h.mail.homeRow() as { say: NotchPart[] }).say)).toBe('Reply to Leo is drafted');
  });

  test('a fuse nobody saw burn out sends nothing and leaves no draft', async () => {
    const h = harness([row()]);
    await h.arrive();
    await h.answer('yes');
    await h.answer('yes');
    await h.advance(MAIL_FUSE_MS + 2000);
    expect(h.did).toEqual(['write', 'discard']);
    expect(h.store.proposal(row().id)!.state).toBe('ready');
  });

  test('Esc on the line, or on the draft, is a no: it does not come back', async () => {
    const onLine = harness([row()]);
    await onLine.arrive();
    await onLine.answer('no');
    expect(onLine.store.proposal(row().id)!.state).toBe('declined');
    expect(onLine.count()).toBe(0);
    expect(onLine.did).toEqual([]);

    const onDraft = harness([row()]);
    await onDraft.arrive();
    await onDraft.answer('yes');
    // No other word for the key: on this draft it is the no it says it is.
    expect((onDraft.line() as { no?: string }).no).toBeUndefined();
    await onDraft.answer('no');
    expect(onDraft.store.proposal(row().id)!.state).toBe('declined');
    expect(onDraft.did).toEqual([]);
  });

  test('"Not needed" under the draft is a no in words: the reply does not come back', async () => {
    const h = harness([row()]);
    await h.arrive();
    await h.answer('yes');
    await h.answer('button', { button: 'not-needed' });
    expect(h.store.proposal(row().id)!.state).toBe('declined');
    expect(h.count()).toBe(0);
    expect(h.did).toEqual([]);
    expect(h.mail.homeRow()).toBeNull();
  });

  test('left alone it folds and waits in Home: not now is not no, and it does not stand in the way', async () => {
    const h = harness([row()]);
    await h.arrive();
    await h.answer('fold');
    expect(h.store.proposal(row().id)!.state).toBe('ready');
    expect(h.count()).toBe(0);
    expect(h.mail.homeRow()).toMatchObject({ kind: 'row', id: 'mail', lead: 'Mail', go: true });
  });

  test('a new tone is a new letter: it is written again, and that is what is sent', async () => {
    const h = harness([row()]);
    await h.arrive();
    await h.answer('yes');
    await h.answer('word', { word: 'tone', value: 'shorter' });
    expect(h.redrafts).toEqual([[row().id, { tone: 'shorter' }]]);
    expect((h.blocks()[0] as Extract<NotchBlock, { kind: 'paper' }>).lines.map(text)).toEqual(['Thursday 10 works. Sam']);
    expect(notes(h.blocks()).at(-1)).toBe('Not sent yet. Tone [shorter]');
    await h.answer('yes');
    expect(h.plans[0]!.text).toBe('Thursday 10 works. Sam');
  });

  // The owner's ask after his first real use, 15 November 2026: "a way for me to input ... the things you did not know".
  test('the owner says what was not known, and the reply is written again with it', async () => {
    const h = harness([row()]);
    await h.arrive();
    await h.answer('yes');
    expect(notes(h.blocks())[0]).toBe('I did not know: The deck itself. [tell me]');
    await h.answer('word', { word: 'told', value: 'The deck goes out on Friday' });
    expect(h.redrafts).toEqual([[row().id, { told: 'The deck goes out on Friday' }]]);
    expect((h.blocks()[0] as Extract<NotchBlock, { kind: 'paper' }>).lines.map(text)).toEqual(['Hi Leo,', 'The deck goes out on Friday.', 'Sam']);
    expect(notes(h.blocks())).toEqual(['You told me: The deck goes out on Friday [change]', 'Not sent yet. Tone [yours]']);
    // And that is what is sent.
    await h.answer('yes');
    expect(h.plans[0]!.text).toBe('Hi Leo,\nThe deck goes out on Friday.\nSam');
    expect(h.store.proposal(row().id)!.told).toBe('The deck goes out on Friday');
  });

  test('the word as it stands, an empty one, or the same thing again, is not something told', async () => {
    const h = harness([row()]);
    await h.arrive();
    await h.answer('yes');
    for (const value of ['tell me', 'change', '', '   ']) await h.answer('word', { word: 'told', value });
    expect(h.redrafts).toEqual([]);
    await h.answer('word', { word: 'told', value: 'cannot be written' });
    expect(notes(h.blocks()).at(-1)).toBe('I could not write it again. This is the reply as it was. Tone [yours]');
    expect(h.store.proposal(row().id)!.told).toBe('');
  });

  test('a tone that could not be written leaves the reply as it was, and says so', async () => {
    const h = harness([row()]);
    await h.arrive();
    await h.answer('yes');
    await h.answer('word', { word: 'tone', value: 'more formal' });
    expect(notes(h.blocks()).at(-1)).toBe('I could not write it again. This is the reply as it was. Tone [yours]');
    // A word that is not one of the tones is not acted on.
    await h.answer('word', { word: 'tone', value: 'like a pirate' });
    expect(h.redrafts.length).toBe(1);
  });

  test('the owner\'s own time takes the place of the one proposed, in the text that is sent', async () => {
    const h = harness([row()]);
    await h.arrive();
    await h.answer('yes');
    await h.answer('word', { word: 'when', value: 'Friday at 15:00' });
    expect(h.store.proposal(row().id)).toMatchObject({ time: 'Friday at 15:00', draft: 'Hi Leo,\nFriday at 15:00 works for me.\nSam' });
    await h.answer('yes');
    expect(h.plans[0]!.text).toBe('Hi Leo,\nFriday at 15:00 works for me.\nSam');
  });

  test('when the page will not write it, nothing is sent, what was begun is taken away, and the reply is kept', async () => {
    const h = harness([row()], { steps: { write: { ok: false, why: 'the reply does not go to exactly the expected people' } } });
    await h.arrive();
    await h.answer('yes');
    await h.answer('yes');
    expect(h.did).toEqual(['write', 'discard']);
    expect(h.said()).toBe('I could not put the reply in the thread, so nothing was sent. It is kept here.');
    expect(h.line()).toMatchObject({ kind: 'say', mark: 'fail' });
    expect(h.store.proposal(row().id)!.state).toBe('ready');
  });

  test('when it cannot be sent, it says so and where the draft is, and is not called sent', async () => {
    const h = harness([row()], { steps: { send: { ok: false, why: 'no way to send was found' } } });
    await h.arrive();
    await h.answer('yes');
    await h.answer('yes');
    await h.answer('done');
    expect(h.said()).toBe('I could not send it. It is in your Gmail drafts.');
    expect(h.store.proposal(row().id)!.state).toBe('ready');
  });

  // Gmail's word is not enough: sent means it is the last word in the thread.
  test('is called sent only when the mailbox shows it, and looks twice before saying it does not', async () => {
    const late = harness([row()], { sent: [false, true] });
    await late.arrive();
    await late.answer('yes');
    await late.answer('yes');
    await late.answer('done');
    await late.advance(1500);
    expect(late.said()).toBe('Sent to Leo.');
    expect(late.store.proposal(row().id)!.state).toBe('sent');

    const never = harness([row()], { sent: [false] });
    await never.arrive();
    await never.answer('yes');
    await never.answer('yes');
    await never.answer('done');
    await never.advance(1500);
    expect(never.said()).toBe('Gmail says it was sent, but I do not see it in the thread yet. I will look again.');
    expect(never.store.proposal(row().id)!.state).toBe('ready');
  });

  test('a thread that moved on between the draft being shown and the yes is not written in', async () => {
    const answers: (boolean | null)[] = [true];
    const h = harness([row()], { stillWaitsFrom: answers });
    await h.arrive();
    await h.answer('yes');
    // The owner answered by hand while the draft was on the notch.
    answers[0] = false;
    await h.answer('yes');
    expect(h.did).toEqual([]);
    expect(h.said()).toBe('The thread has moved on since. I did not send it.');
    await h.answer('done');
    expect(h.count()).toBe(0);
  });

  test('with no way to Gmail the reply is kept and it says why nothing was sent', async () => {
    const h = harness([row()], { noMailbox: true });
    await h.arrive();
    await h.answer('yes');
    await h.answer('yes');
    expect(h.said()).toBe('I cannot reach Gmail from here to send it. The reply is kept.');
    expect(h.did).toEqual([]);
    expect(h.store.proposal(row().id)!.state).toBe('ready');
  });
});

describe('coming to Gmail', () => {
  test('each reply speaks up by itself once, the newest first, and one that is on the notch is left as it is', async () => {
    const older = row({ id: mailProposalId(T2, AT - 1000), thread: T2, messageAt: AT - 1000, who: anna });
    const h = harness([row(), older]);
    // Mail is one thing in the count, however many replies wait in it.
    expect(h.count()).toBe(1);
    await h.arrive();
    expect(h.said()).toBe('You have not replied to Leo. I drafted a reply.');
    const shown = h.line()!.id;
    await h.arrive();
    expect(h.line()!.id).toBe(shown);
    await h.answer('fold');
    await h.arrive();
    expect(h.said()).toBe('You have not replied to Anna. I drafted a reply.');
    // It is on the notch, and nothing else waits behind it.
    expect(h.count()).toBe(0);
    await h.answer('fold');
    expect(h.count()).toBe(0);
    await h.arrive();
    expect(h.line()).toBeNull();
    // Both seen: neither is in the count, and both are kept.
    expect(h.store.ready().length).toBe(2);
    expect(text((h.mail.homeRow() as { say: NotchPart[] }).say)).toBe('2 replies drafted, waiting for your word');
  });

  test('with nobody waiting it says so, truthfully, and not again each time', async () => {
    const h = harness([]);
    await h.arrive();
    expect(h.looks()).toBe(1);
    expect(h.said()).toBe('Nobody in your mail is waiting for a reply.');
    await h.answer('done');
    await h.arrive();
    expect(h.line()).toBeNull();
  });

  // Found on the owner's first try, 15 November 2026: Gmail was open, the month was still being read, and
  // the notch said nothing at all. It says that it is reading, once, and what came of it when it has read.
  test('while the mailbox is still being read it does not wait for that: it says so, once, and is owed an answer', async () => {
    const empty = harness([], { reading: true });
    expect(await empty.mail.arrived()).toBe('reading');
    await settle();
    expect(empty.looks()).toBe(0);
    expect(empty.said()).toBe('I am reading your mail. One moment.');
    await empty.answer('done');
    expect(await empty.mail.arrived()).toBe('reading');
    await settle();
    expect(empty.line()).toBeNull();
    // What is ready already speaks, reading or not.
    const some = harness([row()], { reading: true });
    expect(await some.mail.arrived()).toBe('spoke');
    await settle();
    expect(some.looks()).toBe(0);
    expect(some.said()).toBe('You have not replied to Leo. I drafted a reply.');
  });

  // The first look is the last two days. That nobody is waiting is not known until the month has been read.
  test('"nobody is waiting" is kept for when the whole month has been read', async () => {
    let monthRead = false;
    const h = harness([], { monthRead: () => monthRead });
    expect(await h.mail.arrived()).toBe('reading');
    await settle();
    expect(h.said()).toBe('I am reading your mail. One moment.');
    await h.answer('done');
    monthRead = true;
    expect(await h.mail.arrived()).toBe('said');
    await settle();
    expect(h.said()).toBe('Nobody in your mail is waiting for a reply.');
  });

  test('a mailbox that cannot be reached is said to be so, whether or not the month was read', async () => {
    const h = harness([], { monthRead: () => false, look: { through: null, listed: 0, read: 0, asked: 0, prepared: 0, overtaken: 0 } });
    expect(await h.mail.arrived()).toBe('said');
    await settle();
    expect(h.said()).toBe('I cannot see your mail right now. Jarvis\'s own browser may not be signed in to Gmail.');
  });

  test('when the mail cannot be seen, that is what it says', async () => {
    const h = harness([], { look: { through: null, listed: 0, read: 0, asked: 0, prepared: 0, overtaken: 0 } });
    await h.arrive();
    expect(h.said()).toBe('I cannot see your mail right now. Jarvis\'s own browser may not be signed in to Gmail.');
  });
});

// Pass 8: a reply to a mail that has just come speaks from anywhere, always with its source.
describe('from anywhere', () => {
  test('outside Gmail the line names its source; in Gmail the place itself does', async () => {
    let inGmail = false;
    const h = harness([row()], { inGmail: () => inGmail });
    h.mail.speak();
    await settle();
    expect(h.said()).toBe('In Gmail: you have not replied to Leo. I drafted a reply.');
    expect(h.line()).toMatchObject({ kind: 'offer', src: 'mail', unasked: true });
    expect((h.line()!.say[0] as { em: string }).em).toBe('In Gmail:');
    await h.answer('fold');
    inGmail = true;
    h.store.put(row({ id: mailProposalId(T2, AT), thread: T2 }));
    h.mail.speak();
    await settle();
    expect(h.said()).toBe('You have not replied to Leo. I drafted a reply.');
  });

  test('several at once, outside Gmail, are one line with the source in front', async () => {
    const other = row({ id: mailProposalId(T2, AT - 1000), thread: T2, messageAt: AT - 1000, who: anna });
    const h = harness([row(), other], { inGmail: () => false });
    await h.open();
    expect(h.said()).toBe('In Gmail: 2 people are waiting for a reply. I drafted them.');
  });

  test('speaking does not take the notch from what is on it, and does not use up the reply\'s one say', async () => {
    const h = harness([row()], { inGmail: () => false });
    h.inbox.present('other', async (stage) => { await stage.say(['Something else.'], 5000); });
    await settle();
    h.mail.speak();
    await settle();
    expect(h.said()).toBe('Something else.');
    await h.answer('done');
    h.mail.speak();
    await settle();
    expect(h.said()).toBe('In Gmail: you have not replied to Leo. I drafted a reply.');
  });

  test('replies another line has told of do not each speak up after it, and wait in Home', async () => {
    const other = row({ id: mailProposalId(T2, AT - 1000), thread: T2, messageAt: AT - 1000, who: anna, createdAt: AT - 500 });
    const h = harness([row(), other], { inGmail: () => false });
    expect(h.mail.newSince(AT)).toBe(1);
    expect(h.mail.newSince(AT - 1000)).toBe(2);
    h.mail.told();
    await settle();
    expect(h.count()).toBe(0);
    expect(h.mail.newSince(AT - 1000)).toBe(0);
    h.mail.speak();
    await settle();
    expect(h.line()).toBeNull();
    expect(text((h.mail.homeRow() as { say: NotchPart[] }).say)).toBe('2 replies drafted, waiting for your word');
  });
});

describe('several replies waiting', () => {
  const older = row({ id: mailProposalId(T2, AT - 1000), thread: T2, messageAt: AT - 1000, who: anna, subject: 'Invoice 114', cc: [], to: [anna], draft: 'Hi Anna,\nPaid today.\nSam', time: null, missing: '' });

  // A month of unanswered mail must never stand between the owner and the rest of the notch.
  test('are one line when the owner comes to the notch, and a list of who and what behind it', async () => {
    const h = harness([row(), older]);
    await h.open();
    expect(h.said()).toBe('2 people are waiting for a reply. I drafted them.');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'show', src: 'mail' });
    await h.answer('yes');
    expect(h.said()).toBe('2 replies wait');
    expect(h.blocks()).toEqual([
      { kind: 'row', id: T1, lead: 'Leo', say: ['Deck for Thursday?'], go: true },
      { kind: 'row', id: T2, lead: 'Anna', say: ['Invoice 114'], go: true },
    ]);
  });

  test('a row opens its reply at the draft, and the list comes back with what is left', async () => {
    const h = harness([row(), older]);
    await h.open();
    await h.answer('yes');
    await h.answer('go', { row: T2 });
    expect(h.said()).toBe('Reply to Anna');
    expect((h.blocks()[0] as Extract<NotchBlock, { kind: 'paper' }>).lines.map(text)).toEqual(['Hi Anna,', 'Paid today.', 'Sam']);
    await h.answer('yes');
    await h.answer('done');
    expect(h.plans).toEqual([{ thread: T2, to: ['anna@lumen.example'], cc: [], text: 'Hi Anna,\nPaid today.\nSam' }]);
    expect(h.said()).toBe('Sent to Anna.');
    await h.answer('done');
    expect(h.said()).toBe('1 reply waits');
    expect(h.blocks().map((block) => (block as { id?: string }).id)).toEqual([T1]);
    // Esc on a draft opened from the list closes the draft. The reply is kept, and the list is back.
    // Found on the owner's first evening with it (15 November 2026): ten replies were turned down in
    // eleven minutes, by the key that everywhere else means "back".
    await h.answer('go', { row: T1 });
    expect(h.said()).toBe('Reply to Leo');
    // The key says what it does here: it is not the "no" of a reply that was offered.
    expect(h.line()).toMatchObject({ kind: 'sheet', yes: 'send', stay: true, no: 'back' });
    await h.answer('no');
    expect(h.store.proposal(row().id)!.state).toBe('ready');
    expect(h.said()).toBe('1 reply waits');
    // Turning it down is said in words, on the draft, and is a no to that reply only.
    await h.answer('go', { row: T1 });
    await h.answer('button', { button: 'not-needed' });
    expect(h.store.proposal(row().id)!.state).toBe('declined');
    expect(h.store.proposal(older.id)!.state).toBe('sent');
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
  });

  test('a row says what its thread is when that is known, and its subject when it is not', async () => {
    const h = harness([row({ about: 'Leo wants the deck before Thursday\'s call.' }), older]);
    await h.open();
    await h.answer('yes');
    // The row begins with the name, so the sentence does not say it twice.
    expect(h.blocks()).toEqual([
      { kind: 'row', id: T1, lead: 'Leo', say: ['wants the deck before Thursday\'s call.'], go: true },
      { kind: 'row', id: T2, lead: 'Anna', say: ['Invoice 114'], go: true },
    ]);
    // A sentence that begins with somebody else is left whole.
    const other = harness([row({ about: 'The Lumen team asks for the deck.' }), older]);
    await other.open();
    await other.answer('yes');
    expect(text((other.blocks()[0] as { say: NotchPart[] }).say)).toBe('The Lumen team asks for the deck.');
  });

  // The owner, 15 November 2026: "when I click it for Jarvis to show me the draft, it takes so long".
  // Measured on their brain: the mailbox was asked three things first, each behind a look through the month.
  test('a draft the owner asks for is up at once: the mailbox is asked behind it, not before it', async () => {
    let tell: (still: boolean | null) => void = () => {};
    const h = harness([row(), older], { stillWaitsWhen: new Promise((resolve) => { tell = resolve; }) });
    await h.open();
    await h.answer('yes');
    await h.answer('go', { row: T2 });
    // The mailbox has said nothing yet, and the draft is there.
    expect(h.asks.still).toBe(1);
    expect(h.said()).toBe('Reply to Anna');
    expect(h.line()).toMatchObject({ kind: 'sheet', yes: 'send' });
    // It answers: the thread still waits. Nothing changes on the notch.
    tell(true);
    await settle();
    expect(h.said()).toBe('Reply to Anna');
    expect(h.store.proposal(older.id)!.state).toBe('ready');
  });

  test('when the mailbox then says the thread moved on, the draft is taken away with the reason, and the list is back', async () => {
    let tell: (still: boolean | null) => void = () => {};
    const h = harness([row(), older], { stillWaitsWhen: new Promise((resolve) => { tell = resolve; }) });
    await h.open();
    await h.answer('yes');
    await h.answer('go', { row: T2 });
    expect(h.said()).toBe('Reply to Anna');
    tell(false);
    await settle();
    expect(h.said()).toBe('The thread has moved on since. This reply is no longer needed.');
    expect(h.store.proposal(older.id)!.state).toBe('answered');
    expect(h.did).toEqual([]);
    await h.answer('done');
    expect(h.said()).toBe('1 reply waits');
    expect(h.blocks().map((block) => (block as { id?: string }).id)).toEqual([T1]);
  });

  test('a mailbox that cannot say is not a reason to take a draft away', async () => {
    const h = harness([row(), older], { stillWaits: null });
    await h.open();
    await h.answer('yes');
    await h.answer('go', { row: T2 });
    expect(h.said()).toBe('Reply to Anna');
    expect(h.store.proposal(older.id)!.state).toBe('ready');
  });

  test('Esc on the line about them all, or on the list, turns nobody\'s reply down, and they wait in Home', async () => {
    const h = harness([row(), older]);
    await h.open();
    await h.answer('no');
    expect(h.store.ready().length).toBe(2);
    // Seen: out of the count, so that the next tap on the resting notch is the text field.
    expect(h.count()).toBe(0);
    expect(h.line()).toBeNull();
    // From Home's row: the list. Esc on it closes it.
    h.inbox.present('home', (stage) => h.mail.open(stage));
    await settle();
    expect(h.said()).toBe('2 replies wait');
    await h.answer('no');
    expect(h.store.ready().length).toBe(2);
    expect(h.line()).toBeNull();
  });

  test('Home has one row for them, and it opens the reply when one waits and the list when several do', async () => {
    const none = harness([]);
    expect(none.mail.homeRow()).toBeNull();
    const one = harness([row()]);
    one.inbox.present('home', (stage) => one.mail.open(stage));
    await settle();
    expect(one.said()).toBe('Reply to Leo');
    expect(one.line()).toMatchObject({ kind: 'sheet', yes: 'send', no: 'close' });
    // Opened from Home, it has been seen: it is not also in the count. Esc closes it, and it is kept.
    await one.answer('no');
    expect(one.count()).toBe(0);
    expect(one.store.proposal(row().id)!.state).toBe('ready');
    expect(one.line()).toBeNull();
    const two = harness([row(), older]);
    two.inbox.present('home', (stage) => two.mail.open(stage));
    await settle();
    expect(two.said()).toBe('2 replies wait');
  });

  test('a reply prepared after the others were seen is the only one in the count, and the only one its line is about', async () => {
    const h = harness([row()]);
    await h.arrive();
    await h.answer('fold');
    expect(h.count()).toBe(0);
    h.store.put(older);
    h.mail.sync();
    await settle();
    expect(h.count()).toBe(1);
    await h.open();
    expect(h.said()).toBe('You have not replied to Anna. I drafted a reply.');
    await h.answer('fold');
    expect(h.count()).toBe(0);
    expect(text((h.mail.homeRow() as { say: NotchPart[] }).say)).toBe('2 replies drafted, waiting for your word');
  });

  test('with one reply waiting the owner gets the line about it, not a list of one', async () => {
    const h = harness([row()]);
    await h.open();
    expect(h.said()).toBe('You have not replied to Leo. I drafted a reply.');
  });
});

describe('keeping the notch in line with the replies that wait', () => {
  test('mail leaves the count without a word when the last reply is answered elsewhere, and is back when one waits again', async () => {
    const h = harness([row()]);
    expect(h.count()).toBe(1);
    h.store.move(row().id, 'ready', 'answered', AT + 5);
    h.mail.sync();
    await settle();
    expect(h.count()).toBe(0);
    h.store.put(row({ id: mailProposalId(T2, AT), thread: T2 }));
    h.mail.sync();
    await settle();
    expect(h.count()).toBe(1);
    expect(h.line()).toBeNull();
  });

  test('a newer message in the same thread takes the place of the old reply: one reply per thread', async () => {
    const h = harness([row()]);
    h.store.move(row().id, 'ready', 'answered', AT + 5);
    h.store.put(row({ id: mailProposalId(T1, AT + 3_600_000), messageAt: AT + 3_600_000, draft: 'Hi Leo,\nSorry for the wait.\nSam', time: null }));
    h.mail.sync();
    await settle();
    expect(h.count()).toBe(1);
    await h.open();
    await h.answer('yes');
    expect((h.blocks()[0] as Extract<NotchBlock, { kind: 'paper' }>).lines.map(text)).toEqual(['Hi Leo,', 'Sorry for the wait.', 'Sam']);
  });

  test('a reply that is no longer an answer to the last word does not speak up by itself', async () => {
    // Nobody is waiting on the notch: the mailbox is asked first, and nothing is said and then taken back.
    const h = harness([row()], { stillWaits: false });
    await h.arrive();
    expect(h.asks.still).toBe(1);
    expect(h.line()).toBeNull();
    expect(h.did).toEqual([]);
  });

  test('when the owner came for it, it is not left on the notch either: they are told the thread moved on', async () => {
    const h = harness([row()], { stillWaits: false });
    await h.open();
    expect(h.said()).toBe('The thread has moved on since. This reply is no longer needed.');
    expect(h.store.proposal(row().id)!.state).toBe('answered');
    expect(h.did).toEqual([]);
    await h.answer('done');
    expect(h.count()).toBe(0);
    expect(h.mail.homeRow()).toBeNull();
  });

  test('after the last reply was sent from the notch, a new one is counted again', async () => {
    const h = harness([row()]);
    await h.open();
    await h.answer('yes');
    await h.answer('yes');
    await h.answer('done');
    await h.answer('done');
    expect(h.count()).toBe(0);
    h.store.put(row({ id: mailProposalId(T2, AT), thread: T2 }));
    h.mail.sync();
    await settle();
    expect(h.count()).toBe(1);
  });
});
