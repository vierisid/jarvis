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
  draft: 'Hi Leo,\nThursday at 10:00 works for me.\nSam', time: 'Thursday at 10:00', missing: 'The deck itself.', lookFor: '', found: null, tone: '',
  model: 'm', tokensIn: 1200, tokensOut: 80, createdAt: AT + 1, updatedAt: AT + 1, sentAt: null, ...extra,
});

const settle = async (): Promise<void> => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | undefined): string => (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : 'word' in part ? `[${part.word.value}]` : '')).join('');

function harness(rows: MailProposalRow[], options: {
  steps?: Partial<Record<'write' | 'send' | 'discard', MailStep>>;
  sent?: (boolean | null)[];
  stillWaits?: boolean | null;
  /** Read at each asking: so that a test can change the answer while a line is up. */
  stillWaitsFrom?: (boolean | null)[];
  noMailbox?: boolean;
  look?: MailLook | null;
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
  const redrafts: [string, string][] = [];
  const held: string[] = [];
  let looks = 0;
  const mail = attachNotchMail(inbox, {
    store,
    watch: {
      hold: (id) => { held.push(`hold ${id}`); },
      release: (id) => { held.push(`release ${id}`); },
      redraft: async (id, tone) => {
        redrafts.push([id, tone]);
        const before = store.proposal(id)!;
        if (tone === 'more formally') return null;
        const next = { ...before, draft: 'Thursday 10 works. Sam', time: null, tone };
        store.put(next);
        return next;
      },
      stillWaits: async () => (options.stillWaitsFrom ? options.stillWaitsFrom[0]! : options.stillWaits === undefined ? true : options.stillWaits),
      look: async () => { looks++; return options.look ?? { through: 'browser', listed: 1, read: 0, asked: 0, prepared: 0, overtaken: 0 }; },
      lastLook: () => null,
    },
    mailbox: () => (options.noMailbox ? null : mailbox),
    now: () => AT + 10_000 + now,
    log: () => {},
  });
  const line = (): NotchLine | null => surface.current().line;
  return {
    mail, store, inbox, did, plans, redrafts, held, line, surface,
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
    expect(blocks.slice(1).map((block) => text((block as { say: NotchPart[] }).say))).toEqual([
      'I did not know: The deck itself.',
      'Found in your Drive: Lumen deck v3',
      'Not sent yet. Tone [yours]',
    ]);
  });

  test('a reply with no time has no lit word, and one with nothing missing says nothing of it', () => {
    const blocks = mailDraftBlocks(row({ time: null, missing: '' }));
    expect((blocks[0] as Extract<NotchBlock, { kind: 'paper' }>).lines.map(text)).toEqual(['Hi Leo,', 'Thursday at 10:00 works for me.', 'Sam']);
    expect(blocks.length).toBe(2);
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
    expect(h.store.proposal(row().id)!.state).toBe('ready');
    expect(h.count()).toBe(1);
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
    await onDraft.answer('no');
    expect(onDraft.store.proposal(row().id)!.state).toBe('declined');
    expect(onDraft.did).toEqual([]);
  });

  test('left alone it folds and waits: not now is not no', async () => {
    const h = harness([row()]);
    await h.arrive();
    await h.answer('fold');
    expect(h.store.proposal(row().id)!.state).toBe('ready');
    expect(h.count()).toBe(1);
  });

  test('a new tone is a new letter: it is written again, and that is what is sent', async () => {
    const h = harness([row()]);
    await h.arrive();
    await h.answer('yes');
    await h.answer('word', { word: 'tone', value: 'shorter' });
    expect(h.redrafts).toEqual([[row().id, 'shorter']]);
    expect((h.blocks()[0] as Extract<NotchBlock, { kind: 'paper' }>).lines.map(text)).toEqual(['Thursday 10 works. Sam']);
    expect(text((h.blocks().at(-1) as { say: NotchPart[] }).say)).toBe('Not sent yet. Tone [shorter]');
    await h.answer('yes');
    expect(h.plans[0]!.text).toBe('Thursday 10 works. Sam');
  });

  test('a tone that could not be written leaves the reply as it was, and says so', async () => {
    const h = harness([row()]);
    await h.arrive();
    await h.answer('yes');
    await h.answer('word', { word: 'tone', value: 'more formal' });
    expect(text((h.blocks().at(-1) as { say: NotchPart[] }).say)).toBe('I could not write it again. This is the reply as it was. Tone [yours]');
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
    expect(h.count()).toBe(2);
    await h.arrive();
    expect(h.said()).toBe('You have not replied to Leo. I drafted a reply.');
    const shown = h.line()!.id;
    await h.arrive();
    expect(h.line()!.id).toBe(shown);
    await h.answer('fold');
    await h.arrive();
    expect(h.said()).toBe('You have not replied to Anna. I drafted a reply.');
    await h.answer('fold');
    await h.arrive();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(2);
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

  test('when the mail cannot be seen, that is what it says', async () => {
    const h = harness([], { look: { through: null, listed: 0, read: 0, asked: 0, prepared: 0, overtaken: 0 } });
    await h.arrive();
    expect(h.said()).toBe('I cannot see your mail right now. Jarvis\'s own browser may not be signed in to Gmail.');
  });
});

describe('keeping the notch in line with the replies that wait', () => {
  test('a reply whose thread moved on leaves the count without a word, and a new one joins it', async () => {
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

  test('a newer message in the same thread takes the place of the old reply: one item per thread', async () => {
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

  test('a reply that is no longer an answer to the last word is not shown when its turn comes', async () => {
    const h = harness([row()], { stillWaits: false });
    await h.open();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
  });
});
