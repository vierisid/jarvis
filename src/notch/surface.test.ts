import { describe, expect, test } from 'bun:test';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchAnswer, NotchSurfacePort } from './surface.ts';
import type { NotchLine, NotchToPage } from './protocol.ts';

/** A stand-in for the sidecar manager that records what is pushed. */
function harness(now?: () => number) {
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
  const surface = new NotchSurface(port, (line) => logs.push(line), ...(now ? [now] : []));
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

// Point 7 of the notch review, 26 November 2026 (docs/notch/fixes/07-page-renderer.md).
describe('a page that comes up in the middle of a line that runs out', () => {
  const stateLine = (h: ReturnType<typeof harness>): NotchLine | null => {
    const last = h.pushed.at(-1)!.message;
    return last.type === 'state' ? last.line : null;
  };

  test('is told how much of a fuse is left, so it goes on from there and does not start again', () => {
    let t = 1000;
    const h = harness(() => t);
    const send: NotchLine = { id: 'f1', kind: 'send', say: ['Sending to ', { em: 'Marco' }], ms: 4000 };
    h.surface.show(send);
    t += 1500;
    h.say('pc', { type: 'hello', v: 1 });
    expect(stateLine(h)).toEqual({ ...send, left: 2500 });
    // The line the brain keeps is as it was: what is left is worked out for each page that asks.
    expect(h.surface.current().line).toEqual(send);
    t += 1000;
    h.say('laptop', { type: 'hello', v: 1 });
    expect(stateLine(h)).toEqual({ ...send, left: 1500 });
    // Past its time (the brain waits a little longer for the page's word): nothing is left, never less.
    t += 2000;
    h.say('pc', { type: 'hello', v: 1 });
    expect(stateLine(h)).toEqual({ ...send, left: 0 });
  });

  test('and how much of a result is left', () => {
    let t = 0;
    const h = harness(() => t);
    const result: NotchLine = { id: 'r1', kind: 'say', say: ['Sent.'], ms: 2400 };
    h.surface.show(result);
    t += 400.4;
    h.say('pc', { type: 'hello', v: 1 });
    expect(stateLine(h)).toEqual({ ...result, left: 2000 });
  });

  test('a line shown to pages that are there is shown as it is: all of its time is left', () => {
    let t = 0;
    const h = harness(() => t);
    h.say('pc', { type: 'hello', v: 1 });
    const send: NotchLine = { id: 'f1', kind: 'send', say: ['Sending'], ms: 4000 };
    h.surface.show(send);
    expect(h.pushed.at(-1)!.message).toEqual({ type: 'show', line: send });
    // Shown again, its time starts again.
    t += 3000;
    h.surface.show(send);
    t += 500;
    h.say('pc', { type: 'hello', v: 1 });
    expect(stateLine(h)).toEqual({ ...send, left: 3500 });
  });

  test('a line that does not run out by itself is told as it is', () => {
    let t = 0;
    const h = harness(() => t);
    h.surface.show(offer);
    t += 5000;
    h.say('pc', { type: 'hello', v: 1 });
    expect(stateLine(h)).toEqual(offer);
  });

  test('a clock that was set back does not leave more than all of it', () => {
    let t = 5000;
    const h = harness(() => t);
    const send: NotchLine = { id: 'f1', kind: 'send', say: ['Sending'], ms: 4000 };
    h.surface.show(send);
    t = 100;
    h.say('pc', { type: 'hello', v: 1 });
    expect(stateLine(h)).toEqual({ ...send, left: 4000 });
  });
});

describe('a message the page will not be able to read', () => {
  test('is said where it was made, a few times only, and is still sent', () => {
    const h = harness();
    h.say('pc', { type: 'hello', v: 1 });
    h.surface.show(offer);
    expect(h.logs).toEqual([]);
    // A sheet with no blocks.
    for (let i = 0; i < 8; i++) h.surface.show({ id: `bad${i}`, kind: 'sheet', say: ['Approve?'], yes: 'approve' } as never);
    expect(h.logs.length).toBe(5);
    expect(h.logs[0]).toBe('[notch] a show message (sheet, bad0) is not one the page can read: it will be dropped there');
    expect(h.pushed.filter((p) => p.message.type === 'show').length).toBe(9);
  });
});

describe('two desktop apps on one brain', () => {
  const two = (): ReturnType<typeof harness> => {
    const h = harness();
    h.say('pc', { type: 'hello', v: 1 });
    h.say('laptop', { type: 'hello', v: 1 });
    h.pushed.length = 0;
    return h;
  };

  test('a no or a fold on one takes the line off the other, which would have kept it for ever', () => {
    for (const act of ['no', 'fold'] as const) {
      const h = two();
      h.surface.show({ ...offer, fold: 0 });
      h.pushed.length = 0;
      h.say('pc', { type: 'answer', id: 'l1', act });
      // The one that answered went back to rest by itself, and is told nothing.
      expect(h.pushed).toEqual([{ to: 'laptop', message: { type: 'rest' } }]);
    }
  });

  test('a result that one of them finished showing leaves the other too', () => {
    for (const act of ['done', 'yes'] as const) {
      const h = two();
      h.surface.show({ id: 'r1', kind: 'say', say: ['Sent.'], ms: 2000 });
      h.pushed.length = 0;
      h.say('laptop', { type: 'answer', id: 'r1', act });
      expect(h.pushed).toEqual([{ to: 'pc', message: { type: 'rest' } }]);
    }
  });

  test('the other is told before whoever hears the answer shows the next thing, so the next thing is not what is taken off', () => {
    const h = two();
    h.surface.onAnswer(() => { h.surface.show({ id: 'next', kind: 'say', say: ['Not now, then.'], ms: 2000 }); });
    h.surface.show(offer);
    h.pushed.length = 0;
    h.say('pc', { type: 'answer', id: 'l1', act: 'no' });
    expect(h.pushed.filter((p) => p.to === 'laptop').map((p) => p.message.type)).toEqual(['rest', 'show']);
    expect(h.pushed.filter((p) => p.to === 'pc').map((p) => p.message.type)).toEqual(['show']);
  });

  test('a yes on one leaves it dimmed there until the brain says what next; a no on the other then takes it off the first too', () => {
    const h = two();
    h.surface.show(offer);
    h.pushed.length = 0;
    h.say('pc', { type: 'answer', id: 'l1', act: 'yes' });
    // After a yes the line stays, here and on both pages.
    expect(h.pushed).toEqual([]);
    h.say('laptop', { type: 'answer', id: 'l1', act: 'no' });
    expect(h.surface.current().line).toBeNull();
    expect(h.pushed).toEqual([{ to: 'pc', message: { type: 'rest' } }]);
  });

  test('an answer that ends nothing, or is about a line that is gone, is told to nobody', () => {
    const h = two();
    h.surface.show({ id: 'f1', kind: 'send', say: ['Sending'], ms: 3000 });
    h.pushed.length = 0;
    h.say('pc', { type: 'answer', id: 'f1', act: 'done' });
    h.say('pc', { type: 'answer', id: 'old', act: 'no' });
    expect(h.pushed).toEqual([]);
  });

  test('a desktop app that is not there is not told', () => {
    const h = two();
    h.surface.show(offer);
    h.gone('laptop');
    h.pushed.length = 0;
    h.say('pc', { type: 'answer', id: 'l1', act: 'no' });
    expect(h.pushed).toEqual([]);
  });

  test('with one desktop app nothing more is said than before', () => {
    const h = harness();
    h.say('pc', { type: 'hello', v: 1 });
    h.surface.show(offer);
    h.pushed.length = 0;
    h.say('pc', { type: 'answer', id: 'l1', act: 'no' });
    expect(h.pushed).toEqual([]);
  });
});
