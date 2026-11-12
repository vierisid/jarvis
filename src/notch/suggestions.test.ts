import { describe, expect, test } from 'bun:test';
import { NotchInbox } from './inbox.ts';
import type { NotchLine, NotchToPage } from './protocol.ts';
import { attachNotchSuggestions } from './suggestions.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function harness() {
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const pushed: NotchToPage[] = [];
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { onEvent = listener; },
    onSidecarDisconnected() {},
  };
  const surface = new NotchSurface(port, () => {});
  const inbox = new NotchInbox(surface, { log: () => {} });
  const fromPage = (message: unknown): void => onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 1 });
  const line = (): NotchLine | null => surface.current().line;
  return {
    suggestions: attachNotchSuggestions(inbox), inbox, line,
    said: (): string => (line()?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join(''),
    count: (): number => surface.current().count,
    async open(): Promise<void> { fromPage({ type: 'open' }); await settle(); },
    async done(): Promise<void> { fromPage({ type: 'answer', id: line()!.id, act: 'done' }); await settle(); },
  };
}

describe('a suggestion with the notch on', () => {
  test('does not pop up: it joins the count, and counts as shown', async () => {
    const h = harness();
    expect(h.suggestions.toast('JARVIS: Reply to Marco', 'He asked for the deck on Tuesday.')).toBe(true);
    expect(await h.suggestions.toastWithReceipt('JARVIS: Fix for error in Terminal', 'The port is already in use.')).toBe('shown');
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(2);
  });

  test('is said once when the person asks what waits, without the JARVIS prefix, and is then gone', async () => {
    const h = harness();
    h.suggestions.toast('JARVIS: Reply to Marco', 'He asked for the deck on Tuesday.');
    await settle();
    await h.open();
    expect(h.said()).toBe('Reply to Marco: He asked for the deck on Tuesday.');
    expect(h.line()).toMatchObject({ kind: 'say' });
    await h.done();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(0);
  });

  test('the same suggestion made again takes the place of the first', async () => {
    const h = harness();
    h.suggestions.toast('JARVIS: Reply to Marco', 'First wording.');
    h.suggestions.toast('JARVIS: Reply to Marco', 'Second wording.');
    await settle();
    expect(h.count()).toBe(1);
    await h.open();
    expect(h.said()).toBe('Reply to Marco: Second wording.');
  });

  test('a long body is cut, and a body that only repeats the title is not said twice', async () => {
    const h = harness();
    h.suggestions.toast('JARVIS: Help for Sheets', `Try ${'this very long explanation '.repeat(10)}`);
    await settle();
    await h.open();
    expect(h.said().length).toBeLessThan(135);
    expect(h.said()).toContain('…');
    await h.done();
    h.suggestions.toast('JARVIS: Stand up', 'Stand up');
    await settle();
    await h.open();
    expect(h.said()).toBe('Stand up');
  });
});
