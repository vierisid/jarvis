import { describe, expect, test } from 'bun:test';
import { NOTCH_AROUND_EVENT, NOTCH_CALL_AFTER_MS, NOTCH_CALL_ENDS_AFTER_MS, NOTCH_CALL_MOST_MS, NOTCH_OFFLINE_AFTER_MS, attachNotchAround, NOTCH_ONLINE_WAIT_MS } from './around.ts';
import { NotchInbox } from './inbox.ts';
import type { NotchItem, NotchItemEnd } from './inbox.ts';
import type { NotchAnswerAct, NotchLine, NotchToPage } from './protocol.ts';
import type { NotchStage } from './stage.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface, type NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function harness(options: { meetingNow?: () => boolean; asleep?: () => boolean; listen?: NonNullable<Parameters<typeof attachNotchAround>[3]>['listen']; went?: () => number | void | Promise<number | void> } = {}) {
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
  let homes = 0;
  /** Home, as the product has it: what a tap on the resting notch opens when nothing waits. Here it shows the call's row. */
  const inbox: NotchInbox = new NotchInbox(surface, {
    clock, log: () => {},
    home: async (stage) => {
      homes++;
      const row = around.callRow();
      const answer = await stage.sheet(['Home'], row ? [row] : []);
      if (answer.act === 'go' && answer.row === 'call') await around.callOpen(stage);
    },
  });
  const fromPage = (message: unknown): void => pageEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 2 });
  let backOnline = 0;
  const logs: string[] = [];
  const around: ReturnType<typeof attachNotchAround> = attachNotchAround(surface, inbox, {
    onEvent(listener) { aroundEvent = listener; },
    onSidecarDisconnected(listener) { gone = listener; },
  }, { ...options, backOnline: () => { backOnline++; return options.went?.(); }, clock, now: () => now, log: (line) => logs.push(line) });
  const line = (): NotchLine | null => surface.current().line;
  const item = (id: string): NotchItem => ({
    id, subject: id, class: 'person', speaks: true, title: () => [`${id} waits`],
    async play(stage: NotchStage): Promise<NotchItemEnd> { return (await stage.offer([`${id}?`], 'yes')).act === 'yes' ? 'settled' : 'waits'; },
  });
  return {
    around, inbox, surface, pushed, logs, line, item,
    backOnline: () => backOnline,
    homes: (): number => homes,
    said: (): string => (line()?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join(''),
    count: (): number => surface.current().count,
    parks: (): number[] => pushed.flatMap((message) => (message.type === 'patch' && message.park !== undefined ? [message.park] : [])),
    async tell(payload: Record<string, unknown>, id = 'pc'): Promise<void> { aroundEvent(id, { event_type: NOTCH_AROUND_EVENT, payload }); await settle(); },
    async leave(id = 'pc'): Promise<void> { gone(id); await settle(); },
    async answer(act: NotchAnswerAct, more: Record<string, unknown> = {}): Promise<void> { fromPage({ type: 'answer', id: line()!.id, act, ...more }); await settle(); },
    /** A yes or a tap with nothing on the notch. */
    open(): void { fromPage({ type: 'open' }); },
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

  // The prototype: "Back online. 2 things I was holding went out."
  test('when things that were held went out, the line says how many', async () => {
    for (const [went, said] of [[2, 'Back online. 2 things I was holding went out.'], [1, 'Back online. 1 thing I was holding went out.'], [0, 'Back online.'], [-3, 'Back online.'], [2.9, 'Back online. 2 things I was holding went out.']] as const) {
      const h = harness({ went: async () => went });
      await h.tell({ online: false });
      await h.pass(NOTCH_OFFLINE_AFTER_MS);
      await h.answer('done');
      await h.tell({ online: true });
      await h.pass(0);
      expect(h.said()).toBe(said);
    }
    // Known at once, it is said at once.
    const now = harness({ went: () => 3 });
    await now.tell({ online: false });
    await now.pass(NOTCH_OFFLINE_AFTER_MS);
    await now.answer('done');
    await now.tell({ online: true });
    expect(now.said()).toBe('Back online. 3 things I was holding went out.');
  });

  test('it does not wait long for what was held: the connection is back either way, and it is said once', async () => {
    let done!: (went: number) => void;
    const h = harness({ went: () => new Promise<number>((resolve) => { done = resolve; }) });
    await h.tell({ online: false });
    await h.pass(NOTCH_OFFLINE_AFTER_MS);
    await h.answer('done');
    await h.tell({ online: true });
    expect(h.line()).toBeNull();
    await h.pass(NOTCH_ONLINE_WAIT_MS);
    expect(h.said()).toBe('Back online.');
    await h.answer('done');
    // What went out later is not announced a second time.
    done(2);
    await h.pass(0);
    expect(h.line()).toBeNull();
    // And when the sending fails, the return is still said.
    const fails = harness({ went: () => Promise.reject(new Error('the mailbox cannot be reached')) });
    await fails.tell({ online: false });
    await fails.pass(NOTCH_OFFLINE_AFTER_MS);
    await fails.answer('done');
    await fails.tell({ online: true });
    await fails.pass(0);
    expect(fails.said()).toBe('Back online.');
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

describe('pass 12: after a call', () => {
  test('what waited on the edge is pulled in and it stretches awake', async () => {
    const h = harness();
    await h.tell({ call: true });
    await h.pass(NOTCH_CALL_AFTER_MS);
    await h.answer('done');
    h.inbox.add(h.item('mail'));
    await h.pass(2100);
    await h.tell({ call: false });
    await h.pass(60_000);
    // The bumps are taken off the edge (kept by the brain, so told as a change to what the notch is), and it stretches once.
    expect(h.parks().at(-1)).toBe(0);
    expect(h.pushed.some((m) => m.type === 'effect' && m.gesture === 'wake')).toBe(true);
  });

  test('with its eyes closed it does not: waking would open them', async () => {
    const h = harness();
    await h.tell({ call: true });
    await h.pass(NOTCH_CALL_AFTER_MS);
    await h.answer('done');
    h.inbox.add(h.item('mail'));
    await h.pass(2100);
    h.surface.setFace('closed');
    await h.tell({ call: false });
    await h.pass(60_000);
    expect(h.pushed.some((m) => m.type === 'effect' && m.gesture === 'wake')).toBe(false);
    expect(h.parks().at(-1)).toBe(0);
  });
});

// Listening to a call (./call.ts): the question takes the place of "On a
// call. I hold everything", and what came out of the call is said before
// what was held.
describe('a call that can be listened to', () => {
  test('the question is asked for this call, on the machine that said a call is on, and then everything is held', async () => {
    const asked: string[] = [];
    const h = harness({ meetingNow: () => true, listen: {
      offer: async (stage, sidecarId) => {
        asked.push(sidecarId);
        const answer = await stage.offer(['On a call. Listen and write it down?'], 'listen');
        if (answer.act !== 'yes') return false;
        await stage.say(['Listening. I hold everything else until you are done.'], 3000);
        return true;
      },
      ended: () => null,
    } });
    await h.tell({ call: true }, 'laptop');
    expect(asked).toEqual(['laptop']);
    expect(h.said()).toBe('On a call. Listen and write it down?');
    await h.answer('yes');
    // Its own words, and not "On a call. I hold everything" after them.
    expect(h.said()).toBe('Listening. I hold everything else until you are done.');
    await h.answer('done');
    expect(h.line()).toBeNull();
    // Held from here on, as on any call.
    h.inbox.add(h.item('mail'));
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
  });

  test('a no is followed by the usual line, and the call is held as ever', async () => {
    const h = harness({ meetingNow: () => true, listen: { offer: async (stage) => { await stage.offer(['On a call. Listen and write it down?'], 'listen'); return false; }, ended: () => null } });
    await h.tell({ call: true });
    await h.answer('no');
    expect(h.said()).toBe('On a call. I hold everything until you are done.');
  });

  test('what came out of the call is said first, and what was held is offered after it', async () => {
    let done: () => void = () => {};
    let ended = 0;
    const h = harness({ meetingNow: () => true, listen: {
      offer: async (stage) => { await stage.say(['Listening. I hold everything else until you are done.'], 3000); return true; },
      ended: () => { ended++; return new Promise<void>((resolve) => { done = resolve; }); },
    } });
    await h.tell({ call: true });
    await h.answer('done');
    h.inbox.add(h.item('mail'));
    await settle();
    await h.tell({ call: false });
    await h.pass(NOTCH_CALL_ENDS_AFTER_MS);
    expect(ended).toBe(1);
    // The notes are still being put on the notch: what was held waits for them.
    expect(h.said()).not.toContain('I held');
    done();
    await settle();
    expect(h.said()).toBe('Call ended. I held 1 thing.');
  });

  // The owner, 18 November 2026, late: "if I start a meeting and I do not accept the meeting feature ... I
  // cannot use Jarvis in anything else. If I try to open the Jarvis menu ... it just tells me you're in a
  // meeting. Do you want me to start transcribing? ... so I can't access anything else." The question used
  // to be asked again at every tap on the resting notch, for the whole call.
  test('a no to the question is the answer for the call: a tap on the resting notch opens Home, and the question is not asked again', async () => {
    let offers = 0;
    const h = harness({ meetingNow: () => true, listen: {
      offer: async (stage) => { offers++; const answer = await stage.offer(['On a call. Listen and write it down?'], 'listen'); return answer.act === 'yes'; },
      ended: () => null,
    } });
    await h.tell({ call: true });
    expect(h.said()).toBe('On a call. Listen and write it down?');
    await h.answer('no');
    await h.answer('done');
    expect(h.line()).toBeNull();
    expect(offers).toBe(1);
    for (let i = 0; i < 3; i++) {
      h.open();
      await settle();
      expect(h.said()).toBe('Home');
      await h.answer('no');
    }
    expect(h.homes()).toBe(3);
    expect(offers).toBe(1);
    // The call is over: a tap is a tap as ever.
    await h.tell({ call: false });
    await h.pass(NOTCH_CALL_ENDS_AFTER_MS);
    h.open();
    await settle();
    expect(h.said()).toBe('Home');
    expect(offers).toBe(1);
  });

  test('left unanswered, the question is not asked again either: it had its 45 seconds', async () => {
    let offers = 0;
    const h = harness({ meetingNow: () => true, listen: {
      offer: async (stage) => { offers++; const answer = await stage.offer(['On a call. Listen and write it down?'], 'listen'); return answer.act === 'yes'; },
      ended: () => null,
    } });
    await h.tell({ call: true });
    await h.answer('fold');
    await h.answer('done');
    h.open();
    await settle();
    expect(h.said()).toBe('Home');
    expect(offers).toBe(1);
  });

  test('Home says that a call is on, and its row is the way to have it listened to after all, by that one press', async () => {
    const started: string[] = [];
    let listening = false;
    const h = harness({ meetingNow: () => true, listen: {
      offer: async (stage) => (await stage.offer(['On a call. Listen and write it down?'], 'listen')).act === 'yes',
      ended: () => null,
      listening: () => listening,
      can: () => !listening,
      start: async (stage, sidecarId) => { started.push(sidecarId); listening = true; await stage.say(['Listening. I hold everything else until you are done.'], 3200); return true; },
    } });
    // No call: Home has no such row.
    expect(h.around.callRow()).toBeNull();
    await h.tell({ call: true });
    // While the question itself is still up, there is no row yet: the question is the way.
    expect(h.around.callRow()).toBeNull();
    await h.answer('no');
    await h.answer('done');
    expect(h.around.callRow()).toEqual({ kind: 'row', id: 'call', lead: 'Call', say: ['You are on a call. Listen and write it down'], go: true });
    h.open();
    await settle();
    await h.answer('go', { row: 'call' });
    // No second question: the press is the yes for this call.
    expect(started).toEqual(['pc']);
    expect(h.said()).toBe('Listening. I hold everything else until you are done.');
    await h.answer('done');
    // Listened to now: the row says so, and there is nothing to press.
    expect(h.around.callRow()).toEqual({ kind: 'row', lead: 'Call', say: ['I am listening to this call, and writing it down.'] });
    // And Home still opens.
    h.open();
    await settle();
    expect(h.said()).toBe('Home');
    await h.answer('no');
    // After the call there is no row.
    await h.tell({ call: false });
    await h.pass(NOTCH_CALL_ENDS_AFTER_MS);
    expect(h.around.callRow()).toBeNull();
  });

  test('where it cannot be listened to, Home says only that a call is on', async () => {
    const none = harness({ meetingNow: () => true });
    await none.tell({ call: true });
    await none.answer('done');
    expect(none.around.callRow()).toEqual({ kind: 'row', lead: 'Call', say: ['You are on a call. What comes by itself waits until it is over.'] });
    const cannot = harness({ meetingNow: () => true, listen: { offer: async () => false, ended: () => null, can: () => false, start: async () => false } });
    await cannot.tell({ call: true });
    await cannot.answer('done');
    expect(cannot.around.callRow()).toMatchObject({ say: ['You are on a call. What comes by itself waits until it is over.'] });
    // Pressing a row that is not there starts nothing.
    await none.around.callOpen(null as never);
  });

  test('on a call, what waits can be gone through by a tap; what comes by itself still does not speak up', async () => {
    const h = harness({ meetingNow: () => true, listen: { offer: async (stage) => (await stage.offer(['On a call. Listen and write it down?'], 'listen')).act === 'yes', ended: () => null } });
    await h.tell({ call: true });
    await h.answer('no');
    await h.answer('done');
    h.inbox.add(h.item('held'));
    await settle();
    // It does not speak up: the call holds it.
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
    // The person taps: they asked, and it is shown.
    h.open();
    await settle();
    expect(h.said()).toBe('held?');
    await h.answer('yes');
    expect(h.count()).toBe(0);
  });

  // The owner, 18 November 2026: on a call that is not listened to, the talk
  // keys work. What the person starts is let through the call's hold, and
  // talking while the question is still up takes the question's place.
  test('what the person starts themselves is shown during the call; what comes by itself still waits', async () => {
    const h = harness({ meetingNow: () => true, listen: { offer: async (stage) => { await stage.offer(['On a call. Listen and write it down?'], 'listen'); return false; }, ended: () => null } });
    const asked = (id: string): NotchItem => ({ ...h.item(id), asked: true, urgent: true, returns: true });
    await h.tell({ call: true });
    expect(h.said()).toBe('On a call. Listen and write it down?');
    // He does not answer the question: he holds the talk keys.
    h.inbox.add(asked('talk'));
    await settle();
    expect(h.said()).toBe('talk?');
    await h.answer('yes');
    // The call is held from here on, for everything he did not start.
    h.inbox.add(h.item('mail'));
    await settle();
    expect(h.line()).toBeNull();
    expect(h.count()).toBe(1);
    // And he can talk to it again, any time during the call.
    h.inbox.add(asked('talk again'));
    await settle();
    expect(h.said()).toBe('talk again?');
  });

  test('a call that was not listened to ends as it always did', async () => {
    const h = harness({ meetingNow: () => true, listen: { offer: async () => false, ended: () => null } });
    await h.tell({ call: true });
    await h.answer('done');
    h.inbox.add(h.item('mail'));
    await settle();
    await h.tell({ call: false });
    await h.pass(NOTCH_CALL_ENDS_AFTER_MS);
    expect(h.said()).toBe('Call ended. I held 1 thing.');
  });
});
