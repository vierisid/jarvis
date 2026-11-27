import { describe, expect, test } from 'bun:test';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchAnswer, NotchSurfacePort, NotchTimers } from './surface.ts';
import {
  NOTCH_ANSWERS_KEPT, NOTCH_FOLD_CHOICES_MS, NOTCH_FOLD_GRACE_MS, NOTCH_FOLD_HELD_MS, NOTCH_FOLD_MS, NOTCH_HAND_AGAIN_MS, NOTCH_HAND_HOLDS_MS,
  NOTCH_PROTOCOL_VERSION, notchRuled, parseNotchToPage,
} from './protocol.ts';
import type { NotchLine, NotchToPage } from './protocol.ts';
import { NotchStage } from './stage.ts';

/**
 * A stand-in for the sidecar manager that records what is pushed, with a
 * clock that stands still until it is moved on: the surface's own time and
 * its fold are both on it, so nothing here waits.
 */
function harness(options: { timers?: boolean } = {}) {
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
  let now = 1000;
  const due: { at: number; fn: () => void }[] = [];
  const timers: NotchTimers = {
    setTimeout: (fn, ms) => { const entry = { at: now + ms, fn }; due.push(entry); return entry; },
    clearTimeout: (handle) => { const at = due.indexOf(handle as { at: number; fn: () => void }); if (at >= 0) due.splice(at, 1); },
  };
  const make = (): NotchSurface => new NotchSurface(port, (line) => logs.push(line), () => now, options.timers === false ? null : timers);
  const h = {
    surface: make(), pushed, logs,
    say: (sidecarId: string, message: unknown) => onEvent(sidecarId, { event_type: NOTCH_MESSAGE_EVENT, payload: { message } }),
    event: (sidecarId: string, type: string, payload: unknown) => onEvent(sidecarId, { event_type: type, payload }),
    hello: (sidecarId: string, page = `${sidecarId}-page`) => h.say(sidecarId, { type: 'hello', v: NOTCH_PROTOCOL_VERSION, page }),
    gone: (sidecarId: string) => onGone(sidecarId),
    failing: (value: boolean) => { fail = value; },
    set: (to: number) => { now = to; },
    /** Moves the time on, calling what comes due on the way, the earliest first. */
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        const next = due.filter((entry) => entry.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        due.splice(due.indexOf(next), 1);
        now = Math.max(now, next.at);
        next.fn();
      }
      now = end;
    },
    waiting: () => due.length,
    /** The brain is started again: another surface on the same desktop apps. Their pages are still up. */
    restart: () => { h.surface = make(); return h.surface; },
    to: (sidecarId: string) => pushed.filter((p) => p.to === sidecarId).map((p) => p.message),
    /** What was pushed, without what only numbers and names it. */
    bare: (from = 0) => pushed.slice(from).map((p) => bare(p.message)),
  };
  return h;
}

/** A message without its number, and a state without the version and the name of the brain. */
function bare(message: NotchToPage): Record<string, unknown> {
  const { seq: _seq, v: _v, brain: _brain, ...rest } = message as NotchToPage & { seq?: number; v?: number; brain?: string };
  return rest;
}

const offer: NotchLine = { id: 'l1', kind: 'offer', say: ['Reply to ', { em: 'Marco' }, '?'], yes: 'show' };
const fuse: NotchLine = { id: 'f1', kind: 'send', say: ['Sending to ', { em: 'Marco' }], ms: 4000 };

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
    h.hello('pc');
    expect(h.bare()).toEqual([{ type: 'state', line: notchRuled(offer), count: 2 }]);
    expect(h.pushed[0]!.message).toMatchObject({ v: NOTCH_PROTOCOL_VERSION, seq: 1 });
    h.surface.rest();
    h.surface.setCount(3);
    expect(h.bare(1)).toEqual([{ type: 'patch', line: null }, { type: 'patch', count: 3 }]);
  });

  // The test from the plan: restart the desktop app in the middle of a line.
  test('a desktop app that restarts in the middle of a line gets the same line back, without a birth', () => {
    const h = harness();
    h.hello('pc');
    h.surface.show(offer);
    h.gone('pc');
    h.surface.setCount(1);
    expect(h.bare().at(-1)).toEqual({ type: 'patch', line: notchRuled(offer) });
    h.hello('pc');
    expect(h.bare().at(-1)).toEqual({ type: 'state', line: notchRuled(offer), count: 1 });
  });

  test('the notch is born once per desktop app, and only with nothing to say', () => {
    const h = harness();
    h.hello('pc');
    expect(h.bare()[0]).toEqual({ type: 'state', line: null, count: 0, born: 'run' });
    h.gone('pc');
    h.hello('pc');
    expect(h.bare()[1]).toEqual({ type: 'state', line: null, count: 0 });
    h.hello('mac');
    expect(h.pushed[2]!.to).toBe('mac');
    expect(h.bare()[2]).toEqual({ type: 'state', line: null, count: 0, born: 'meet' });
  });

  test('a lit word the person changed is still changed when the line comes back', () => {
    const h = harness();
    const chase: NotchLine = {
      id: 'c1', kind: 'offer', yes: 'draft',
      say: ['Chase ', { word: { name: 'tone', value: 'politely', options: ['politely', 'firmly'] } }, '?'],
    };
    h.hello('pc');
    h.surface.show(chase);
    h.say('pc', { type: 'answer', id: 'c1', act: 'word', word: 'tone', value: 'firmly' });
    h.gone('pc');
    h.hello('pc');
    const state = h.pushed.at(-1)!.message as Extract<NotchToPage, { type: 'state' }>;
    expect(state.line!.say[1]).toEqual({ word: { name: 'tone', value: 'firmly', options: ['politely', 'firmly'] } });
    // The caller's own object was not written to.
    expect(chase.say[1]).toEqual({ word: { name: 'tone', value: 'politely', options: ['politely', 'firmly'] } });
  });

  test('a value that is none of the word\'s options is read as typed: unread, it changes nothing and joins no options', () => {
    const h = harness();
    const heard: string[] = [];
    h.surface.onAnswer((answer) => heard.push(`${answer.act}:${answer.value ?? ''}`));
    const sched: NotchLine = { id: 'c1', kind: 'offer', yes: 'go', say: ['Every ', { word: { name: 'when', value: 'Monday at 9:00', options: ['Monday at 9:00', 'Friday at 9:00'], read: 'sched' } }] };
    h.hello('pc');
    h.surface.show(sched);
    h.say('pc', { type: 'answer', n: 1, id: 'c1', act: 'word', word: 'when', value: 'month' });
    expect(h.pushed.at(-1)!.message).toEqual({ type: 'ack', n: 1, took: true, unread: true });
    h.say('pc', { type: 'answer', n: 2, id: 'c1', act: 'word', word: 'when', value: 'Friday at 9:00' });
    h.say('pc', { type: 'answer', n: 3, id: 'c1', act: 'word', word: 'when', value: 'weekday at 9' });
    expect(heard).toEqual(['word:Friday at 9:00', 'word:Monday to Friday at 9:00']);
    h.gone('pc');
    h.hello('pc');
    const state = h.pushed.at(-1)!.message as Extract<NotchToPage, { type: 'state' }>;
    expect(state.line!.say[1]).toEqual({ word: { name: 'when', value: 'Monday to Friday at 9:00', options: ['Monday at 9:00', 'Friday at 9:00', 'Monday to Friday at 9:00'], read: 'sched' } });
  });

  test('a typed value read as the word already stood is still drawn again on the page that typed it', () => {
    const h = harness();
    const sched: NotchLine = { id: 'c1', kind: 'offer', yes: 'go', say: ['Every ', { word: { name: 'when', value: 'Monday at 9:00', options: ['Monday at 9:00'], read: 'sched' } }] };
    h.hello('pc');
    h.surface.show(sched);
    const before = h.pushed.length;
    h.say('pc', { type: 'answer', n: 1, id: 'c1', act: 'word', word: 'when', text: 'mon 9' });
    expect(h.pushed.slice(before).map((one) => [one.to, one.message.type])).toEqual([['pc', 'ack'], ['pc', 'patch']]);
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
    h.hello('pc');
    h.surface.show(sheet);
    h.say('pc', { type: 'answer', id: 's1', act: 'word', word: 'when', value: 'Friday' });
    h.say('pc', { type: 'answer', id: 's1', act: 'word', word: 'tone', value: 'short' });
    const now = h.surface.current().line as Extract<NotchLine, { kind: 'sheet' }>;
    expect(JSON.stringify(now.blocks)).toContain('"value":"Friday"');
    expect(JSON.stringify(now.blocks)).toContain('"value":"short"');
  });

  test('the line the brain keeps is as it was given: its rules are written into what a page is told, not into it', () => {
    const h = harness();
    h.hello('pc');
    h.surface.show(offer);
    expect(h.surface.current().line).toEqual(offer);
    const told = (h.pushed.at(-1)!.message as Extract<NotchToPage, { type: 'patch' }>).line!;
    expect(told).toMatchObject({ after: { yes: 'hold', no: 'rest', fold: 'rest' }, away: 'none', asking: true, gate: { dead: 350, esc: 0 }, fold: NOTCH_FOLD_MS });
  });
});

describe('answers', () => {
  test('an answer reaches the listeners with the desktop app it came from', () => {
    const h = harness();
    const got: [NotchAnswer, string | undefined][] = [];
    h.surface.onAnswer((answer, from) => got.push([answer, from]));
    h.hello('pc');
    h.surface.show(offer);
    h.say('pc', { type: 'answer', id: 'l1', act: 'yes' });
    expect(got).toEqual([[{ type: 'answer', id: 'l1', act: 'yes' }, 'pc']]);
  });

  test('an answer about a line that is no longer there is dropped', () => {
    const h = harness();
    const got: NotchAnswer[] = [];
    h.surface.onAnswer((answer) => got.push(answer));
    h.hello('pc');
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
      h.hello('pc');
      h.surface.show(offer);
      h.say('pc', { type: 'answer', id: 'l1', act });
      expect(h.surface.current().line).toBeNull();
    }
  });

  test('after yes the line stays until the brain says what comes next', () => {
    const h = harness();
    h.hello('pc');
    h.surface.show(offer);
    h.say('pc', { type: 'answer', id: 'l1', act: 'yes' });
    expect(h.surface.current().line?.id).toBe('l1');
  });

  test('a result that finished being shown is gone; a send that ran out is not', () => {
    const h = harness();
    h.hello('pc');
    h.surface.show({ id: 'r1', kind: 'say', say: ['Sent.'], ms: 2000 });
    h.say('pc', { type: 'answer', id: 'r1', act: 'done' });
    expect(h.surface.current().line).toBeNull();
    h.surface.show({ id: 'f1', kind: 'send', say: ['Sending...'], ms: 3000 });
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
    h.hello('pc');
    h.surface.show(offer);
    for (const bad of [null, 'yes', [], { type: 'answer' }, { type: 'answer', id: 'l1', act: 'approve' },
      { type: 'answer', id: 'l1', act: 'pick', index: -1 }, { type: 'answer', id: 'l1', act: 'word', value: 7 },
      { type: 'hello' }, { type: 'shutdown' }, { type: 'answer', id: 'l1', act: 'yes', n: 0 }, { type: 'answer', id: 'l1', act: 'yes', n: 1.5 },
      { type: 'hand', id: 'l1' }, { type: 'at' }]) {
      h.say('pc', bad);
    }
    expect(got).toEqual([]);
    expect(h.logs.filter((line) => line.includes('not understood')).length).toBe(5);
  });

  test('other desktop app events are none of its business', () => {
    const h = harness();
    h.event('pc', 'pebble.summon', { message: { type: 'hello', v: NOTCH_PROTOCOL_VERSION } });
    h.surface.setCount(1);
    expect(h.pushed).toEqual([]);
  });
});

describe('changes to the line on the notch', () => {
  test('progress and words heard are kept, so a page that comes back is up to date', () => {
    const h = harness();
    h.hello('pc');
    h.surface.show({ id: 'w1', kind: 'work', say: ['Pasting payouts'], steps: 9, done: 0 });
    h.surface.update('w1', { done: 4, say: ['Pasting payouts, ', { em: 'without fees' }] });
    expect(h.bare().at(-1)).toEqual({ type: 'patch', edit: { id: 'w1', done: 4, say: ['Pasting payouts, ', { em: 'without fees' }] } });
    expect(h.surface.current().line).toEqual({
      id: 'w1', kind: 'work', say: ['Pasting payouts, ', { em: 'without fees' }], steps: 9, done: 4,
    });
  });

  test('a change to a line that is not on the notch does nothing', () => {
    const h = harness();
    h.hello('pc');
    h.surface.show(offer);
    const before = h.pushed.length;
    h.surface.update('other', { done: 1 });
    expect(h.pushed.length).toBe(before);
  });

  test('a change that changes what a press elsewhere is says so: a field that was handed a file is no longer closed by one', () => {
    const h = harness();
    h.hello('pc');
    h.surface.show({ id: 'a1', kind: 'ask', say: [], placeholder: 'Ask', yes: 'ask', blocks: [] });
    expect((h.pushed.at(-1)!.message as Extract<NotchToPage, { type: 'patch' }>).line).toMatchObject({ away: 'no' });
    h.surface.update('a1', { blocks: [{ kind: 'note', say: ['Thinking'] }] });
    expect(h.bare().at(-1)).toEqual({ type: 'patch', edit: { id: 'a1', blocks: [{ kind: 'note', say: ['Thinking'] }] } });
    h.surface.update('a1', { blocks: [{ kind: 'file', icon: 'doc', name: 'q3.pdf', meta: '2 MB' }] });
    expect((h.bare().at(-1) as { edit: { away?: string } }).edit.away).toBe('none');
  });

  test('a push that fails is logged and does not throw', async () => {
    const h = harness();
    h.hello('pc');
    h.failing(true);
    h.surface.rest();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.logs.some((line) => line.includes('did not reach the notch'))).toBe(true);
  });
});

// Point 7, step 4 (docs/notch/fixes/07-page-renderer.md): what the notch IS and what it DOES once are different messages.
describe('what the notch is, and what it does once', () => {
  test('a movement is an effect: passed on, and not remembered', () => {
    const h = harness();
    h.hello('pc');
    h.surface.act({ mood: 'happy', gesture: 'wink' });
    expect(h.bare().at(-1)).toEqual({ type: 'effect', mood: 'happy', gesture: 'wink' });
    h.gone('pc');
    h.hello('pc');
    expect(h.bare().at(-1)).toEqual({ type: 'state', line: null, count: 0 });
  });

  test('what waits on the edge is kept: a desktop app started again in the middle of a call has its bumps', () => {
    const h = harness();
    h.hello('pc');
    h.surface.setPark(2);
    expect(h.bare().at(-1)).toEqual({ type: 'patch', park: 2 });
    // Said once, not at every look.
    h.surface.setPark(2);
    expect(h.pushed.length).toBe(2);
    h.gone('pc');
    h.hello('pc');
    expect(h.bare().at(-1)).toEqual({ type: 'state', line: null, count: 0, park: 2 });
    h.surface.setPark(0);
    h.hello('pc');
    expect(h.bare().at(-1)).toEqual({ type: 'state', line: null, count: 0 });
  });

  test('the mouth, the eye, the sounds, the face and the app in front are kept the same way', () => {
    const h = harness();
    h.hello('pc');
    h.surface.setMouth('open');
    h.surface.setMouth('over');
    h.surface.setEye(true);
    h.surface.setSound(true);
    h.surface.setFace('closed');
    h.surface.setWhere({ name: 'Mail' });
    expect(h.bare(1)).toEqual([
      { type: 'patch', mouth: 'open' }, { type: 'patch', mouth: 'over' }, { type: 'patch', eye: true }, { type: 'patch', sound: true },
      { type: 'patch', face: 'closed' }, { type: 'patch', where: { name: 'Mail' } },
    ]);
    h.hello('laptop');
    expect(h.bare().at(-1)).toEqual({ type: 'state', line: null, count: 0, born: 'meet', face: 'closed', where: { name: 'Mail' }, eye: true, sound: true, mouth: 'over' });
  });

  test('a gulp shuts the mouth for good and gulps once', () => {
    const h = harness();
    h.hello('pc');
    h.surface.setMouth('open');
    h.surface.gulp();
    expect(h.bare(2)).toEqual([{ type: 'patch', mouth: 'shut' }, { type: 'effect', gulp: true }]);
    h.hello('pc');
    expect(h.bare().at(-1)).toEqual({ type: 'state', line: null, count: 0 });
  });

  test('every message the brain makes is one the page can read', () => {
    const h = harness();
    h.hello('pc');
    for (const line of [
      offer, fuse, { id: 'c', kind: 'offer', say: ['Which?'], options: ['a', 'b'] }, { id: 'e', kind: 'offer', say: ['Try it'], keys: 'esc' },
      { id: 'r', kind: 'say', say: ['Done.'], ms: 2000 }, { id: 's', kind: 'sheet', say: ['Read'], blocks: [], yes: 'send', whole: true, stay: true },
      { id: 'a', kind: 'ask', say: [], placeholder: 'Ask', yes: 'ask', blocks: [] }, { id: 'w', kind: 'work', say: ['Working'], steps: 3, done: 1, asks: true },
      { id: 'h', kind: 'listen', say: [], heard: 'hello' }, { id: 'p', kind: 'send', say: ['Sending'], ms: 3000, blocks: [{ kind: 'paper', lines: [['Hi']] }] },
    ] as NotchLine[]) h.surface.show(line);
    h.surface.update('p', { say: ['Still sending'] });
    h.surface.setPark(1);
    h.surface.setMouth('open');
    h.surface.gulp();
    h.surface.act({ gesture: 'nodg', kick: 200, lip: 'reach', aim: .5, body: 'nod', edge: 'bud', side: 'right', birth: 'run', mood: 'proud' });
    h.surface.rest();
    h.hello('pc');
    h.say('pc', { type: 'answer', n: 1, id: 'nothing', act: 'yes' });
    h.say('stranger', { type: 'answer', n: 1, id: 'nothing', act: 'yes' });
    expect(h.pushed.length).toBeGreaterThan(18);
    for (const { message } of h.pushed) expect(parseNotchToPage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    expect(h.logs).toEqual([]);
  });
});

describe('the numbers of the messages', () => {
  test('each page has a row of its own, one after the other, whatever is said to the other page alone', () => {
    const h = harness();
    h.hello('pc');
    h.surface.setCount(1);
    h.hello('laptop');
    h.surface.setCount(2);
    h.surface.act({ gesture: 'blink' });
    const seqs = (to: string): number[] => h.to(to).map((m) => (m as { seq: number }).seq);
    expect(seqs('pc')).toEqual([1, 2, 3, 4]);
    expect(seqs('laptop')).toEqual([1, 2, 3]);
    // An ack is not in the row: it is said to one page about one answer.
    h.say('pc', { type: 'answer', n: 1, id: 'gone', act: 'no' });
    expect(h.to('pc').at(-1)).toEqual({ type: 'ack', n: 1, took: false });
    h.surface.setCount(3);
    expect(seqs('pc').at(-1)).toBe(5);
  });

  test('a row goes on when its desktop app comes back: a page that outlived the connection is never told a number twice', () => {
    const h = harness();
    h.hello('pc');
    h.surface.setCount(1);
    h.gone('pc');
    h.surface.setCount(2);
    h.hello('pc');
    expect(h.to('pc').map((m) => (m as { seq: number }).seq)).toEqual([1, 2, 3]);
    expect(h.to('pc').at(-1)!.type).toBe('state');
  });

  test('a number that was used for a message that never arrived leaves a gap, which is how the page knows', async () => {
    const h = harness();
    h.hello('pc');
    h.failing(true);
    h.surface.setCount(1);
    await Promise.resolve();
    h.failing(false);
    h.surface.setCount(2);
    expect(h.to('pc').map((m) => (m as { seq: number }).seq)).toEqual([1, 3]);
  });

  test('a page that says it has read less than was sent is told the whole again, and one that is in step is told nothing', () => {
    const h = harness();
    const hellos: string[] = [];
    h.surface.onHello((id) => hellos.push(id));
    h.hello('pc');
    h.surface.show(offer);
    h.surface.setCount(4);
    h.say('pc', { type: 'at', seq: 3 });
    expect(h.pushed.length).toBe(3);
    // The last one was lost on the way.
    h.say('pc', { type: 'at', seq: 2 });
    expect(h.bare().at(-1)).toEqual({ type: 'state', line: notchRuled(offer), count: 4 });
    expect((h.pushed.at(-1)!.message as { seq: number }).seq).toBe(4);
    // It is the whole again, and not a hello: nothing that waits for a page to come up is woken.
    expect(hellos).toEqual(['pc']);
    // A page that has read more than this brain ever sent talked to another brain: the same.
    h.say('pc', { type: 'at', seq: 900 });
    expect(h.pushed.at(-1)!.message.type).toBe('state');
    expect(h.pushed.length).toBe(5);
  });

  test('a state names the run of the brain, the same every time, and another run has another name', () => {
    const h = harness();
    h.hello('pc');
    h.hello('pc');
    const names = h.pushed.map((p) => (p.message as { brain: string }).brain);
    expect(names[0]).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(names[1]).toBe(names[0]!);
    h.restart();
    h.hello('pc');
    expect((h.pushed.at(-1)!.message as { brain: string }).brain).not.toBe(names[0]!);
  });
});

describe('an answer is acknowledged, and counts once', () => {
  const ready = (line: NotchLine = offer) => {
    const h = harness();
    const got: NotchAnswer[] = [];
    h.surface.onAnswer((answer) => got.push(answer));
    h.hello('pc');
    h.surface.show(line);
    h.pushed.length = 0;
    return { h, got };
  };

  test('a numbered answer is acknowledged to the page that gave it, and handed on with a name of its own', () => {
    const { h, got } = ready();
    h.say('pc', { type: 'answer', n: 1, id: 'l1', act: 'yes', since: 900 });
    expect(h.pushed).toEqual([{ to: 'pc', message: { type: 'ack', n: 1, took: true } }]);
    expect(got).toEqual([{ type: 'answer', n: 1, id: 'l1', act: 'yes', since: 900, key: 'pc\npc-page\n1' }]);
  });

  test('the same answer again is acknowledged again and is not taken again: no second yes', () => {
    const { h, got } = ready();
    for (let i = 0; i < 4; i++) h.say('pc', { type: 'answer', n: 1, id: 'l1', act: 'yes' });
    expect(got.length).toBe(1);
    expect(h.pushed.map((p) => p.message)).toEqual(Array.from({ length: 4 }, () => ({ type: 'ack', n: 1, took: true })));
  });

  test('a second done is not taken, and neither is a done sent again after an undo', () => {
    const { h, got } = ready(fuse);
    h.say('pc', { type: 'answer', n: 1, id: 'f1', act: 'done' });
    h.say('pc', { type: 'answer', n: 1, id: 'f1', act: 'done' });
    expect(got.map((a) => a.act)).toEqual(['done']);
    const two = ready(fuse);
    two.h.say('pc', { type: 'answer', n: 1, id: 'f1', act: 'undo' });
    two.h.say('pc', { type: 'answer', n: 1, id: 'f1', act: 'undo' });
    expect(two.got.map((a) => a.act)).toEqual(['undo']);
  });

  test('an answer that came too late is told so, the same every time it is sent again, and reaches nobody', () => {
    const { h, got } = ready();
    h.surface.show({ ...offer, id: 'l2' });
    h.pushed.length = 0;
    h.say('pc', { type: 'answer', n: 7, id: 'l1', act: 'yes' });
    // The line it was about is shown again under the same name: what was late stays late.
    h.surface.show(offer);
    h.pushed.length = 0;
    h.say('pc', { type: 'answer', n: 7, id: 'l1', act: 'yes' });
    expect(h.pushed.map((p) => p.message)).toEqual([{ type: 'ack', n: 7, took: false }]);
    expect(got).toEqual([]);
  });

  test('answers that arrive out of order are each taken once', () => {
    const { h, got } = ready({ id: 's1', kind: 'sheet', say: ['Pick'], blocks: [{ kind: 'buttons', buttons: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] });
    h.say('pc', { type: 'answer', n: 2, id: 's1', act: 'button', button: 'b' });
    h.say('pc', { type: 'answer', n: 1, id: 's1', act: 'button', button: 'a' });
    h.say('pc', { type: 'answer', n: 2, id: 's1', act: 'button', button: 'b' });
    h.say('pc', { type: 'answer', n: 1, id: 's1', act: 'button', button: 'a' });
    expect(got.map((a) => a.button)).toEqual(['b', 'a']);
  });

  test('another loading of the page counts from 1 again, and its first answer is not the old page\'s first', () => {
    const { h, got } = ready();
    h.say('pc', { type: 'answer', n: 1, id: 'l1', act: 'word', word: 'x', value: 'a' });
    h.hello('pc', 'loaded-again');
    h.say('pc', { type: 'answer', n: 1, id: 'l1', act: 'yes' });
    expect(got.map((a) => a.act)).toEqual(['word', 'yes']);
    expect(got.map((a) => a.key)).toEqual(['pc\npc-page\n1', 'pc\nloaded-again\n1']);
  });

  test('the same page saying hello again (it was out of step) does not make the brain forget what it took', () => {
    const { h, got } = ready();
    h.say('pc', { type: 'answer', n: 1, id: 'l1', act: 'yes' });
    h.hello('pc');
    h.say('pc', { type: 'answer', n: 1, id: 'l1', act: 'yes' });
    expect(got.length).toBe(1);
  });

  test('a desktop app that reconnects in the middle of a retry: the answer taken before is not taken after', () => {
    const { h, got } = ready();
    h.say('pc', { type: 'answer', n: 1, id: 'l1', act: 'yes' });
    h.gone('pc');
    h.pushed.length = 0;
    // Before its hello on the new connection it is not a page that listens: refused, and not taken.
    h.say('pc', { type: 'answer', n: 1, id: 'l1', act: 'yes' });
    expect(h.pushed.map((p) => p.message)).toEqual([{ type: 'refuse', v: NOTCH_PROTOCOL_VERSION }]);
    h.hello('pc');
    h.say('pc', { type: 'answer', n: 1, id: 'l1', act: 'yes' });
    expect(got.length).toBe(1);
    expect(h.pushed.at(-1)!.message).toEqual({ type: 'ack', n: 1, took: true });
  });

  test('whoever hears an answer and throws does not stop the page being told that the brain has it', () => {
    const h = harness();
    h.surface.onAnswer(() => { throw new Error('a script broke'); });
    h.hello('pc');
    h.surface.show(offer);
    h.pushed.length = 0;
    expect(() => h.say('pc', { type: 'answer', n: 1, id: 'l1', act: 'yes' })).toThrow('a script broke');
    expect(h.pushed.map((p) => p.message)).toEqual([{ type: 'ack', n: 1, took: true }]);
  });

  test('an answer without a number is taken as it comes and is not acknowledged', () => {
    const { h, got } = ready();
    h.say('pc', { type: 'answer', id: 'l1', act: 'yes' });
    expect(got).toEqual([{ type: 'answer', id: 'l1', act: 'yes' }]);
    expect(h.pushed).toEqual([]);
  });

  test('over a long day the brain remembers a fixed number of answers, and an old number sent again is still not taken', () => {
    const sheet: NotchLine = { id: 's1', kind: 'sheet', say: ['Pick'], blocks: [{ kind: 'buttons', buttons: [{ id: 'a', label: 'A' }] }] };
    const { h, got } = ready(sheet);
    for (let n = 1; n <= 5000; n++) h.say('pc', { type: 'answer', n, id: 's1', act: 'button', button: 'a' });
    expect(got.length).toBe(5000);
    const heard = (h.surface as unknown as { heard: Map<string, { took: Map<number, boolean> }> }).heard;
    expect(heard.get('pc')!.took.size).toBe(NOTCH_ANSWERS_KEPT);
    h.pushed.length = 0;
    for (const n of [1, 2500, 5000 - NOTCH_ANSWERS_KEPT, 5000]) h.say('pc', { type: 'answer', n, id: 's1', act: 'button', button: 'a' });
    expect(got.length).toBe(5000);
    expect(h.pushed.map((p) => p.message)).toEqual([1, 2500, 5000 - NOTCH_ANSWERS_KEPT, 5000].map((n) => ({ type: 'ack', n, took: true })));
    // And it keeps them for the desktop apps it has met, not for each connection of each.
    for (let i = 0; i < 50; i++) { h.gone('pc'); h.hello('pc'); }
    expect(heard.size).toBe(1);
  });

  test('a yes that came sooner than its line allows is said in the log, a few times, and is still taken', () => {
    const h = harness();
    const got: NotchAnswer[] = [];
    h.surface.onAnswer((answer) => got.push(answer));
    h.hello('pc');
    for (let i = 0; i < 7; i++) {
      h.surface.show({ ...offer, id: `u${i}`, unasked: true });
      h.say('pc', { type: 'answer', n: i + 1, id: `u${i}`, act: 'yes', since: 120 });
    }
    expect(got.length).toBe(7);
    expect(h.logs.length).toBe(5);
    expect(h.logs[0]).toBe('[notch] a yes came 120 ms after its line was drawn, sooner than the 700 ms the line allows');
    // On a line that was asked for there is no such moment for a click, and at its end there is none at all.
    h.surface.show(offer);
    h.say('pc', { type: 'answer', n: 50, id: 'l1', act: 'yes', since: 10 });
    h.surface.show({ ...offer, id: 'u9', unasked: true });
    h.say('pc', { type: 'answer', n: 51, id: 'u9', act: 'yes', since: 700 });
    expect(h.logs.length).toBe(5);
  });
});

describe('a page the brain does not count as listening', () => {
  test('an answer from a page that never said hello here is refused: not taken, not acknowledged', () => {
    const h = harness();
    const got: NotchAnswer[] = [];
    h.surface.onAnswer((answer) => got.push(answer));
    h.hello('pc');
    h.surface.show(fuse);
    h.pushed.length = 0;
    h.say('stranger', { type: 'answer', n: 1, id: 'f1', act: 'done' });
    h.say('stranger', { type: 'hand', id: 'f1', on: true });
    h.say('stranger', { type: 'at', seq: 3 });
    expect(got).toEqual([]);
    expect(h.pushed).toEqual(Array.from({ length: 3 }, () => ({ to: 'stranger', message: { type: 'refuse', v: NOTCH_PROTOCOL_VERSION } })));
    expect(h.surface.listening()).toBe(1);
  });

  test('a page of another version is refused at its hello, told the brain\'s version, and sent nothing else', () => {
    for (const v of [1, 3]) {
      const h = harness();
      const refused: [string, number][] = [];
      const hellos: string[] = [];
      h.surface.onRefused((id, version) => refused.push([id, version]));
      h.surface.onHello((id) => hellos.push(id));
      h.surface.show(offer);
      h.say('pc', { type: 'hello', v });
      expect(h.pushed).toEqual([{ to: 'pc', message: { type: 'refuse', v: NOTCH_PROTOCOL_VERSION } }]);
      expect(h.surface.listening()).toBe(0);
      expect(hellos).toEqual([]);
      h.surface.setCount(5);
      h.surface.rest();
      expect(h.pushed.length).toBe(1);
      // It says hello again and again while it waits to be loaded anew: refused each time, said once.
      for (let i = 0; i < 20; i++) h.say('pc', { type: 'hello', v });
      expect(h.pushed.length).toBe(21);
      expect(refused).toEqual([['pc', v]]);
      expect(h.logs).toEqual([`[notch] the page speaks version ${v} of the messages, the brain version ${NOTCH_PROTOCOL_VERSION}: it is refused until it has loaded itself again`]);
      // On its next connection it is said again.
      h.gone('pc');
      h.say('pc', { type: 'hello', v });
      expect(refused.length).toBe(2);
    }
  });

  test('the brain never takes a done for a fuse from a page of another version', () => {
    const h = harness();
    const got: NotchAnswer[] = [];
    h.surface.onAnswer((answer) => got.push(answer));
    h.surface.show(fuse);
    h.say('old', { type: 'hello', v: 1 });
    // As a page of version 1 says it, and as a page of this version would.
    h.say('old', { type: 'answer', id: 'f1', act: 'done' });
    h.say('old', { type: 'answer', n: 1, id: 'f1', act: 'done', seen: true });
    h.say('old', { type: 'answer', id: 'f1', act: 'undo' });
    expect(got).toEqual([]);
    expect(h.surface.current().line?.id).toBe('f1');
  });

  test('a page that was listening and says hello in another version is no longer listening', () => {
    const h = harness();
    const got: NotchAnswer[] = [];
    h.surface.onAnswer((answer) => got.push(answer));
    h.hello('pc');
    h.surface.show(fuse);
    h.say('pc', { type: 'hello', v: 3 });
    expect(h.surface.listening()).toBe(0);
    h.say('pc', { type: 'answer', n: 1, id: 'f1', act: 'done' });
    expect(got).toEqual([]);
    // And is one again when it says hello in this one.
    h.hello('pc');
    h.say('pc', { type: 'answer', n: 1, id: 'f1', act: 'done' });
    expect(got.length).toBe(1);
  });

  test('after the brain was started again, a page that is still up is refused until it says hello, and then starts afresh', () => {
    const h = harness();
    h.hello('pc');
    h.surface.show(offer);
    const brain = (h.pushed[0]!.message as { brain: string }).brain;
    const got: NotchAnswer[] = [];
    h.restart().onAnswer((answer) => got.push(answer));
    // The new brain happens to show a line of the same name.
    h.surface.show(offer);
    h.pushed.length = 0;
    h.say('pc', { type: 'answer', n: 9, id: 'l1', act: 'yes' });
    expect(got).toEqual([]);
    expect(h.pushed.map((p) => p.message)).toEqual([{ type: 'refuse', v: NOTCH_PROTOCOL_VERSION }]);
    h.hello('pc');
    const state = h.pushed.at(-1)!.message as Extract<NotchToPage, { type: 'state' }>;
    expect(state.brain).not.toBe(brain);
    // Its numbers start again.
    expect(state.seq).toBe(1);
    // The page sends the answer it still holds once more: to this brain it is a first answer.
    h.say('pc', { type: 'answer', n: 9, id: 'l1', act: 'yes' });
    expect(got.length).toBe(1);
  });
});

describe('the brain folds an offer that was left alone', () => {
  const shown = (line: NotchLine = offer, pages: string[] = ['pc']) => {
    const h = harness();
    const got: [NotchAnswer, string | undefined][] = [];
    h.surface.onAnswer((answer, from) => got.push([answer, from]));
    for (const page of pages) h.hello(page);
    h.surface.show(line);
    h.pushed.length = 0;
    return { h, got };
  };

  test('after its time, not before: the line is gone, every page is told, and whoever waits hears a fold from nobody, a moment later', () => {
    const { h, got } = shown(offer, ['pc', 'laptop']);
    h.advance(NOTCH_FOLD_MS - 1);
    expect(got).toEqual([]);
    expect(h.pushed).toEqual([]);
    h.advance(1);
    expect(h.surface.current().line).toBeNull();
    // An answer given in its last moment may still be on its way: the fold is heard a moment later.
    h.advance(NOTCH_FOLD_GRACE_MS - 1);
    expect(got).toEqual([]);
    h.advance(1);
    expect(got).toEqual([[{ type: 'answer', id: 'l1', act: 'fold' }, undefined]]);
    expect(h.bare()).toEqual([{ type: 'patch', line: null }, { type: 'patch', line: null }]);
    expect(h.pushed.map((p) => p.to).sort()).toEqual(['laptop', 'pc']);
    expect(h.waiting()).toBe(0);
  });

  test('a page that never says a word cannot keep an offer for ever, and a lost fold cannot leave the brain waiting: there is none to lose', () => {
    const { h, got } = shown();
    h.advance(60_000);
    expect(got.map(([answer]) => answer.act)).toEqual(['fold']);
  });

  test('choices get their own time, a line says its own, and 0 stays', () => {
    const choices = shown({ id: 'c1', kind: 'offer', say: ['Which day?'], options: ['Thursday', 'Friday'] });
    choices.h.advance(NOTCH_FOLD_CHOICES_MS - 1);
    expect(choices.got).toEqual([]);
    choices.h.advance(1);
    choices.h.advance(NOTCH_FOLD_GRACE_MS);
    expect(choices.got.length).toBe(1);
    const own = shown({ ...offer, fold: 3000 });
    own.h.advance(NOTCH_FOLD_GRACE_MS);
    own.h.advance(3000);
    expect(own.got.length).toBe(1);
    const stays = shown({ ...offer, fold: 0 });
    stays.h.advance(3_600_000);
    expect(stays.got).toEqual([]);
    expect(stays.h.waiting()).toBe(0);
  });

  test('not under a hand: while a page says one is on it the line stays, and it goes soon after the hand does', () => {
    const { h, got } = shown();
    h.advance(NOTCH_FOLD_MS - 500);
    h.say('pc', { type: 'hand', id: 'l1', on: true });
    // The page says so again for as long as the hand is there.
    for (let i = 0; i < 10; i++) { h.advance(NOTCH_HAND_AGAIN_MS); h.say('pc', { type: 'hand', id: 'l1', on: true }); }
    expect(got).toEqual([]);
    h.say('pc', { type: 'hand', id: 'l1', on: false });
    h.advance(NOTCH_FOLD_HELD_MS);
    expect(got.map(([answer]) => answer.act)).toEqual(['fold']);
  });

  test('a page that said a hand is on it and then said nothing more is believed for a while, not for ever', () => {
    const { h, got } = shown();
    h.advance(NOTCH_FOLD_MS - 500);
    h.say('pc', { type: 'hand', id: 'l1', on: true });
    h.advance(NOTCH_HAND_HOLDS_MS - 1);
    expect(got).toEqual([]);
    h.advance(NOTCH_FOLD_HELD_MS + 1);
    h.advance(NOTCH_FOLD_GRACE_MS);
    expect(got.map(([answer]) => answer.act)).toEqual(['fold']);
  });

  test('with two desktops a hand on one holds the line on both, and a hand on another line counts for nothing', () => {
    const { h, got } = shown(offer, ['pc', 'laptop']);
    h.say('laptop', { type: 'hand', id: 'some-other-line', on: true });
    h.advance(NOTCH_FOLD_MS - 100);
    h.say('pc', { type: 'hand', id: 'l1', on: true });
    h.advance(1000);
    expect(got).toEqual([]);
    expect(h.pushed).toEqual([]);
    // The desktop with the hand on it goes away: its hand goes with it.
    h.gone('pc');
    h.advance(NOTCH_FOLD_HELD_MS);
    h.advance(NOTCH_FOLD_GRACE_MS);
    expect(got.map(([answer]) => answer.act)).toEqual(['fold']);
    expect(h.pushed.map((p) => p.to)).toEqual(['laptop']);
  });

  test('a word that is changed gives the offer a line\'s time again', () => {
    const { h, got } = shown({ id: 'c1', kind: 'offer', say: ['Which day?'], options: ['Thursday', 'Friday'] });
    h.advance(NOTCH_FOLD_CHOICES_MS - 1000);
    h.say('pc', { type: 'answer', n: 1, id: 'c1', act: 'word', word: 'day', value: 'Friday' });
    h.advance(NOTCH_FOLD_MS - 1);
    expect(got.map(([answer]) => answer.act)).toEqual(['word']);
    h.advance(1);
    h.advance(NOTCH_FOLD_GRACE_MS);
    expect(got.map(([answer]) => answer.act)).toEqual(['word', 'fold']);
  });

  test('an offer that was answered does not fold: a yes holds it, a no ends it, another line takes its place', () => {
    const yes = shown();
    yes.h.say('pc', { type: 'answer', n: 1, id: 'l1', act: 'yes' });
    yes.h.advance(60_000);
    expect(yes.got.map(([answer]) => answer.act)).toEqual(['yes']);
    expect(yes.h.surface.current().line?.id).toBe('l1');
    const no = shown();
    no.h.say('pc', { type: 'answer', n: 1, id: 'l1', act: 'no' });
    no.h.advance(60_000);
    expect(no.got.map(([answer]) => answer.act)).toEqual(['no']);
    const next = shown();
    next.h.advance(NOTCH_FOLD_MS - 1);
    next.h.surface.show({ id: 'r', kind: 'say', say: ['Later.'], ms: 2000 });
    next.h.advance(60_000);
    expect(next.got).toEqual([]);
    expect(next.h.surface.current().line?.id).toBe('r');
    const rested = shown();
    rested.h.surface.rest();
    rested.h.advance(60_000);
    expect(rested.got).toEqual([]);
    for (const each of [yes, no, next, rested]) expect(each.h.waiting()).toBe(0);
  });

  test('on a line that shows only Esc a yes is told and the line stays, so it still folds', () => {
    const { h, got } = shown({ id: 'e1', kind: 'offer', keys: 'esc', say: ['Try it.'], fold: 8000 });
    h.say('pc', { type: 'answer', n: 1, id: 'e1', act: 'yes' });
    h.advance(8000);
    h.advance(NOTCH_FOLD_GRACE_MS);
    expect(got.map(([answer]) => answer.act)).toEqual(['yes', 'fold']);
  });

  test('its time does not run while no page shows it: it starts when a page comes, and stops when the last one goes', () => {
    const h = harness();
    const got: NotchAnswer[] = [];
    h.surface.onAnswer((answer) => got.push(answer));
    h.surface.show(offer);
    h.advance(3_600_000);
    expect(got).toEqual([]);
    h.hello('pc');
    h.advance(NOTCH_FOLD_MS - 1);
    expect(got).toEqual([]);
    // The desktop app goes away with a millisecond to go, and is away for an hour.
    h.gone('pc');
    h.advance(3_600_000);
    expect(got).toEqual([]);
    expect(h.surface.current().line?.id).toBe('l1');
    h.hello('pc');
    h.advance(NOTCH_FOLD_MS - 1);
    expect(got).toEqual([]);
    h.advance(1);
    h.advance(NOTCH_FOLD_GRACE_MS);
    expect(got.map((answer) => answer.act)).toEqual(['fold']);
  });

  test('a page that comes up while another already shows the line does not give it its time again', () => {
    const { h, got } = shown();
    h.advance(NOTCH_FOLD_MS - 1000);
    h.hello('laptop');
    h.hello('pc');
    h.advance(1000);
    h.advance(NOTCH_FOLD_GRACE_MS);
    expect(got.map(([answer]) => answer.act)).toEqual(['fold']);
  });

  test('a fold a page still says (none does) is taken as before, and the brain\'s own does not come after it', () => {
    const { h, got } = shown(offer, ['pc', 'laptop']);
    h.say('pc', { type: 'answer', n: 1, id: 'l1', act: 'fold' });
    h.advance(60_000);
    expect(got.map(([answer]) => answer.act)).toEqual(['fold']);
    expect(h.bare()).toEqual([{ type: 'ack', n: 1, took: true }, { type: 'patch', line: null }]);
  });

  test('a surface that was given no timers folds nothing: an offer waits until it is answered', () => {
    const h = harness({ timers: false });
    const got: NotchAnswer[] = [];
    h.surface.onAnswer((answer) => got.push(answer));
    h.hello('pc');
    h.surface.show(offer);
    h.advance(3_600_000);
    expect(got).toEqual([]);
    expect(h.surface.current().line?.id).toBe('l1');
  });

  test('only an offer folds', () => {
    for (const line of [
      { id: 's', kind: 'sheet', say: ['Read'], blocks: [], yes: 'send' }, { id: 'a', kind: 'ask', say: [], placeholder: 'Ask', yes: 'ask', blocks: [] },
      { id: 'w', kind: 'work', say: ['Working'], steps: 0, done: 0 }, { id: 'h', kind: 'listen', say: [], heard: '' }, fuse,
    ] as NotchLine[]) {
      const { h, got } = shown(line);
      h.advance(3_600_000);
      expect(got).toEqual([]);
      expect(h.waiting()).toBe(0);
    }
  });
});

// Point 7 of the notch review, 26 November 2026 (docs/notch/fixes/07-page-renderer.md).
describe('a page that comes up in the middle of a line that runs out', () => {
  const stateLine = (h: ReturnType<typeof harness>): NotchLine | null => {
    const last = h.pushed.at(-1)!.message;
    return last.type === 'state' ? last.line : null;
  };

  test('is told how much of a fuse is left, so it goes on from there and does not start again', () => {
    const h = harness();
    h.surface.show(fuse);
    h.advance(1500);
    h.hello('pc');
    expect(stateLine(h)).toEqual(notchRuled({ ...fuse, left: 2500 }));
    // The line the brain keeps is as it was: what is left is worked out for each page that asks.
    expect(h.surface.current().line).toEqual(fuse);
    h.advance(1000);
    h.hello('laptop');
    expect(stateLine(h)).toEqual(notchRuled({ ...fuse, left: 1500 }));
    // Past its time (the brain waits a little longer for the page's word): nothing is left, never less.
    h.advance(2000);
    h.hello('pc');
    expect(stateLine(h)).toEqual(notchRuled({ ...fuse, left: 0 }));
  });

  test('and how much of a result is left', () => {
    const h = harness();
    const result: NotchLine = { id: 'r1', kind: 'say', say: ['Sent.'], ms: 2400 };
    h.surface.show(result);
    h.advance(400.4);
    h.hello('pc');
    expect(stateLine(h)).toEqual(notchRuled({ ...result, left: 2000 }));
  });

  test('a line shown to pages that are there is shown as it is: all of its time is left', () => {
    const h = harness();
    h.hello('pc');
    h.surface.show(fuse);
    expect(h.bare().at(-1)).toEqual({ type: 'patch', line: notchRuled(fuse) });
    // Shown again, its time starts again.
    h.advance(3000);
    h.surface.show(fuse);
    h.advance(500);
    h.hello('pc');
    expect(stateLine(h)).toEqual(notchRuled({ ...fuse, left: 3500 }));
  });

  test('a line that does not run out by itself is told as it is', () => {
    const h = harness({ timers: false });
    h.surface.show(offer);
    h.advance(5000);
    h.hello('pc');
    expect(stateLine(h)).toEqual(notchRuled(offer));
  });

  test('a clock that was set back does not leave more than all of it', () => {
    const h = harness();
    h.set(5000);
    h.surface.show(fuse);
    h.set(100);
    h.hello('pc');
    expect(stateLine(h)).toEqual(notchRuled({ ...fuse, left: 4000 }));
  });
});

describe('a message the page will not be able to read', () => {
  test('is said where it was made, a few times only, and is still sent', () => {
    const h = harness();
    h.hello('pc');
    h.surface.show(offer);
    expect(h.logs).toEqual([]);
    // A sheet with no blocks.
    for (let i = 0; i < 8; i++) h.surface.show({ id: `bad${i}`, kind: 'sheet', say: ['Approve?'], yes: 'approve' } as never);
    expect(h.logs.length).toBe(5);
    expect(h.logs[0]).toBe('[notch] a patch message (sheet, bad0) is not one the page can read: it will be dropped there');
    expect(h.pushed.filter((p) => p.message.type === 'patch').length).toBe(9);
  });
});

describe('two desktop apps on one brain', () => {
  const two = (): ReturnType<typeof harness> => {
    const h = harness();
    h.hello('pc');
    h.hello('laptop');
    h.pushed.length = 0;
    return h;
  };
  const types = (h: ReturnType<typeof harness>, to: string): string[] =>
    h.to(to).map((m) => (m.type === 'patch' && 'line' in m ? (m.line ? 'line' : 'rest') : m.type));

  test('a no or a fold on one takes the line off the other, which would have kept it for ever', () => {
    for (const act of ['no', 'fold'] as const) {
      const h = two();
      h.surface.show({ ...offer, fold: 0 });
      h.pushed.length = 0;
      h.say('pc', { type: 'answer', id: 'l1', act });
      // The one that answered went back to rest by itself, and is told nothing.
      expect(h.pushed.map((p) => [p.to, bare(p.message)])).toEqual([['laptop', { type: 'patch', line: null }]]);
    }
  });

  test('a result that one of them finished showing leaves the other too', () => {
    for (const act of ['done', 'yes'] as const) {
      const h = two();
      h.surface.show({ id: 'r1', kind: 'say', say: ['Sent.'], ms: 2000 });
      h.pushed.length = 0;
      h.say('laptop', { type: 'answer', id: 'r1', act });
      expect(h.pushed.map((p) => [p.to, bare(p.message)])).toEqual([['pc', { type: 'patch', line: null }]]);
    }
  });

  test('the other is told before whoever hears the answer shows the next thing, so the next thing is not what is taken off', () => {
    const h = two();
    h.surface.onAnswer(() => { h.surface.show({ id: 'next', kind: 'say', say: ['Not now, then.'], ms: 2000 }); });
    h.surface.show(offer);
    h.pushed.length = 0;
    h.say('pc', { type: 'answer', id: 'l1', act: 'no' });
    expect(types(h, 'laptop')).toEqual(['rest', 'line']);
    expect(types(h, 'pc')).toEqual(['line']);
  });

  test('a yes on one leaves it dimmed there until the brain says what next; a no on the other after it is late, and that page is shown the line answered', () => {
    const h = two();
    h.surface.show(offer);
    h.pushed.length = 0;
    const got: string[] = [];
    h.surface.onAnswer((answer) => got.push(answer.act));
    h.say('pc', { type: 'answer', id: 'l1', act: 'yes' });
    // After a yes the line stays, here and on both pages.
    expect(h.pushed).toEqual([]);
    // The first answer that holds the line stands: the no is not taken, and takes nothing off.
    h.say('laptop', { type: 'answer', n: 1, id: 'l1', act: 'no' });
    expect(got).toEqual(['yes']);
    expect(h.surface.current().line?.id).toBe('l1');
    expect(h.pushed.map((p) => [p.to, p.message.type])).toEqual([['laptop', 'ack'], ['laptop', 'patch']]);
    expect(h.pushed[0]!.message).toMatchObject({ type: 'ack', n: 1, took: false });
    expect(h.pushed[1]!.message).toMatchObject({ type: 'patch', line: { id: 'l1', held: true } });
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
    h.hello('pc');
    h.surface.show(offer);
    h.pushed.length = 0;
    h.say('pc', { type: 'answer', id: 'l1', act: 'no' });
    expect(h.pushed).toEqual([]);
  });

  test('each is acknowledged its own answers by its own numbers, and the same number from both is two answers', () => {
    const h = two();
    const got: [string | undefined, string | undefined][] = [];
    h.surface.onAnswer((answer, from) => got.push([answer.button, from]));
    h.surface.show({ id: 's1', kind: 'sheet', say: ['Pick'], blocks: [{ kind: 'buttons', buttons: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] });
    h.pushed.length = 0;
    h.say('pc', { type: 'answer', n: 1, id: 's1', act: 'button', button: 'a' });
    h.say('laptop', { type: 'answer', n: 1, id: 's1', act: 'button', button: 'b' });
    h.say('pc', { type: 'answer', n: 1, id: 's1', act: 'button', button: 'a' });
    h.say('laptop', { type: 'answer', n: 1, id: 's1', act: 'button', button: 'b' });
    expect(got).toEqual([['a', 'pc'], ['b', 'laptop']]);
    expect(h.pushed).toEqual([
      { to: 'pc', message: { type: 'ack', n: 1, took: true } }, { to: 'laptop', message: { type: 'ack', n: 1, took: true } },
      { to: 'pc', message: { type: 'ack', n: 1, took: true } }, { to: 'laptop', message: { type: 'ack', n: 1, took: true } },
    ]);
  });

  test('a no on one, sent again after the other was told to rest, is acknowledged and takes nothing more off', () => {
    const h = two();
    const got: NotchAnswer[] = [];
    h.surface.onAnswer((answer) => { got.push(answer); if (got.length === 1) h.surface.show({ id: 'next', kind: 'say', say: ['Later.'], ms: 2000 }); });
    h.surface.show(offer);
    h.pushed.length = 0;
    h.say('pc', { type: 'answer', n: 1, id: 'l1', act: 'no' });
    const before = h.pushed.length;
    h.say('pc', { type: 'answer', n: 1, id: 'l1', act: 'no' });
    expect(got.length).toBe(1);
    expect(h.pushed.slice(before)).toEqual([{ to: 'pc', message: { type: 'ack', n: 1, took: true } }]);
    expect(h.surface.current().line?.id).toBe('next');
  });

  test('one says yes, the other is in the middle of sending its own yes again when it goes away: one yes, and the line waits for the brain', () => {
    const h = two();
    const got: [string, string | undefined][] = [];
    h.surface.onAnswer((answer, from) => got.push([answer.act, from]));
    h.surface.show(offer);
    h.say('laptop', { type: 'answer', n: 4, id: 'l1', act: 'word', word: 'x', value: 'y' });
    h.gone('laptop');
    h.say('pc', { type: 'answer', n: 1, id: 'l1', act: 'yes' });
    // What the laptop still sends reaches the brain after its connection came back, before its hello and after.
    h.say('laptop', { type: 'answer', n: 4, id: 'l1', act: 'word', word: 'x', value: 'y' });
    h.hello('laptop');
    h.say('laptop', { type: 'answer', n: 4, id: 'l1', act: 'word', word: 'x', value: 'y' });
    expect(got).toEqual([['word', 'laptop'], ['yes', 'pc']]);
    expect(h.surface.current().line?.id).toBe('l1');
  });
});

describe('a script that waits on the surface', () => {
  const play = () => {
    const h = harness();
    const due: { at: number; fn: () => void }[] = [];
    const stage = new NotchStage(h.surface, {
      setTimeout: (fn, ms) => { const entry = { at: ms, fn }; due.push(entry); return entry; },
      clearTimeout: (handle) => { const at = due.indexOf(handle as { at: number; fn: () => void }); if (at >= 0) due.splice(at, 1); },
    }, 'test', { prefix: 't' });
    h.surface.onAnswer((answer, from) => stage.heard(answer, from));
    h.hello('pc');
    h.hello('laptop');
    return { h, stage, late: () => { for (const entry of [...due]) entry.fn(); } };
  };
  const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  test('a yes sent four times is one yes to the script, and nothing of it is left for the next wait on that line', async () => {
    const { h, stage } = play();
    const id = stage.id();
    stage.put({ id, kind: 'sheet', say: ['Send?'], blocks: [], yes: 'send' });
    const first = stage.answer(id, ['yes']);
    for (let i = 0; i < 4; i++) h.say('pc', { type: 'answer', n: 1, id, act: 'yes' });
    expect((await first).act).toBe('yes');
    // The script shows the same sheet changed, and waits for another yes: the copies are not it.
    stage.put({ id, kind: 'sheet', say: ['Send this instead?'], blocks: [], yes: 'send' });
    let again = false;
    void stage.answer(id, ['yes']).then(() => { again = true; }, () => {});
    await settle();
    expect(again).toBe(false);
    h.say('pc', { type: 'answer', n: 2, id, act: 'yes' });
    await settle();
    expect(again).toBe(true);
    stage.stop();
  });

  test('a fuse that was taken back hears no "it ran out" afterwards, from the same desktop or the other', async () => {
    const { h, stage } = play();
    const burning = stage.fuse(['Sending'], 3000);
    const id = h.surface.current().line!.id;
    h.say('pc', { type: 'answer', n: 1, id, act: 'undo' });
    expect(await burning).toBe('undo');
    h.say('pc', { type: 'answer', n: 2, id, act: 'done' });
    h.say('laptop', { type: 'answer', n: 1, id, act: 'done' });
    // Nothing of it was kept for a later wait on that line.
    let heard = false;
    void stage.answer(id, ['done']).then(() => { heard = true; }, () => {});
    await settle();
    expect(heard).toBe(false);
    stage.stop();
  });

  test('a fuse that ran out on both desktops ran out once', async () => {
    const { h, stage } = play();
    const burning = stage.fuse(['Sending'], 3000);
    const id = h.surface.current().line!.id;
    h.say('pc', { type: 'answer', n: 1, id, act: 'done' });
    h.say('laptop', { type: 'answer', n: 1, id, act: 'done' });
    h.say('pc', { type: 'answer', n: 1, id, act: 'done' });
    expect(await burning).toBe('done');
    let heard = false;
    void stage.answer(id, ['done', 'undo']).then(() => { heard = true; }, () => {});
    await settle();
    expect(heard).toBe(false);
    stage.stop();
  });

  test('a letter still needs a page to vouch for it, and a desktop app that comes back in the middle can be the one', async () => {
    const { h, stage } = play();
    const going = stage.letter(['Sending'], 5000, [{ kind: 'paper', lines: [['Hi Marco']] }]);
    const id = h.surface.current().line!.id;
    h.gone('pc');
    // The laptop's page says it ran out and does not vouch. That is not a yes, and does not end the wait.
    h.say('laptop', { type: 'answer', n: 1, id, act: 'done' });
    // The pc comes back in the middle: it is told how much is left, and vouches.
    h.advance(2000);
    h.hello('pc');
    expect((h.pushed.at(-1)!.message as Extract<NotchToPage, { type: 'state' }>).line).toMatchObject({ id, left: 3000 });
    h.say('pc', { type: 'answer', n: 1, id, act: 'done', seen: true });
    h.say('pc', { type: 'answer', n: 1, id, act: 'done', seen: true });
    expect(await going).toBe('done');
    stage.stop();
  });

  test('a fuse whose page went away and came back as another version is lost: nothing is sent on its word', async () => {
    const { h, stage, late } = play();
    const burning = stage.fuse(['Sending'], 3000);
    const id = h.surface.current().line!.id;
    h.gone('laptop');
    h.gone('pc');
    h.say('pc', { type: 'hello', v: 1 });
    h.say('pc', { type: 'answer', id, act: 'done' });
    late();
    expect(await burning).toBe('lost');
    stage.stop();
  });

  test('an offer the brain folds ends the script\'s wait as a fold a page said used to', async () => {
    const { h, stage } = play();
    const asked = stage.offer(['Reply?'], 'show');
    h.advance(NOTCH_FOLD_MS + NOTCH_FOLD_GRACE_MS);
    expect((await asked).act).toBe('fold');
    stage.stop();
  });

  test('over a long script the stage remembers a fixed number of answers and of finished lines', async () => {
    const { h, stage } = play();
    for (let i = 0; i < 600; i++) {
      const said = stage.say(['Done.'], 1000);
      const id = h.surface.current().line!.id;
      h.say('pc', { type: 'answer', n: i + 1, id, act: 'done' });
      await said;
    }
    const inside = stage as unknown as { taken: Set<string>; closed: Set<string>; unheard: unknown[] };
    expect(inside.taken.size).toBeLessThanOrEqual(200);
    expect(inside.closed.size).toBeLessThanOrEqual(200);
    expect(inside.unheard.length).toBe(0);
    stage.stop();
  });
});
