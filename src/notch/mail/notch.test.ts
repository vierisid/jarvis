/**
 * The mail line on the notch, with the real surface, inbox and store. The
 * mailbox and the watcher are stand-ins that say what was asked of them.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NotchInbox } from '../inbox.ts';
import type { NotchAnswerAct, NotchBlock, NotchLine, NotchPart, NotchToPage } from '../protocol.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface, type NotchSurfacePort } from '../surface.ts';
import { MAIL_WHY_DRAFT_THERE, type MailReplyPlan, type MailReplySession, type MailStep, type Mailbox } from './mailbox.ts';
import { MAIL_FUSE_MS, MAIL_STEER_KEYS_MS, MAIL_STEER_SAID_MS, attachNotchMail, mailDraftBlocks, mailSteer, mailToneFacts } from './notch.ts';
import type { MailCalendarEvent } from './proposer.ts';
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
  /** The page takes its time to write: the step answers when this does. */
  writeWhen?: Promise<void>;
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
  /** The calendar as it is when a time is about to be offered. Not given: no calendar can be asked. */
  calendar?: (from: number, to: number) => Promise<MailCalendarEvent[] | null>;
  /** What writing a reply again for the calendar as it is now gives. */
  redraftNow?: (before: MailProposalRow) => MailProposalRow | null;
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
    write: async () => ({ ok: true }),
    search: async () => [],
    reply: async (plan, work) => {
      plans.push(plan);
      const session: MailReplySession = {
        write: async () => { did.push('write'); await options.writeWhen; return options.steps?.write ?? { ok: true }; },
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
        if (change.tone === undefined && change.told === undefined && options.redraftNow) {
          const fresh = options.redraftNow(before);
          if (fresh) store.put(fresh);
          return fresh;
        }
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
    calendar: options.calendar,
    zone: 'UTC',
    now: () => AT + 10_000 + now,
    log: () => {},
  });
  const line = (): NotchLine | null => surface.current().line;
  return {
    mail, store, inbox, did, plans, redrafts, held, line, surface, asks,
    looks: () => looks,
    /** The time, as the mail layer reads it. */
    at: (): number => AT + 10_000 + now,
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
    // The owner's own words, or one of the commonest turns with one click.
    expect(missing.say.at(-1)).toEqual({ word: { name: 'told', value: 'tell me', options: ['say no', 'say yes', 'ask for more time'], label: 'Tell Pillow', free: true, long: true } });
  });

  test('what the owner told is shown, with the one word to change it', () => {
    const told = mailDraftBlocks(row({ told: 'Central European Time', missing: 'Whether Thursday still suits Leo.' }));
    expect(notes(told)).toEqual([
      'I did not know: Whether Thursday still suits Leo.',
      'You told me: Central European Time [change]',
      'Not sent yet. Tone [yours]',
    ]);
    // The owner, 17 November 2026: a proposal came, the draft said yes to it, and there was no way to
    // turn it round. A reply that Jarvis was sure of is the one that most needs a way in: the word
    // stands under every draft.
    const sure = mailDraftBlocks(row({ missing: '' }));
    expect(notes(sure)).toEqual(['Not what you would say? [tell me]', 'Not sent yet. Tone [yours]']);
    expect((sure[1] as Extract<NotchBlock, { kind: 'note' }>).say.at(-1)).toEqual({ word: { name: 'told', value: 'tell me', options: ['say no', 'say yes', 'ask for more time'], label: 'Tell Pillow', free: true, long: true } });
    // Once, not twice: with something missing, or something told, that line carries the word.
    for (const one of [mailDraftBlocks(row()), mailDraftBlocks(row({ told: 'say no', missing: '' }))]) {
      expect(one.map((block) => JSON.stringify(block)).join('').split('"name":"told"').length - 1).toBe(1);
    }
  });

  // The owner, 15 November 2026: "I've got no context on what the thread was about ... a very small summary".
  test('what the thread is comes first, above the reply, in one line', () => {
    const blocks = mailDraftBlocks(row({ about: 'Leo wants the deck before Thursday\'s call with Northwind.', missing: '' }));
    expect(blocks[0]).toEqual({ kind: 'note', say: ['Leo wants the deck before Thursday\'s call with Northwind.'] });
    expect(blocks[1]!.kind).toBe('paper');
    expect(notes(blocks)).toEqual(['Leo wants the deck before Thursday\'s call with Northwind.', 'Not what you would say? [tell me]', 'Not sent yet. Tone [yours]']);
    // One line it stays, whatever the model wrote.
    expect(text((mailDraftBlocks(row({ about: 'x'.repeat(400) }))[0] as { say: NotchPart[] }).say).length).toBeLessThanOrEqual(180);
    // None made: the paper is first, as before.
    expect(mailDraftBlocks(row())[0]!.kind).toBe('paper');
  });

  test('the empty lines of a reply are the gaps between its paragraphs, not paragraphs of their own', () => {
    const blocks = mailDraftBlocks(row({ draft: 'Hi Leo,\n\nThursday at 10:00 works for me.\n  \nSam', missing: '' }));
    expect((blocks[0] as Extract<NotchBlock, { kind: 'paper' }>).lines.map(text)).toEqual(['Hi Leo,', '[Thursday at 10:00] works for me.', 'Sam']);
  });

  test('a reply with no time has no lit word for one, and one with nothing missing says nothing of it', () => {
    const blocks = mailDraftBlocks(row({ time: null, missing: '' }));
    expect((blocks[0] as Extract<NotchBlock, { kind: 'paper' }>).lines.map(text)).toEqual(['Hi Leo,', 'Thursday at 10:00 works for me.', 'Sam']);
    expect(notes(blocks)).toEqual(['Not what you would say? [tell me]', 'Not sent yet. Tone [yours]']);
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

  // The hardening audit, 17 November 2026: a reply written into a thread that
  // already held a draft went out with the old words after it. Now it is not
  // written, and the draft that is there is somebody's: it is not thrown away.
  test('a thread that already holds a draft is left alone: nothing is written, nothing is thrown away', async () => {
    const h = harness([row()], { steps: { write: { ok: false, why: MAIL_WHY_DRAFT_THERE } } });
    await h.arrive();
    await h.answer('yes');
    await h.answer('yes');
    expect(h.did).toEqual(['write']);
    expect(h.said()).toBe('There is a draft in that thread already. I left it alone, and nothing was sent.');
    expect(h.store.proposal(row().id)!.state).toBe('ready');
  });

  // README 156. Esc while the reply was being put in the thread threw away whatever reply was open there.
  test('stopped while it is being put in a thread that holds a draft: that draft is not thrown away', async () => {
    let wrote!: () => void;
    const h = harness([row()], { steps: { write: { ok: false, why: MAIL_WHY_DRAFT_THERE } }, writeWhen: new Promise<void>((resolve) => { wrote = resolve; }) });
    await h.arrive();
    await h.answer('yes');
    await h.answer('yes');
    expect(h.said()).toBe('Putting it in the thread…');
    await h.answer('stop');
    wrote();
    await settle();
    expect(h.did).toEqual(['write']);
    expect(h.said()).toBe('Not sent. The draft that was in that thread is left as it was.');
    expect(h.store.proposal(row().id)!.state).toBe('ready');
  });

  test('when it cannot be sent, it says so and where the draft is, and is not called sent', async () => {
    const h = harness([row()], { steps: { send: { ok: false, why: 'no way to send was found', pressed: false } } });
    await h.arrive();
    await h.answer('yes');
    await h.answer('yes');
    await h.answer('done');
    expect(h.said()).toBe('I could not send it. It is in your Gmail drafts.');
    expect(h.did).toEqual(['write', 'send']);
    expect(h.store.proposal(row().id)!.state).toBe('ready');
  });

  // Send was pressed and Gmail said nothing in the time it was waited for. It was called "in your
  // Gmail drafts" without the thread being asked: a reply that had gone was offered again.
  test('Send was pressed and Gmail said nothing: the thread is asked, and a reply it shows is sent', async () => {
    const h = harness([row()], { steps: { send: { ok: false, why: 'Gmail did not say it was sent', pressed: true } }, sent: [true] });
    await h.arrive();
    await h.answer('yes');
    await h.answer('yes');
    await h.answer('done');
    expect(h.did).toEqual(['write', 'send', 'sent?']);
    expect(h.said()).toBe('Sent to Leo.');
    expect(h.store.proposal(row().id)!.state).toBe('sent');
  });

  test('Send was pressed, Gmail said nothing and the thread does not show it: not called sent, and not called a draft', async () => {
    for (const shows of [false, null]) {
      const h = harness([row()], { steps: { send: { ok: false, why: 'Gmail did not say it was sent', pressed: true } }, sent: [shows] });
      await h.arrive();
      await h.answer('yes');
      await h.answer('yes');
      await h.answer('done');
      await h.advance(1500);
      expect(h.said()).toBe('I pressed Send, and nothing says it went. Look in the thread before sending it again.');
      expect(h.store.proposal(row().id)!.state).toBe('ready');
    }
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

// The prototype: "Anna asked to move Thursday. Offer a slot?" with three free times, and a pick sends it.
describe('a reply that offers a time, with free times from the calendar', () => {
  const HOUR = 3_600_000;
  // It is Saturday 14 November, a little after 9:00 UTC.
  const slots = [
    { at: Date.UTC(2026, 10, 16, 15, 0), minutes: 30, words: 'Monday at 15:00' },
    { at: Date.UTC(2026, 10, 17, 10, 0), minutes: 30, words: 'Tuesday at 10:00' },
    { at: Date.UTC(2026, 10, 18, 9, 30), minutes: 30, words: 'Wednesday at 9:30' },
  ];
  const offers = (extra: Partial<MailProposalRow> = {}): MailProposalRow =>
    row({ draft: 'Hi Leo,\nMonday at 15:00 would suit me.\nSam', time: 'Monday at 15:00', missing: '', slots, asked: 'to move Thursday', ...extra });
  const keys = (h: ReturnType<typeof harness>): string[] | undefined => { const shown = h.line(); return shown?.kind === 'offer' ? shown.options : undefined; };

  test('the line says who asked for what, and has the free times as its keys', async () => {
    const h = harness([offers()]);
    await h.arrive();
    expect(h.line()).toMatchObject({ kind: 'offer', src: 'mail', unasked: true });
    expect(h.said()).toBe('Leo asked to move Thursday. Offer a slot?');
    expect(keys(h)).toEqual(['Monday at 15:00', 'Tuesday at 10:00', 'Wednesday at 9:30']);
    expect(h.did).toEqual([]);
  });

  test('a time offered from the line asks nothing about a tone: the draft was never opened', async () => {
    const h = harness([offers({ tone: 'shorter' })]);
    await h.arrive();
    await h.answer('pick', { option: 'Tuesday at 10:00' });
    await h.answer('done');
    expect(h.said()).toBe('Offered Tuesday at 10:00 to Leo.');
    await h.answer('done');
    expect(h.line()).toBeNull();
  });

  test('a pick puts that time into the reply and sends it, with the fuse, and says what was offered', async () => {
    const h = harness([offers()]);
    await h.arrive();
    await h.answer('pick', { option: 'Tuesday at 10:00' });
    expect(h.plans).toEqual([{ thread: T1, to: ['leo@lumen.example'], cc: ['anna@lumen.example'], text: 'Hi Leo,\nTuesday at 10:00 would suit me.\nSam' }]);
    expect(h.did).toEqual(['write']);
    expect(h.line()).toMatchObject({ kind: 'send', ms: MAIL_FUSE_MS });
    expect(h.said()).toBe('Offering Tuesday at 10:00 to Leo…');
    await h.answer('done');
    expect(h.did).toEqual(['write', 'send', 'sent?']);
    expect(h.said()).toBe('Offered Tuesday at 10:00 to Leo.');
    expect(h.store.proposal(row().id)).toMatchObject({ state: 'sent', time: 'Tuesday at 10:00', draft: 'Hi Leo,\nTuesday at 10:00 would suit me.\nSam' });
    await h.answer('done');
    expect(h.line()).toBeNull();
  });

  test('the first time is the one the reply names already: it goes as it was written', async () => {
    const h = harness([offers()]);
    await h.arrive();
    await h.answer('pick', { option: 'Monday at 15:00' });
    expect(h.plans[0]!.text).toBe('Hi Leo,\nMonday at 15:00 would suit me.\nSam');
    expect(h.said()).toBe('Offering Monday at 15:00 to Leo…');
  });

  test('the keys are the notch\'s words, the letter keeps its own language', async () => {
    const italian = slots.map((slot, at) => ({ ...slot, words: ['lunedì alle 15:00', 'martedì alle 10:00', 'mercoledì alle 9:30'][at]! }));
    const h = harness([offers({ draft: 'Ciao Leo,\nlunedì alle 15:00 andrebbe bene.\nSam', time: 'lunedì alle 15:00', slots: italian })]);
    await h.arrive();
    expect(keys(h)).toEqual(['Monday at 15:00', 'Tuesday at 10:00', 'Wednesday at 9:30']);
    await h.answer('pick', { option: 'Wednesday at 9:30' });
    expect(h.plans[0]!.text).toBe('Ciao Leo,\nmercoledì alle 9:30 andrebbe bene.\nSam');
    expect(h.said()).toBe('Offering Wednesday at 9:30 to Leo…');
  });

  test('outside Gmail the line names its source, and without the words for what was asked it says "for a time"', async () => {
    const h = harness([offers({ asked: '' })], { inGmail: () => false });
    h.mail.speak();
    await settle();
    expect(h.said()).toBe('In Gmail: Leo asked for a time. Offer a slot?');
  });

  test('Esc on the line is a no; left alone it waits', async () => {
    const no = harness([offers()]);
    await no.arrive();
    await no.answer('no');
    expect(no.store.proposal(row().id)!.state).toBe('declined');
    expect(no.did).toEqual([]);

    const left = harness([offers()]);
    await left.arrive();
    await left.answer('fold');
    expect(left.store.proposal(row().id)!.state).toBe('ready');
    expect(text((left.mail.homeRow() as { say: NotchPart[] }).say)).toBe('Reply to Leo is drafted');
  });

  test('Esc while the fuse burns takes the offer back: nothing is sent and no draft is left', async () => {
    const h = harness([offers()]);
    await h.arrive();
    await h.answer('pick', { option: 'Tuesday at 10:00' });
    await h.answer('undo');
    expect(h.did).toEqual(['write', 'discard']);
    expect(h.said()).toBe('Not sent. No draft is left in Gmail.');
    expect(h.store.proposal(row().id)!.state).toBe('ready');
  });

  test('a time that was taken since is not offered: the calendar is asked at the pick, and the others are still there', async () => {
    const asked: [number, number][] = [];
    const h = harness([offers()], { calendar: async (from, to) => { asked.push([from, to]); return [{ summary: 'Board call', start: '2026-11-17T10:00:00Z', end: '2026-11-17T11:00:00Z' }]; } });
    await h.arrive();
    await h.answer('pick', { option: 'Tuesday at 10:00' });
    // Asked for the hours round that time, not for the month.
    expect(asked).toEqual([[Date.UTC(2026, 10, 17, 9, 0), Date.UTC(2026, 10, 17, 11, 30)]]);
    expect(h.did).toEqual([]);
    expect(h.said()).toBe('Tuesday at 10:00 has been taken since. Another?');
    expect(keys(h)).toEqual(['Monday at 15:00', 'Wednesday at 9:30']);
    await h.answer('pick', { option: 'Wednesday at 9:30' });
    expect(h.plans[0]!.text).toBe('Hi Leo,\nWednesday at 9:30 would suit me.\nSam');
    expect(h.said()).toBe('Offering Wednesday at 9:30 to Leo…');
  });

  test('when none of them is free any more it says so, and the reply is kept', async () => {
    const h = harness([offers()], { calendar: async () => [{ summary: 'Away', start: '2026-11-16T00:00:00Z', end: '2026-11-19T00:00:00Z' }] });
    await h.arrive();
    await h.answer('pick', { option: 'Monday at 15:00' });
    await h.answer('pick', { option: 'Tuesday at 10:00' });
    expect(keys(h)).toEqual(['Wednesday at 9:30']);
    await h.answer('pick', { option: 'Wednesday at 9:30' });
    expect(h.said()).toBe('None of those times is free any more. The reply is kept.');
    expect(h.did).toEqual([]);
    expect(h.store.proposal(row().id)!.state).toBe('ready');
  });

  test('a calendar that cannot be reached is not a reason to hold the offer back', async () => {
    for (const calendar of [async () => null, async () => { throw new Error('signed out'); }]) {
      const h = harness([offers()], { calendar });
      await h.arrive();
      await h.answer('pick', { option: 'Tuesday at 10:00' });
      expect(h.said()).toBe('Offering Tuesday at 10:00 to Leo…');
    }
  });

  test('a time that has come too close is not on the keys any more', async () => {
    const h = harness([offers()]);
    // Monday, 13:30: Monday at 15:00 is less than two hours away.
    await h.advance(2 * 24 * HOUR + 4.5 * HOUR);
    await h.arrive();
    expect(h.said()).toBe('Leo asked to move Thursday. Offer a slot?');
    expect(keys(h)).toEqual(['Tuesday at 10:00', 'Wednesday at 9:30']);
    await h.answer('pick', { option: 'Tuesday at 10:00' });
    expect(h.plans[0]!.text).toBe('Hi Leo,\nTuesday at 10:00 would suit me.\nSam');
  });

  test('when its times have passed the reply is written again for the calendar as it is, before the line', async () => {
    const later = [
      { at: Date.UTC(2026, 10, 19, 15, 0), minutes: 30, words: 'Thursday at 15:00' },
      { at: Date.UTC(2026, 10, 20, 10, 0), minutes: 30, words: 'Friday at 10:00' },
    ];
    const h = harness([offers()], { redraftNow: (before) => ({ ...before, draft: 'Hi Leo,\nThursday at 15:00 would suit me.\nSam', time: 'Thursday at 15:00', slots: later }) });
    // Wednesday: Monday and Tuesday are gone, and Wednesday at 9:30 with them.
    await h.advance(4 * 24 * HOUR);
    await h.arrive();
    expect(h.redrafts).toEqual([[row().id, {}]]);
    expect(h.said()).toBe('Leo asked to move Thursday. Offer a slot?');
    expect(keys(h)).toEqual(['Thursday at 15:00', 'Friday at 10:00']);
  });

  test('when it cannot be written again, it is the plain line, and the draft behind it', async () => {
    const h = harness([offers()], { redraftNow: () => null });
    await h.advance(4 * 24 * HOUR);
    await h.arrive();
    expect(h.said()).toBe('You have not replied to Leo. I drafted a reply.');
    await h.answer('yes');
    expect(h.said()).toBe('Reply to Leo');
  });

  test('a reply that does not name its time once has the plain line: another time could not take its place', async () => {
    for (const draft of ['Hi Leo,\nMonday at 15:00, I repeat, Monday at 15:00.\nSam', 'Hi Leo,\nSome time on Monday.\nSam']) {
      const h = harness([offers({ draft })]);
      await h.arrive();
      expect(h.said()).toBe('You have not replied to Leo. I drafted a reply.');
    }
    // And one that offers a single time is a reply like any other.
    const one = harness([offers({ slots: slots.slice(0, 1) })]);
    await one.arrive();
    expect(one.said()).toBe('You have not replied to Leo. I drafted a reply.');
  });

  // The prototype: "Friday at ten works", said over the line.
  test('a time said with the talk keys over the line picks it, and it is sent as a press would send it', async () => {
    const h = harness([offers()]);
    await h.arrive();
    expect(h.said()).toBe('Leo asked to move Thursday. Offer a slot?');
    // Nothing is routed while the line is still up: the keys have not taken it off.
    expect(h.mail.route('Tuesday at ten works', { source: 'spoken', at: h.at() })).toBeNull();
    // The talk keys take the notch.
    const keys = h.at();
    h.inbox.add({ id: 'talk', subject: 'talk', class: 'person', speaks: true, urgent: true, asked: true, once: true, title: () => ['Listening'], play: async (stage) => { await stage.offer(['Listening'], 'ok'); return 'settled'; } });
    await settle();
    const route = h.mail.route('Tuesday at ten works', { source: 'spoken', at: keys });
    expect(route?.did).toBe('Offer Tuesday at 10:00.');
    expect(h.did).toEqual([]);
    await h.answer('yes');
    route!.run();
    await settle();
    expect(h.plans[0]!.text).toBe('Hi Leo,\nTuesday at 10:00 would suit me.\nSam');
    expect(h.said()).toBe('Offering Tuesday at 10:00 to Leo…');
    await h.answer('done');
    expect(h.said()).toBe('Offered Tuesday at 10:00 to Leo.');
    expect(h.store.proposal(row().id)!.state).toBe('sent');
    // Once: said again, it picks nothing.
    expect(h.mail.route('Monday at three', { source: 'spoken', at: keys })).toBeNull();
  });

  test('what is said over the line that names none of its times is not a pick, and neither is anything typed or said later', async () => {
    const h = harness([offers()]);
    await h.arrive();
    const keys = h.at();
    h.inbox.add({ id: 'talk', subject: 'talk', class: 'person', speaks: true, urgent: true, asked: true, once: true, title: () => ['Listening'], play: async (stage) => { await stage.offer(['Listening'], 'ok'); return 'settled'; } });
    await settle();
    expect(h.mail.route('Friday at eleven', { source: 'spoken', at: keys })).toBeNull();
    expect(h.mail.route('open the Tuesday report', { source: 'spoken', at: keys })).toBeNull();
    expect(h.mail.route('Tuesday at ten', { source: 'typed', at: keys })).toBeNull();
    expect(h.mail.route('Tuesday at ten')).toBeNull();
    // Keys that went down well after the line had left.
    expect(h.mail.route('Tuesday at ten', { source: 'spoken', at: keys + MAIL_STEER_KEYS_MS + 1 })).toBeNull();
    expect(h.mail.route('Tuesday at ten', { source: 'spoken', at: keys })).not.toBeNull();
    // And not for ever.
    await h.advance(MAIL_STEER_SAID_MS);
    expect(h.mail.route('Tuesday at ten', { source: 'spoken', at: keys })).toBeNull();
  });

  test('a time picked by voice is asked of the calendar like any other, and one taken since brings the line back with the rest', async () => {
    const h = harness([offers()], { calendar: async () => [{ summary: 'Board call', start: '2026-11-17T10:00:00Z', end: '2026-11-17T11:00:00Z' }] });
    await h.arrive();
    const keys = h.at();
    h.inbox.add({ id: 'talk', subject: 'talk', class: 'person', speaks: true, urgent: true, asked: true, once: true, title: () => ['Listening'], play: async (stage) => { await stage.offer(['Listening'], 'ok'); return 'settled'; } });
    await settle();
    const route = h.mail.route('Tuesday at ten', { source: 'spoken', at: keys });
    await h.answer('yes');
    route!.run();
    await settle();
    expect(h.did).toEqual([]);
    expect(h.said()).toBe('Tuesday at 10:00 has been taken since. Another?');
  });

  test('on the draft, the time is a word with the free times as its choices, and a choice changes the letter', async () => {
    const paper = mailDraftBlocks(offers())[0] as Extract<NotchBlock, { kind: 'paper' }>;
    expect(paper.lines[1]![1]).toEqual({ word: { name: 'when', value: 'Monday at 15:00', options: ['Monday at 15:00', 'Tuesday at 10:00', 'Wednesday at 9:30'], label: 'Time', read: 'dayTime' } });
    // Opened from Home, the draft is what is shown: the reply can be read before anything goes.
    const h = harness([offers()]);
    h.inbox.present('home', (stage) => h.mail.open(stage));
    await settle();
    expect(h.said()).toBe('Reply to Leo');
    await h.answer('word', { word: 'when', value: 'Wednesday at 9:30' });
    expect(h.store.proposal(row().id)).toMatchObject({ time: 'Wednesday at 9:30', draft: 'Hi Leo,\nWednesday at 9:30 would suit me.\nSam' });
    // The other times are still its choices.
    const again = (h.blocks()[0] as Extract<NotchBlock, { kind: 'paper' }>).lines[1]![1];
    expect(again).toMatchObject({ word: { value: 'Wednesday at 9:30', options: ['Monday at 15:00', 'Tuesday at 10:00', 'Wednesday at 9:30'] } });
    await h.answer('yes');
    expect(h.plans[0]!.text).toBe('Hi Leo,\nWednesday at 9:30 would suit me.\nSam');
    // Sent from the draft, it is a reply that was sent: the line is the usual one.
    expect(h.said()).toBe('Sending to Leo…');
  });

  test('a time of the owner\'s own, typed on the draft, takes the free times off the keys: the letter no longer names one of them', async () => {
    const typed = harness([offers()]);
    typed.inbox.present('home', (stage) => typed.mail.open(stage));
    await settle();
    await typed.answer('word', { word: 'when', value: 'Friday at 16:00' });
    const kept = typed.store.proposal(row().id)!;
    expect(kept).toMatchObject({ time: 'Friday at 16:00', draft: 'Hi Leo,\nFriday at 16:00 would suit me.\nSam' });
    // A reply in that state, when it speaks up: the plain line, and the draft behind it.
    const h = harness([kept]);
    await h.arrive();
    expect(h.said()).toBe('You have not replied to Leo. I drafted a reply.');
  });
});

// The prototype: after a reply went in a tone the owner chose, "Always use a short tone with Marco?"
describe('a manner the owner chose becomes how that person is written to', () => {
  /** A reply goes out in the tone the owner turned its draft to. */
  const sentIn = async (h: ReturnType<typeof harness>, tone: string | null): Promise<void> => {
    await h.arrive();
    await h.answer('yes');
    if (tone) await h.answer('word', { word: 'tone', value: tone });
    await h.answer('yes');
    await h.answer('done');
    expect(h.said()).toBe('Sent to Leo.');
    await h.answer('done');
  };

  test('after the reply went it asks once, and a yes is kept for that person', async () => {
    const h = harness([row()]);
    await sentIn(h, 'shorter');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'yes', src: 'mail' });
    expect(h.said()).toBe('Always use a short tone with Leo?');
    expect(h.store.tone(leo.address)).toBe('');
    await h.answer('yes');
    expect(h.said()).toBe('Remembered.');
    expect(h.store.tone(leo.address)).toBe('shorter');
    expect(h.store.tones()).toMatchObject([{ address: 'leo@lumen.example', name: 'Leo Bianchi', tone: 'shorter' }]);
    await h.answer('done');
    expect(h.line()).toBeNull();
    // The reply itself went before the question, and is sent whatever is answered.
    expect(h.store.proposal(row().id)!.state).toBe('sent');
  });

  test('each manner has its own word in the question', async () => {
    const h = harness([row()]);
    await sentIn(h, 'warmer');
    expect(h.said()).toBe('Always use a warm tone with Leo?');
  });

  test('a no is not asked again for that person and that manner; left alone, it may be asked the next time', async () => {
    const no = harness([row()]);
    await sentIn(no, 'shorter');
    await no.answer('no');
    expect(no.store.tone(leo.address)).toBe('');
    expect(no.store.toneAsked(leo.address)).toBe('shorter');
    // The next reply to Leo that goes shorter: no question.
    const later = row({ id: mailProposalId(T2, AT + 5000), thread: T2, messageAt: AT + 5000 });
    no.store.put(later);
    no.mail.sync();
    await sentIn(no, 'shorter');
    expect(no.line()).toBeNull();

    const left = harness([row()]);
    await sentIn(left, 'shorter');
    await left.answer('fold');
    expect(left.store.toneAsked(leo.address)).toBe('');
  });

  test('a reply that went as the owner writes, or in the manner that already stands, asks nothing', async () => {
    const own = harness([row()]);
    await sentIn(own, null);
    expect(own.line()).toBeNull();
    // Prepared in the manner that stands for Leo, and sent as it was.
    const stands = harness([row({ tone: 'shorter' })]);
    stands.store.setTone(leo, 'shorter', AT);
    await sentIn(stands, null);
    expect(stands.line()).toBeNull();
    // Turned to another manner on its draft: that one is asked about, and takes the place of the first.
    const other = harness([row({ tone: 'shorter' })]);
    other.store.setTone(leo, 'shorter', AT);
    await sentIn(other, 'warmer');
    expect(other.said()).toBe('Always use a warm tone with Leo?');
    await other.answer('yes');
    expect(other.store.tone(leo.address)).toBe('more warmly');
  });

  test('how people are written to stands in Memory, each as one thing that can be forgotten', () => {
    const tones = [
      { address: 'leo@lumen.example', name: 'Leo Bianchi', tone: 'shorter', at: 2 },
      { address: 'anna@lumen.example', name: '', tone: 'more formally', at: 1 },
      { address: 'x@lumen.example', name: 'X', tone: 'like a pirate', at: 0 },
    ];
    expect(mailToneFacts(tones)).toEqual([
      { id: 'tone:leo@lumen.example', about: 'Leo Bianchi', text: 'gets short replies', source: 'you said so on the notch' },
      { id: 'tone:anna@lumen.example', about: 'anna@lumen.example', text: 'gets formal replies', source: 'you said so on the notch' },
    ]);
    expect(mailToneFacts(tones, 'leo').map((one) => one.id)).toEqual(['tone:leo@lumen.example']);
    expect(mailToneFacts(tones, ' ANNA ').map((one) => one.id)).toEqual(['tone:anna@lumen.example']);
    expect(mailToneFacts(tones, 'sam')).toEqual([]);
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
    expect(h.said()).toBe('I cannot see your mail right now. My own browser may not be signed in to Gmail.');
  });

  test('when the mail cannot be seen, that is what it says', async () => {
    const h = harness([], { look: { through: null, listed: 0, read: 0, asked: 0, prepared: 0, overtaken: 0 } });
    await h.arrive();
    expect(h.said()).toBe('I cannot see your mail right now. My own browser may not be signed in to Gmail.');
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
    // Both are dealt with, and the round they were opened in ends on its last word.
    expect(h.said()).toBe('That is everything.');
    await h.answer('done');
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
    // (This inbox is not told of Home. In the product, replies that wait there keep the round from saying it was everything.)
    if (h.line()) await h.answer('done');
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

// The owner, 17 November 2026: "I received like a proposal by email, and I
// don't want to accept that proposal, but the draft was a draft that would
// accept the proposal. So I want a way for me to steer the draft, and that's
// very important."
describe('the owner steers what a reply says', () => {
  /** A reply Jarvis was sure of: nothing missing, nothing told. It says yes. */
  const sure = (): MailProposalRow => row({ missing: '', time: null, draft: 'Hi Leo,\nHappy to go ahead with the proposal.\nSam' });
  /**
   * Something else takes the notch, as the talk keys do: the draft goes back
   * to waiting. Comes back with how the words then said came: spoken, with
   * the keys that went down at that moment.
   */
  const takenAway = async (h: ReturnType<typeof harness>): Promise<{ source: 'spoken'; at: number }> => {
    const keys = { source: 'spoken' as const, at: h.at() };
    h.inbox.add({
      id: 'talk', subject: 'talk', class: 'person', speaks: true, urgent: true, once: true, asked: true,
      title: () => ['Listening'],
      play: async (stage) => { await stage.say(['Listening'], 800); return 'settled'; },
    });
    await h.advance(4000);
    return keys;
  };

  test('one click turns it round: "say no" writes the reply again as a no, and that is what is sent', async () => {
    const h = harness([sure()]);
    await h.arrive();
    await h.answer('yes');
    expect(notes(h.blocks())).toEqual(['Not what you would say? [tell me]', 'Not sent yet. Tone [yours]']);
    await h.answer('word', { word: 'told', value: 'say no' });
    expect(h.redrafts).toEqual([[sure().id, { told: 'say no' }]]);
    expect(notes(h.blocks())).toEqual(['You told me: say no [change]', 'Not sent yet. Tone [yours]']);
    expect((h.blocks()[0] as Extract<NotchBlock, { kind: 'paper' }>).lines.map(text)).toEqual(['Hi Leo,', 'say no.', 'Sam']);
    // Turned again, in their own words this time.
    await h.answer('word', { word: 'told', value: 'Decline, but ask to talk again in January' });
    expect(h.redrafts.at(-1)).toEqual([sure().id, { told: 'Decline, but ask to talk again in January' }]);
    await h.answer('yes');
    expect(h.plans[0]!.text).toBe('Hi Leo,\nDecline, but ask to talk again in January.\nSam');
  });

  test('said with the talk keys while the draft is open: it is written again with that, and comes back up', async () => {
    const h = harness([sure()]);
    await h.arrive();
    await h.answer('yes');
    expect(h.said()).toBe('Reply to Leo');
    // The keys are held: the draft leaves the notch for the listening.
    const keys = await takenAway(h);
    const route = h.mail.route('Decline it, we are full until January.', keys);
    expect(route?.did).toBe('Write the reply again, as told.');
    // Routing changes nothing by itself: it is asked twice for one sentence.
    expect(h.redrafts).toEqual([]);
    route!.run();
    await h.advance(0);
    expect(h.redrafts).toEqual([[sure().id, { told: 'Decline it, we are full until January.' }]]);
    // The draft is back, written again, and says what it was told.
    expect(h.said()).toBe('Reply to Leo');
    expect(notes(h.blocks())).toEqual(['You told me: Decline it, we are full until January. [change]', 'Not sent yet. Tone [yours]']);
    // Nothing was sent by saying it.
    expect(h.plans).toEqual([]);
    await h.answer('yes');
    expect(h.plans[0]!.text).toBe('Hi Leo,\nDecline it, we are full until January..\nSam');
  });

  test('what is said is about the draft only while it is open, or was a moment ago', async () => {
    const h = harness([sure()]);
    // No draft is open: the same words are an instruction like any other.
    expect(h.mail.route('Decline it, we are full until January')).toBeNull();
    await h.arrive();
    // The line that offers the draft is not the draft.
    expect(h.mail.route('Decline it')).toBeNull();
    await h.answer('yes');
    // Open: it is.
    expect(h.mail.route('Decline it')).not.toBeNull();
    const keys = await takenAway(h);
    await h.advance(MAIL_STEER_SAID_MS - 10_000);
    expect(h.mail.route('Decline it', keys)).not.toBeNull();
    await h.advance(20_000);
    // Long after: it is not.
    expect(h.mail.route('Decline it', keys)).toBeNull();
  });

  // The hardening audit, 17 November 2026: for 45 seconds after a draft left
  // the notch, anything said or typed was taken as what that reply should
  // say. "Open the Q3 deck" never opened the deck.
  test('a draft that left the notch is meant only by what was said with the keys that took it off', async () => {
    const h = harness([sure()]);
    await h.arrive();
    await h.answer('yes');
    const keys = await takenAway(h);
    // Typed a moment later: an instruction like any other.
    expect(h.mail.route('Open the Q3 deck', { source: 'typed', at: h.at() })).toBeNull();
    // Said with keys that went down well after the draft had gone: the same.
    expect(h.mail.route('Open the Q3 deck', { source: 'spoken', at: h.at() + MAIL_STEER_KEYS_MS + 1 })).toBeNull();
    // Nothing known about how the words came: not taken.
    expect(h.mail.route('Open the Q3 deck')).toBeNull();
    // Said with the keys that took it off: what the reply is to say.
    expect(h.mail.route('Decline it', keys)).not.toBeNull();
  });

  test('a draft the owner closed, sent or turned down is in hand no more', async () => {
    const closed = harness([sure()]);
    await closed.arrive();
    await closed.answer('yes');
    await closed.answer('no');
    expect(closed.mail.route('Decline it')).toBeNull();

    const sent = harness([sure()]);
    await sent.arrive();
    await sent.answer('yes');
    await sent.answer('yes');
    await sent.advance(MAIL_FUSE_MS + 3000);
    expect(sent.mail.route('Decline it')).toBeNull();
  });

  test('a question is not what a reply is to say, and neither is a bare yes or no', () => {
    for (const steer of ['Decline it', 'say no, politely', 'Tell him we are full until January', 'make it shorter and ask for the price', 'accept, but only from March', 'no thanks, not this year']) {
      expect(mailSteer(steer)).toBe(true);
    }
    for (const not of ['What did he ask for?', 'who is Leo', 'How much was it', 'Is this the proposal from Lumen', 'yes', 'No.', 'ok', 'send it', 'stop', 'never mind', 'thanks', '', '   ']) {
      expect(mailSteer(not)).toBe(false);
    }
  });

  test('when it cannot be written again, the reply stays as it was and says so', async () => {
    const h = harness([sure()]);
    await h.arrive();
    await h.answer('yes');
    await h.answer('word', { word: 'told', value: 'cannot be written' });
    expect(notes(h.blocks())).toEqual(['Not what you would say? [tell me]', 'I could not write it again. This is the reply as it was. Tone [yours]']);
    expect((h.blocks()[0] as Extract<NotchBlock, { kind: 'paper' }>).lines.map(text)).toEqual(['Hi Leo,', 'Happy to go ahead with the proposal.', 'Sam']);
  });
});
