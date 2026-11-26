/**
 * The mail layer put together, with the real inbox, store and watcher, where
 * there is no way to the mailbox. With a way, each part is tested in its own
 * file against a stand-in for the part below it.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NotchInbox } from '../inbox.ts';
import type { NotchLine, NotchToPage } from '../protocol.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface, type NotchSurfacePort } from '../surface.ts';
import { NUDGE_SENT_ASKS, NUDGE_SENT_WAIT_MS, NUDGE_UNSURE, attachMailLayer, sendNudge } from './attach.ts';
import { MAIL_WHY_DRAFT_THERE, type MailReplySession, type MailStep } from './mailbox.ts';
import type { MailBrowser } from './browser.ts';
import { MailSignedOut } from './tab.ts';

const T1 = '19a1b2c3d4e5f601';
const NOW = Date.UTC(2026, 10, 14, 9, 0);
const settle = async (): Promise<void> => { for (let i = 0; i < 200; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 5)); };

/** A tab in a browser that is not signed in to Google: every call lands on the sign-in page. */
const signedOutTab: MailBrowser = {
  navigate: async () => { throw new MailSignedOut(); },
  evaluate: async () => { throw new MailSignedOut(); },
};

function harness(browser: MailBrowser | null, think: (text: string) => string) {
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const pushed: NotchToPage[] = [];
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { onEvent = listener; },
    onSidecarDisconnected() {},
  };
  const surface = new NotchSurface(port, () => {});
  onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message: { type: 'hello', v: 1 } } });
  const inbox = new NotchInbox(surface, { log: () => {} });
  const logs: string[] = [];
  const thought: string[] = [];
  const layer = attachMailLayer(inbox, {
    db: new Database(':memory:'),
    tab: () => browser,
    think: async (messages) => { thought.push(messages[1]!.content); return { content: think(messages[1]!.content), model: 'm', input: 900, output: 60, cached: 0 }; },
    now: () => NOW,
    zone: 'UTC',
    log: (line) => { logs.push(line); },
    noClock: true,
  });
  const line = (): NotchLine | null => surface.current().line;
  return { layer, surface, logs, thought, line, said: (): string => (line()?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('') };
}

describe('the mail layer, put together', () => {
  test('with no desktop app that has the tab there is no way to the mail: it says so once, and looks at nothing', async () => {
    const h = harness(null, () => '{}');
    expect(await h.layer.look('glance')).toMatchObject({ through: null, read: 0 });
    await h.layer.look('glance');
    expect(h.logs.filter((entry) => entry.includes('mail cannot be reached'))).toEqual(['[notch] mail cannot be reached: no connection, and no signed-in browser tab']);
    expect(h.thought).toEqual([]);
    h.layer.arrived('mail.google.com');
    await settle();
    expect(h.said()).toBe('I cannot see your mail right now. My own browser may not be signed in to Gmail.');
  });

  // Found on the owner's first try: a look through the month that was cut short was not taken again for six hours.
  test('the month stays due until a look has gone through it', async () => {
    const h = harness(null, () => '{}');
    expect(h.layer.monthDue()).toBe(true);
    // No way to the mailbox: nothing was gone through.
    await h.layer.look('sweep');
    expect(h.layer.monthDue()).toBe(true);
    // The lighter looks do not stand for it.
    await h.layer.look('recent');
    expect(h.layer.monthDue()).toBe(true);
  });

  test('a browser that is not signed in is no way either, and nothing is concluded about the mailbox', async () => {
    const h = harness(signedOutTab, () => '{}');
    expect(await h.layer.look('sweep')).toMatchObject({ through: null, listed: 0 });
    expect(h.layer.store.counts()).toEqual({ threads: 0 });
  });

  test('what was sent today is listed with what it cost', () => {
    const h = harness(null, () => '{}');
    const leo = { name: 'Leo Bianchi', address: 'leo@lumen.example' };
    h.layer.store.put({
      id: `${T1}:${NOW}`, thread: T1, messageAt: NOW, state: 'sent', who: leo, subject: 'Deck for Thursday?', to: [leo], cc: [], draft: 'x', time: null, missing: '', lookFor: '', found: null, tone: '', told: '', about: '',
      model: 'm', tokensIn: 4100, tokensOut: 120, createdAt: NOW, updatedAt: NOW + 5, sentAt: NOW + 5,
    });
    expect(h.layer.sentSince(NOW)).toEqual([{ at: NOW + 5, text: 'Replied to Leo: Deck for Thursday?', small: '4,220 tokens' }]);
    expect(h.layer.sentSince(NOW + 10)).toEqual([]);
  });

  test('coming to another site, or leaving for none, says nothing about mail', async () => {
    const h = harness(null, () => '{}');
    h.layer.arrived('github.com');
    h.layer.arrived('');
    await settle();
    expect(h.line()).toBeNull();
  });
});

// The hardening audit, 17 November 2026: a chase's nudge went out twice. Sent
// in its thread, not yet shown there, and sent again as a new mail.
describe('a nudge is sent once', () => {
  function box(session: Partial<MailReplySession>) {
    const did: string[] = [];
    const logs: string[] = [];
    const ok: MailStep = { ok: true };
    const full: MailReplySession = {
      write: async () => { did.push('write'); return session.write ? session.write() : ok; },
      send: async () => { did.push('send'); return session.send ? session.send() : ok; },
      discard: async () => { did.push('discard'); return session.discard ? session.discard() : ok; },
      sent: async (since) => { did.push('read back'); return session.sent ? session.sent(since) : true; },
    };
    return {
      did, logs,
      reply: async (_plan: unknown, work: (session: MailReplySession) => Promise<MailStep>) => work(full),
      write: async () => { did.push('new mail'); return ok; },
    };
  }
  const plan = { address: 'sam@northwind.example', thread: 'T1', subject: 'The contract', text: 'Any news?' };
  const waited: number[] = [];
  const send = (b: ReturnType<typeof box>, with_ = plan) => sendNudge(b as never, with_, () => NOW, (line) => { b.logs.push(line); }, async (ms) => { waited.push(ms); });

  test('to several people it is a mail of its own, never a reply in one person\'s thread', async () => {
    const written: unknown[] = [];
    const b = { did: [] as string[], reply: async () => { b.did.push('reply'); return { ok: true as const }; }, write: async (mail: unknown) => { b.did.push('new mail'); written.push(mail); return { ok: true as const }; } };
    expect(await sendNudge(b as never, { ...plan, also: ['leo@lumen.example'] }, () => NOW, () => {})).toEqual({ ok: true });
    expect(b.did).toEqual(['new mail']);
    expect(written).toEqual([{ to: 'sam@northwind.example', also: ['leo@lumen.example'], subject: 'The contract', text: 'Any news?' }]);
  });

  // The audit's own choice, kept (26 November 2026): a mail that went is not called "not
  // confirmed" and then sent again. What counts as Gmail saying so is the page's to get right.
  test('Gmail says it went: it is sent, whatever the thread shows yet, and no new mail follows', async () => {
    for (const shows of [false, null]) {
      const b = box({ sent: async () => shows });
      expect(await send(b)).toEqual({ ok: true });
      expect(b.did).toEqual(['write', 'send']);
    }
  });

  test('no answer to the send, and the thread shows it: sent, once', async () => {
    for (const pressed of [true, undefined]) {
      const b = box({ send: async () => ({ ok: false, why: 'Gmail did not answer', ...(pressed ? { pressed } : {}) }), sent: async () => true });
      expect(await send(b)).toEqual({ ok: true });
      expect(b.did).toEqual(['write', 'send', 'read back']);
    }
  });

  test('no answer to the send, and the thread shows it only a moment later: sent, once', async () => {
    const shows = [false, false, true];
    const b = box({ send: async () => ({ ok: false, why: 'Gmail did not answer', pressed: true }), sent: async () => shows.shift()! });
    waited.length = 0;
    expect(await send(b)).toEqual({ ok: true });
    expect(b.did).toEqual(['write', 'send', 'read back', 'read back', 'read back']);
    expect(waited).toEqual([NUDGE_SENT_WAIT_MS, NUDGE_SENT_WAIT_MS]);
  });

  test('no answer to the send, and the thread does not show it: it may have gone, and it is not sent again as a new mail', async () => {
    for (const pressed of [true, undefined]) {
      const b = box({ send: async () => ({ ok: false, why: 'Gmail did not answer', ...(pressed ? { pressed } : {}) }), sent: async () => false });
      // It may have gone all the same: the reason says to look first, and when to look from is kept.
      expect(await send(b)).toEqual({ ok: false, why: NUDGE_UNSURE, pressed: true, since: NOW });
      expect(b.did).toEqual(['write', 'send', ...Array.from({ length: NUDGE_SENT_ASKS }, () => 'read back'), 'discard']);
      expect(b.did).not.toContain('new mail');
    }
    const unreadable = box({ send: async () => ({ ok: false, why: 'Gmail did not answer', pressed: true }), sent: async () => null });
    expect(await send(unreadable)).toEqual({ ok: false, why: NUDGE_UNSURE, pressed: true, since: NOW });
    expect(NUDGE_UNSURE.length).toBeLessThanOrEqual(80);
  });

  // It was called "Gmail did not confirm it went" though nothing had been pressed: the chase asked
  // the owner to look in the thread for a mail that could not be there.
  test('the page refused to press Send: nothing went, what was written is taken away, and it goes as a mail of its own', async () => {
    const b = box({ send: async () => ({ ok: false, why: 'no way to send was found', pressed: false }) });
    expect(await send(b)).toEqual({ ok: true });
    expect(b.did).toEqual(['write', 'send', 'discard', 'new mail']);
  });

  test('the thread would not take the words: nothing was pressed, what was begun is taken away, and it goes as a mail of its own', async () => {
    const b = box({ write: async () => ({ ok: false, why: 'the thread goes to others too' }) });
    expect(await send(b)).toEqual({ ok: true });
    expect(b.did).toEqual(['write', 'discard', 'new mail']);
  });

  // The result of taking a draft away was dropped three times over: a draft left in the thread
  // was nobody's news, and it stood in the way of the next reply there.
  test('what was begun and cannot be taken away is said: to the log, and to whoever asked', async () => {
    const stuck = async (): Promise<MailStep> => ({ ok: false, why: 'no way to discard was found' });
    const refused = box({ send: async () => ({ ok: false, why: 'no way to send was found', pressed: false }), discard: stuck });
    expect(await send(refused)).toEqual({ ok: true, left: true });
    expect(refused.logs).toContain('[notch] what a nudge began in its thread could not be taken away: no way to discard was found');
    const unsure = box({ send: async () => ({ ok: false, why: 'Gmail did not answer', pressed: true }), sent: async () => false, discard: stuck });
    expect(await send(unsure)).toEqual({ ok: false, why: NUDGE_UNSURE, pressed: true, since: NOW, left: true });
    // Somebody's own draft that is kept is not a failure, and nothing is said of it.
    const theirs = box({ write: async () => ({ ok: false, why: MAIL_WHY_DRAFT_THERE }), discard: async () => ({ ok: false, why: 'the reply being written is not the one that was written here' }) });
    expect(await send(theirs)).toEqual({ ok: true });
    expect(theirs.logs.some((line) => line.includes('could not be taken away'))).toBe(false);
  });

  test('no thread: a new mail', async () => {
    const b = box({});
    expect(await send(b, { ...plan, thread: null as never })).toEqual({ ok: true });
    expect(b.did).toEqual(['new mail']);
  });
});
