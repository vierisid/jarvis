import { describe, expect, test } from 'bun:test';
import { NOTCH_AROUND_EVENT, NOTCH_CALL_AFTER_MS, NOTCH_CALL_ENDS_AFTER_MS, NOTCH_CALL_MOST_MS, NOTCH_OFFLINE_AFTER_MS, attachNotchAround } from './around.ts';
import { NotchInbox } from './inbox.ts';
import type { NotchItem, NotchItemEnd } from './inbox.ts';
import type { NotchAnswerAct, NotchLine, NotchToPage } from './protocol.ts';
import type { NotchStage } from './stage.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface, type NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function harness(options: { meetingNow?: () => boolean; asleep?: () => boolean } = {}) {
  const pushed: NotchToPage[] = [];
  let pageEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  let aroundEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  let gone: (sidecarId: string) => void = () => {};
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { pageEvent = listener; },
    onSidecarDisconnected() {},
  };
  const timers: { fn: () => void; at: number }[] = [];
  let now = 0;
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
  const surface = new NotchSurface(port, () => {});
  const inbox = new NotchInbox(surface, { clock, log: () => {} });
  const fromPage = (message: unknown): void => pageEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 1 });
  let backOnline = 0;
  const logs: string[] = [];
  const around = attachNotchAround(surface, inbox, {
    onEvent(listener) { aroundEvent = listener; },
    onSidecarDisconnected(listener) { gone = listener; },
  }, { ...options, backOnline: () => { backOnline++; }, clock, now: () => now, log: (line) => logs.push(line) });
  const line = (): NotchLine | null => surface.current().line;
  const item = (id: string): NotchItem => ({
    id, subject: id, class: 'person', speaks: true, title: () => [`${id} waits`],
    async play(stage: NotchStage): Promise<NotchItemEnd> { return (await stage.offer([`${id}?`], 'yes')).act === 'yes' ? 'settled' : 'waits'; },
  });
  return {
    around, inbox, surface, pushed, logs, line, item,
    backOnline: () => backOnline,
    said: (): string => (line()?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join(''),
    count: (): number => surface.current().count,
    parks: (): number[] => pushed.flatMap((message) => (message.type === 'act' && message.park !== undefined ? [message.park] : [])),
    async tell(payload: Record<string, unknown>, id = 'pc'): Promise<void> { aroundEvent(id, { event_type: NOTCH_AROUND_EVENT, payload }); await settle(); },
    async leave(id = 'pc'): Promise<void> { gone(id); await settle(); },
    async answer(act: NotchAnswerAct): Promise<void> { fromPage({ type: 'answer', id: line()!.id, act }); await settle(); },
    async pass(ms: number): Promise<void> {
      const until = now + ms;
      for (;;) {
        const next = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        timers.splice(timers.indexOf(next), 1);
        next.fn();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

describe('on a call', () => {
  test('a microphone in use for a minute is a call: it is said once, and everything is held', async () => {
    const h = harness();
    await h.tell({ call: true });
    await h.pass(NOTCH_CALL_AFTER_MS - 1);
    expect(h.around.onCall()).toBe(false);
    await h.pass(1);
    expect(h.around.onCall()).toBe(true);
    expect(h.said()).toBe('On a call. I hold everything until you are done.');
    expect(h.line()).toMatchObject({ kind: 'say', mood: 'focus' });
    await h.answer('done');
    // What arrives now does not speak: it waits.
    h.inbox.add(h.item('mail'));
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
  });

  // Someone dictating a sentence has the microphone for a few seconds.
  test('a short use of the microphone is not a call', async () => {
    const h = harness();
    await h.tell({ call: true });
    await h.pass(20_000);
    await h.tell({ call: false });
    await h.pass(NOTCH_CALL_AFTER_MS);
    expect(h.around.onCall()).toBe(false);
    expect(h.line()).toBeNull();
  });

  test('with a meeting in the calendar for this moment it is a call at once', async () => {
    const h = harness({ meetingNow: () => true });
    await h.tell({ call: true });
    expect(h.around.onCall()).toBe(true);
  });

  test('when it ends, what was held is offered, and yes goes through it', async () => {
    const h = harness();
    await h.tell({ call: true });
    await h.pass(NOTCH_CALL_AFTER_MS);
    await h.answer('done');
    h.inbox.add(h.item('mail'));
    h.inbox.add(h.item('question'));
    await h.pass(2000);
    // Two small bumps beside the notch: two things wait.
    expect(h.parks().at(-1)).toBe(2);
    await h.tell({ call: false });
    // The program may be changing devices: the call is not over for a quarter of a minute.
    expect(h.around.onCall()).toBe(true);
    await h.pass(NOTCH_CALL_ENDS_AFTER_MS);
    expect(h.around.onCall()).toBe(false);
    expect(h.parks().at(-1)).toBe(0);
    expect(h.said()).toBe('Call ended. I held 2 things.');
    await h.answer('yes');
    await h.pass(0);
    expect(h.said()).toBe('mail?');
  });

  test('a microphone taken again within that quarter of a minute is the same call', async () => {
    const h = harness();
    await h.tell({ call: true });
    await h.pass(NOTCH_CALL_AFTER_MS);
    await h.answer('done');
    await h.tell({ call: false });
    await h.pass(NOTCH_CALL_ENDS_AFTER_MS - 1000);
    await h.tell({ call: true });
    await h.pass(NOTCH_CALL_ENDS_AFTER_MS);
    expect(h.around.onCall()).toBe(true);
  });

  test('a call during which nothing arrived ends without a word, and things speak again', async () => {
    const h = harness();
    h.inbox.add({ ...h.item('old'), speaks: false });
    await h.tell({ call: true });
    await h.pass(NOTCH_CALL_AFTER_MS);
    await h.answer('done');
    await h.tell({ call: false });
    await h.pass(NOTCH_CALL_ENDS_AFTER_MS);
    expect(h.line()).toBeNull();
    h.inbox.add(h.item('mail'));
    await settle();
    expect(h.said()).toBe('mail?');
  });

  test('what the person is in the middle of on the notch is not taken from them: the call is said when the notch is free', async () => {
    const h = harness();
    h.inbox.add(h.item('question'));
    await settle();
    expect(h.said()).toBe('question?');
    await h.tell({ call: true });
    await h.pass(NOTCH_CALL_AFTER_MS);
    expect(h.around.onCall()).toBe(true);
    // Their line is still theirs.
    expect(h.said()).toBe('question?');
    await h.answer('yes');
    await h.pass(5000);
    expect(h.said()).toBe('On a call. I hold everything until you are done.');
    await h.answer('done');
    h.inbox.add(h.item('mail'));
    await settle();
    expect(h.line()).toBeNull();
  });

  test('a call that came and went while they were busy on the notch held nothing, and ends without a word', async () => {
    const h = harness();
    h.inbox.add(h.item('question'));
    await settle();
    await h.tell({ call: true });
    await h.pass(NOTCH_CALL_AFTER_MS);
    await h.tell({ call: false });
    await h.pass(NOTCH_CALL_ENDS_AFTER_MS);
    expect(h.around.onCall()).toBe(false);
    expect(h.said()).toBe('question?');
    await h.answer('yes');
    await h.pass(10_000);
    expect(h.line()).toBeNull();
  });

  // A program that died with the microphone says it has it still. Nothing is held for good on its word.
  test('no call lasts three hours: after that it is taken to be over', async () => {
    const h = harness();
    await h.tell({ call: true });
    await h.pass(NOTCH_CALL_AFTER_MS);
    await h.answer('done');
    await h.pass(NOTCH_CALL_MOST_MS);
    expect(h.around.onCall()).toBe(false);
    h.inbox.add(h.item('mail'));
    await settle();
    expect(h.said()).toBe('mail?');
  });

  test('when the desktop app goes away nothing is held on its last word', async () => {
    const h = harness();
    await h.tell({ call: true });
    await h.pass(NOTCH_CALL_AFTER_MS);
    await h.answer('done');
    await h.leave();
    expect(h.around.onCall()).toBe(false);
    h.inbox.add(h.item('mail'));
    await settle();
    expect(h.said()).toBe('mail?');
  });

  test('a desktop app that cannot tell says nothing about calls, and nothing is held', async () => {
    const h = harness();
    await h.tell({ online: true });
    await h.pass(NOTCH_CALL_AFTER_MS * 2);
    expect(h.around.onCall()).toBe(false);
    await h.tell({ call: 'yes' });
    await h.tell(null as unknown as Record<string, unknown>);
    expect(h.around.onCall()).toBe(false);
  });
});

describe('the connection', () => {
  test('gone for a few seconds it is said, once, and said again when it is back', async () => {
    const h = harness();
    await h.tell({ online: false });
    expect(h.line()).toBeNull();
    await h.pass(NOTCH_OFFLINE_AFTER_MS);
    expect(h.around.online()).toBe(false);
    expect(h.said()).toBe('No connection. I carry on when it is back.');
    await h.tell({ online: false });
    await h.answer('done');
    expect(h.line()).toBeNull();
    await h.tell({ online: true });
    expect(h.around.online()).toBe(true);
    expect(h.said()).toBe('Back online.');
    // What waited for the connection is told to go on.
    expect(h.backOnline()).toBe(1);
  });

  test('a blink is not said', async () => {
    const h = harness();
    await h.tell({ online: false });
    await h.pass(NOTCH_OFFLINE_AFTER_MS - 1000);
    await h.tell({ online: true });
    await h.pass(NOTCH_OFFLINE_AFTER_MS);
    expect(h.line()).toBeNull();
    expect(h.backOnline()).toBe(0);
  });

  test('its return is not announced when its going could not be', async () => {
    const h = harness();
    h.inbox.add(h.item('mail'));
    await settle();
    // The notch is taken: "no connection" cannot be said.
    await h.tell({ online: false });
    await h.pass(NOTCH_OFFLINE_AFTER_MS);
    expect(h.said()).toBe('mail?');
    await h.answer('yes');
    await h.tell({ online: true });
    expect(h.line()).toBeNull();
    expect(h.backOnline()).toBe(1);
  });

  test('when the desktop app goes away the connection is not called lost on its last word, nor back', async () => {
    const h = harness();
    await h.tell({ online: false });
    await h.pass(NOTCH_OFFLINE_AFTER_MS);
    await h.answer('done');
    await h.leave();
    expect(h.around.online()).toBe(true);
    expect(h.line()).toBeNull();
  });

  test('nothing is said while everything is stopped', async () => {
    let asleep = true;
    const h = harness({ asleep: () => asleep });
    await h.tell({ online: false });
    await h.pass(NOTCH_OFFLINE_AFTER_MS);
    expect(h.line()).toBeNull();
    asleep = false;
    await h.tell({ online: true });
    expect(h.line()).toBeNull();
  });
});
