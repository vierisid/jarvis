import { describe, expect, test } from 'bun:test';
import { mailFirstName, mailPerson, threadAsOf, type MailMessage, type MailThread } from './thread.ts';
import { MAIL_WAIT_MAX_MS, MAIL_WAIT_MIN_MS, mailMachine, mailReplyTo, mailShared, mailWaiting } from './waiting.ts';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 14, 9, 0);
const me = mailPerson('Sam Rossi', 'sam@northwind.example');
const owner = new Set([me.address, 'sam.rossi@gmail.example']);
const leo = mailPerson('Leo Bianchi', 'leo@lumen.example');
const anna = mailPerson('Anna Conti', 'anna@lumen.example');

const message = (from = leo, hoursAgo = 24, extra: Partial<MailMessage> = {}): MailMessage =>
  ({ from, to: [from === me ? leo : me], cc: [], at: NOW - hoursAgo * HOUR, text: 'Does Thursday work?', ...extra });
const thread = (messages: MailMessage[], extra: Partial<MailThread> = {}): MailThread =>
  ({ id: 't1', subject: 'Deck for Thursday?', messages, ...extra });

describe('a person is waiting', () => {
  test('when they wrote last, to the owner, a while ago', () => {
    const waiting = mailWaiting(thread([message(leo, 24)]), owner, NOW);
    expect(waiting).toMatchObject({ waits: true, who: leo, since: NOW - 24 * HOUR });
  });

  test('not when the owner wrote last, from any of their addresses', () => {
    expect(mailWaiting(thread([message(leo, 30), message(me, 24)]), owner, NOW)).toEqual({ waits: false, why: 'owner-last' });
    const other = mailPerson('Sam', 'Sam.Rossi@gmail.example');
    expect(mailWaiting(thread([message(leo, 30), message(other, 24)]), owner, NOW)).toEqual({ waits: false, why: 'owner-last' });
  });

  // It reads the state of the thread: an answer the owner has begun is theirs.
  test('not when the owner has a draft in the thread', () => {
    expect(mailWaiting(thread([message(leo, 24)], { draft: true }), owner, NOW)).toEqual({ waits: false, why: 'draft' });
  });

  test('not before it has waited four hours, nor after thirty days', () => {
    const at = (ms: number) => mailWaiting(thread([message(leo, 0, { at: NOW - ms })]), owner, NOW);
    expect(at(MAIL_WAIT_MIN_MS - 1)).toEqual({ waits: false, why: 'too-new' });
    expect(at(MAIL_WAIT_MIN_MS).waits).toBe(true);
    expect(at(MAIL_WAIT_MAX_MS).waits).toBe(true);
    expect(at(MAIL_WAIT_MAX_MS + 1)).toEqual({ waits: false, why: 'too-old' });
  });

  test('not when a machine wrote', () => {
    for (const address of [
      'noreply@shop.example', 'no-reply+a1b2@shop.example', 'do_not_reply@bank.example', 'notifications@tool.example',
      'mailer-daemon@googlemail.example', 'calendar-notification@google.com', 'x@calendar.google.com', 'leo@bounce.shop.example',
      'updates-noreply@linkedin.com', 'receipts@pay.example', 'someone@mail.github.com',
    ]) {
      expect(mailMachine(mailPerson('Shop', address))).toBe(true);
      expect(mailWaiting(thread([message(mailPerson('Shop', address), 24)]), owner, NOW)).toEqual({ waits: false, why: 'machine' });
    }
    expect(mailMachine(mailPerson('Leo via LinkedIn', 'leo@lumen.example'))).toBe(true);
    for (const address of ['leo@lumen.example', 'norbert@reply.example', 'nora.reply@lumen.example', 'billie@lumen.example', 'inforossi@lumen.example']) {
      expect(mailMachine(mailPerson('A person', address))).toBe(false);
    }
    expect(mailMachine(mailPerson('Olivia Viano', 'olivia@lumen.example'))).toBe(false);
  });

  // "hello@" at a company of five is its founder. It counts when the owner is in the conversation.
  test('a shared address counts only in a conversation the owner has written in', () => {
    const hello = mailPerson('Lumen Studio', 'hello@lumen.example');
    expect(mailShared(hello)).toBe(true);
    expect(mailWaiting(thread([message(hello, 24)]), owner, NOW)).toEqual({ waits: false, why: 'machine' });
    expect(mailWaiting(thread([message(me, 48), message(hello, 24)]), owner, NOW).waits).toBe(true);
  });

  test('a mailing Gmail filed away counts only in a conversation the owner has written in', () => {
    expect(mailWaiting(thread([message(leo, 24)], { filed: 'promotions' }), owner, NOW)).toEqual({ waits: false, why: 'filed' });
    expect(mailWaiting(thread([message(me, 48), message(leo, 24)], { filed: 'forums' }), owner, NOW).waits).toBe(true);
    // "Updates" holds receipts, and also a person's reply about one.
    expect(mailWaiting(thread([message(leo, 24)], { filed: 'updates' }), owner, NOW).waits).toBe(true);
  });

  test('not when the owner was only copied, unless the thread is theirs', () => {
    const copied = message(leo, 24, { to: [anna], cc: [me] });
    expect(mailWaiting(thread([copied]), owner, NOW)).toEqual({ waits: false, why: 'not-addressed' });
    expect(mailWaiting(thread([message(me, 48), copied]), owner, NOW).waits).toBe(true);
    const elsewhere = message(leo, 24, { to: [anna], cc: [] });
    expect(mailWaiting(thread([message(me, 48), elsewhere]), owner, NOW)).toEqual({ waits: false, why: 'not-addressed' });
  });

  test('not a round robin to a crowd the owner never answered', () => {
    const crowd = Array.from({ length: 6 }, (_, at) => mailPerson(`P${at}`, `p${at}@lumen.example`));
    const round = message(leo, 24, { to: [me, ...crowd] });
    expect(mailWaiting(thread([round]), owner, NOW)).toEqual({ waits: false, why: 'crowd' });
    expect(mailWaiting(thread([message(me, 48), round]), owner, NOW).waits).toBe(true);
  });

  test('an empty thread waits for nobody', () => {
    expect(mailWaiting(thread([]), owner, NOW)).toEqual({ waits: false, why: 'empty' });
  });
});

describe('who a reply goes to', () => {
  test('the one who wrote last, with everyone else on that message in copy, and never the owner', () => {
    const last = message(leo, 24, { to: [me, anna], cc: [mailPerson('Sam', 'sam.rossi@gmail.example'), mailPerson('Leo', 'LEO@lumen.example'), mailPerson('Nora', 'nora@lumen.example')] });
    expect(mailReplyTo(last, owner)).toEqual({ to: [leo], cc: [anna, mailPerson('Nora', 'nora@lumen.example')] });
    expect(mailReplyTo(message(leo, 24), owner)).toEqual({ to: [leo], cc: [] });
  });
});

describe('a thread as it stood', () => {
  test('holds what had arrived by then, and no draft made since', () => {
    const full = thread([message(leo, 72), message(me, 48), message(leo, 24)], { draft: true });
    const then = threadAsOf(full, NOW - 30 * HOUR);
    expect(then.messages.length).toBe(2);
    expect(then.draft).toBe(false);
    expect(threadAsOf(full, NOW)).toBe(full);
  });
});

describe('what to call someone', () => {
  test('their first name, or the start of their address', () => {
    expect(mailFirstName(leo)).toBe('Leo');
    expect(mailFirstName(mailPerson('"Bianchi, Leo"', 'leo@lumen.example'))).toBe('Leo');
    expect(mailFirstName(mailPerson('Dr. Anna Conti', 'anna@lumen.example'))).toBe('Anna');
    expect(mailFirstName(mailPerson('', 'leo.b@lumen.example'))).toBe('leo.b');
    expect(mailFirstName(mailPerson('李 雷', 'li@lumen.example'))).toBe('李');
  });
});
