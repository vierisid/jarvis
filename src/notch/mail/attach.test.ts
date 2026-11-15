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
import { attachMailLayer } from './attach.ts';
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
    expect(h.said()).toBe('I cannot see your mail right now. Jarvis\'s own browser may not be signed in to Gmail.');
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
