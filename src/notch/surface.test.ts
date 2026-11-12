import { describe, expect, test } from 'bun:test';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchAnswer, NotchSurfacePort } from './surface.ts';
import type { NotchLine, NotchToPage } from './protocol.ts';

/** A stand-in for the sidecar manager that records what is pushed. */
function harness() {
  const pushed: { to: string; message: NotchToPage }[] = [];
  const logs: string[] = [];
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  let onGone: (sidecarId: string) => void = () => {};
  let fail = false;
  const port: NotchSurfacePort = {
    dispatchRPC(sidecarId, method, params) {
      if (method !== 'notch.push') throw new Error(`unexpected method ${method}`);
      if (fail) return Promise.reject(new Error('SIDECAR_OFFLINE'));
      pushed.push({ to: sidecarId, message: (params as { message: NotchToPage }).message });
      return Promise.resolve({ pushed: true });
    },
    onEvent(listener) { onEvent = listener; },
    onSidecarDisconnected(listener) { onGone = listener; },
  };
  const surface = new NotchSurface(port, (line) => logs.push(line));
  return {
    surface, pushed, logs,
    say: (sidecarId: string, message: unknown) => onEvent(sidecarId, { event_type: NOTCH_MESSAGE_EVENT, payload: { message } }),
    event: (sidecarId: string, type: string, payload: unknown) => onEvent(sidecarId, { event_type: type, payload }),
    gone: (sidecarId: string) => onGone(sidecarId),
    failing: (value: boolean) => { fail = value; },
  };
}

const offer: NotchLine = { id: 'l1', kind: 'offer', say: ['Reply to ', { em: 'Marco' }, '?'], yes: 'show' };

describe('what the notch is showing lives in the brain', () => {
  test('a page hears nothing until it has said hello', () => {
    const h = harness();
    h.surface.show(offer);
    h.surface.setCount(2);
    expect(h.pushed).toEqual([]);
  });

  test('hello is answered with everything at once, and from then on the page hears each change', () => {
    const h = harness();
    h.surface.show(offer);
    h.surface.setCount(2);
    h.say('pc', { type: 'hello', v: 1 });
    expect(h.pushed).toEqual([{ to: 'pc', message: { type: 'state', line: offer, count: 2 } }]);
    h.surface.rest();
    h.surface.setCount(3);
    expect(h.pushed.slice(1).map((p) => p.message)).toEqual([{ type: 'rest' }, { type: 'count', count: 3 }]);
  });

  // The test from the plan: restart the desktop app in the middle of a line.
  test('a desktop app that restarts in the middle of a line gets the same line back, without a birth', () => {
    const h = harness();
    h.say('pc', { type: 'hello', v: 1 });
    h.surface.show(offer);
    h.gone('pc');
    h.surface.setCount(1);
    expect(h.pushed.at(-1)!.message).toEqual({ type: 'show', line: offer });
    h.say('pc', { type: 'hello', v: 1 });
    expect(h.pushed.at(-1)).toEqual({ to: 'pc', message: { type: 'state', line: offer, count: 1 } });
  });

  test('the notch is born once per desktop app, and only with nothing to say', () => {
    const h = harness();
    h.say('pc', { type: 'hello', v: 1 });
    expect(h.pushed[0]!.message).toEqual({ type: 'state', line: null, count: 0, born: 'run' });
    h.gone('pc');
    h.say('pc', { type: 'hello', v: 1 });
    expect(h.pushed[1]!.message).toEqual({ type: 'state', line: null, count: 0 });
    h.say('mac', { type: 'hello', v: 1 });
    expect(h.pushed[2]).toEqual({ to: 'mac', message: { type: 'state', line: null, count: 0, born: 'meet' } });
  });

  test('a lit word the person changed is still changed when the line comes back', () => {
    const h = harness();
    const chase: NotchLine = {
      id: 'c1', kind: 'offer', yes: 'draft',
      say: ['Chase ', { word: { name: 'tone', value: 'politely', options: ['politely', 'firmly'] } }, '?'],
    };
    h.say('pc', { type: 'hello', v: 1 });
    h.surface.show(chase);
    h.say('pc', { type: 'answer', id: 'c1', act: 'word', word: 'tone', value: 'firmly' });
    h.gone('pc');
    h.say('pc', { type: 'hello', v: 1 });
    const state = h.pushed.at(-1)!.message as Extract<NotchToPage, { type: 'state' }>;
    expect(state.line!.say[1]).toEqual({ word: { name: 'tone', value: 'firmly', options: ['politely', 'firmly'] } });
    // The caller's own object was not written to.
    expect(chase.say[1]).toEqual({ word: { name: 'tone', value: 'politely', options: ['politely', 'firmly'] } });
  });

  test('a lit word inside a sheet is found too', () => {
    const h = harness();
    const sheet: NotchLine = {
      id: 's1', kind: 'sheet', say: ['Reply'], yes: 'send',
      blocks: [
        { kind: 'paper', lines: [['Does ', { word: { name: 'when', value: 'Thursday', options: ['Thursday', 'Friday'] } }, ' work?']] },
        { kind: 'note', say: ['Tone ', { word: { name: 'tone', value: 'warm', options: ['warm', 'short'] } }] },
      ],
    };
    h.say('pc', { type: 'hello', v: 1 });
    h.surface.show(sheet);
    h.say('pc', { type: 'answer', id: 's1', act: 'word', word: 'when', value: 'Friday' });
    h.say('pc', { type: 'answer', id: 's1', act: 'word', word: 'tone', value: 'short' });
    const now = h.surface.current().line as Extract<NotchLine, { kind: 'sheet' }>;
    expect(JSON.stringify(now.blocks)).toContain('"value":"Friday"');
    expect(JSON.stringify(now.blocks)).toContain('"value":"short"');
  });
});

describe('answers', () => {
  test('an answer reaches the listeners with the desktop app it came from', () => {
    const h = harness();
    const got: [NotchAnswer, string][] = [];
    h.surface.onAnswer((answer, from) => got.push([answer, from]));
    h.say('pc', { type: 'hello', v: 1 });
    h.surface.show(offer);
    h.say('pc', { type: 'answer', id: 'l1', act: 'yes' });
    expect(got).toEqual([[{ type: 'answer', id: 'l1', act: 'yes' }, 'pc']]);
  });

  test('an answer about a line that is no longer there is dropped', () => {
    const h = harness();
    const got: NotchAnswer[] = [];
    h.surface.onAnswer((answer) => got.push(answer));
    h.say('pc', { type: 'hello', v: 1 });
    h.surface.show(offer);
    h.surface.show({ ...offer, id: 'l2' });
    h.say('pc', { type: 'answer', id: 'l1', act: 'yes' });
    h.surface.rest();
    h.say('pc', { type: 'answer', id: 'l2', act: 'yes' });
    expect(got).toEqual([]);
  });

  test('after no or fold the page is at rest, so the line is gone here too', () => {
    for (const act of ['no', 'fold'] as const) {
      const h = harness();
      h.say('pc', { type: 'hello', v: 1 });
      h.surface.show(offer);
      h.say('pc', { type: 'answer', id: 'l1', act });
      expect(h.surface.current().line).toBeNull();
    }
  });

  test('after yes the line stays until the brain says what comes next', () => {
    const h = harness();
    h.say('pc', { type: 'hello', v: 1 });
    h.surface.show(offer);
    h.say('pc', { type: 'answer', id: 'l1', act: 'yes' });
    expect(h.surface.current().line?.id).toBe('l1');
  });

  test('a result that finished being shown is gone; a send that ran out is not', () => {
    const h = harness();
    h.say('pc', { type: 'hello', v: 1 });
    h.surface.show({ id: 'r1', kind: 'say', say: ['Sent.'], ms: 2000 });
    h.say('pc', { type: 'answer', id: 'r1', act: 'done' });
    expect(h.surface.current().line).toBeNull();
    h.surface.show({ id: 'f1', kind: 'send', say: ['Sending…'], ms: 3000 });
    h.say('pc', { type: 'answer', id: 'f1', act: 'done' });
    expect(h.surface.current().line?.id).toBe('f1');
  });

  test('open reaches its listeners', () => {
    const h = harness();
    const opened: string[] = [];
    h.surface.onOpen((from) => opened.push(from));
    h.say('pc', { type: 'open' });
    expect(opened).toEqual(['pc']);
  });

  test('stop reaches its listeners', () => {
    const h = harness();
    const stopped: string[] = [];
    h.surface.onStop((from) => stopped.push(from));
    h.say('pc', { type: 'stop' });
    expect(stopped).toEqual(['pc']);
  });

  test('what is not one of its messages is dropped, and said so a few times only', () => {
    const h = harness();
    const got: NotchAnswer[] = [];
    h.surface.onAnswer((answer) => got.push(answer));
    h.say('pc', { type: 'hello', v: 1 });
    h.surface.show(offer);
    for (const bad of [null, 'yes', [], { type: 'answer' }, { type: 'answer', id: 'l1', act: 'approve' },
      { type: 'answer', id: 'l1', act: 'pick', index: -1 }, { type: 'answer', id: 'l1', act: 'word', value: 7 },
      { type: 'hello' }, { type: 'shutdown' }]) {
      h.say('pc', bad);
    }
    expect(got).toEqual([]);
    expect(h.logs.filter((line) => line.includes('not understood')).length).toBe(5);
  });

  test('other desktop app events are none of its business', () => {
    const h = harness();
    h.event('pc', 'pebble.summon', { message: { type: 'hello', v: 1 } });
    h.surface.setCount(1);
    expect(h.pushed).toEqual([]);
  });
});

describe('changes to the line on the notch', () => {
  test('progress and words heard are kept, so a page that comes back is up to date', () => {
    const h = harness();
    h.say('pc', { type: 'hello', v: 1 });
    h.surface.show({ id: 'w1', kind: 'work', say: ['Pasting payouts'], steps: 9, done: 0 });
    h.surface.update('w1', { done: 4, say: ['Pasting payouts, ', { em: 'without fees' }] });
    expect(h.pushed.at(-1)!.message).toEqual({ type: 'update', id: 'w1', done: 4, say: ['Pasting payouts, ', { em: 'without fees' }] });
    expect(h.surface.current().line).toEqual({
      id: 'w1', kind: 'work', say: ['Pasting payouts, ', { em: 'without fees' }], steps: 9, done: 4,
    });
  });

  test('a change to a line that is not on the notch does nothing', () => {
    const h = harness();
    h.say('pc', { type: 'hello', v: 1 });
    h.surface.show(offer);
    const before = h.pushed.length;
    h.surface.update('other', { done: 1 });
    expect(h.pushed.length).toBe(before);
  });

  test('an act is passed on and not remembered', () => {
    const h = harness();
    h.say('pc', { type: 'hello', v: 1 });
    h.surface.act({ mood: 'happy', gesture: 'wink' });
    expect(h.pushed.at(-1)!.message).toEqual({ type: 'act', mood: 'happy', gesture: 'wink' });
    h.gone('pc');
    h.say('pc', { type: 'hello', v: 1 });
    expect(h.pushed.at(-1)!.message.type).toBe('state');
  });

  test('a push that fails is logged and does not throw', async () => {
    const h = harness();
    h.say('pc', { type: 'hello', v: 1 });
    h.failing(true);
    h.surface.rest();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.logs.some((line) => line.includes('did not reach the notch'))).toBe(true);
  });
});
