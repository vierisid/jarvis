/**
 * The registry of the notch's features (./registry.ts): its one scheduler,
 * its one way down, and what it gathers for Home. The features here are
 * stand-ins made for the test; the real ones are followed in real.test.ts and
 * real-wiring.test.ts.
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { NotchFeature, NotchFeatureDef, NotchFeatureId, NotchOrder } from './feature.ts';
import type { NotchIntent } from './intents.ts';
import type { NotchBlock } from './protocol.ts';
import type { NotchDone } from './today.ts';
import { NOTCH_TICK_FAILURE_SAID_MS, createNotchRegistry } from './registry.ts';

type Started = { fn: () => void; ms: number; cleared: boolean; unrefed: boolean; handle: unknown };
const realSet = globalThis.setInterval;
const realClear = globalThis.clearInterval;
afterEach(() => { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; setSystemTime(); });

/** A registry whose clocks are run by hand, with a log and a record of what happened in which order. */
function world(more: { noInbox?: boolean; order?: Partial<NotchOrder> } = {}) {
  const started: Started[] = [];
  const order: string[] = [];
  const logs: string[] = [];
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    const one: Started = { fn, ms, cleared: false, unrefed: false, handle: null };
    one.handle = { unref() { one.unrefed = true; } };
    started.push(one);
    return one.handle;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((handle: unknown) => {
    const one = started.find((each) => each.handle === handle);
    if (one) { one.cleared = true; order.push(`clock ${one.ms} cleared`); } else realClear(handle as never);
  }) as typeof clearInterval;
  const state = { paused: false };
  const registry = createNotchRegistry({
    surface: { name: 'the surface' } as never, settings: null, now: () => 42, log: (line) => logs.push(line), paused: () => state.paused,
    order: more.order,
  });
  const inbox = { stop() { order.push('inbox stopped'); } };
  if (!more.noInbox) registry.setInbox(inbox as never);
  return { registry, started, order, logs, state, inbox };
}

/** A stand-in feature under a real id. What it is made of is the test's own. */
const feature = (id: NotchFeatureId, make: NotchFeatureDef<NotchFeatureId>['make'], more: Partial<NotchFeatureDef<NotchFeatureId>> = {}): NotchFeatureDef<NotchFeatureId> => ({ id, make, ...more });
const api = (name: string): never => ({ name }) as never;
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('the scheduler', () => {
  test('a clock runs what it was given, at its pace, and does not keep the process alive', () => {
    const w = world();
    let ran = 0;
    w.registry.every('counting', 1234, () => { ran++; });
    expect(w.started.map((one) => [one.ms, one.unrefed])).toEqual([[1234, true]]);
    w.started[0]!.fn();
    w.started[0]!.fn();
    expect(ran).toBe(2);
  });

  test('a run that throws is said in the log, with where it failed, and throws nothing', () => {
    const w = world();
    w.registry.every('looking for trouble', 1000, () => { throw new Error('it broke'); });
    expect(() => w.started[0]!.fn()).not.toThrow();
    expect(w.logs).toHaveLength(1);
    expect(w.logs[0]!.split('\n')[0]).toBe('[notch] looking for trouble failed: it broke');
    expect(w.logs[0]).toContain('registry.test.ts');
  });

  test('one that fails at every run says so the first time, then at most once a minute with how often', () => {
    const w = world();
    w.registry.every('looking for trouble', 1000, () => { throw new Error('it broke'); });
    const start = Date.now();
    setSystemTime(new Date(start));
    for (let run = 0; run < 5; run++) w.started[0]!.fn();
    setSystemTime(new Date(start + NOTCH_TICK_FAILURE_SAID_MS - 1));
    w.started[0]!.fn();
    expect(w.logs.map((line) => line.split('\n')[0])).toEqual(['[notch] looking for trouble failed: it broke']);
    setSystemTime(new Date(start + NOTCH_TICK_FAILURE_SAID_MS));
    w.started[0]!.fn();
    setSystemTime(new Date(start + 2 * NOTCH_TICK_FAILURE_SAID_MS));
    w.started[0]!.fn();
    expect(w.logs.map((line) => line.split('\n')[0])).toEqual([
      '[notch] looking for trouble failed: it broke',
      '[notch] looking for trouble failed (and 5 more times since that was last said): it broke',
      '[notch] looking for trouble failed: it broke',
    ]);
    // Where it failed is said the first time only.
    expect(w.logs.filter((line) => line.includes('registry.test.ts'))).toHaveLength(1);
  });

  test('two clocks that fail are counted apart', () => {
    const w = world();
    w.registry.every('the first', 1000, () => { throw new Error('one'); });
    w.registry.every('the second', 1000, () => { throw 'two'; });
    for (const one of w.started) { one.fn(); one.fn(); }
    expect(w.logs.map((line) => line.split('\n')[0])).toEqual(['[notch] the first failed: one', '[notch] the second failed: two']);
  });

  test('a run that fails later, not at once, is said in the same way and is no unhandled rejection', async () => {
    const w = world();
    w.registry.every('looking slowly', 1000, async () => { await Promise.resolve(); throw new Error('later'); });
    w.started[0]!.fn();
    w.started[0]!.fn();
    await settle();
    expect(w.logs.map((line) => line.split('\n')[0])).toEqual(['[notch] looking slowly failed: later']);
  });

  test('a log that cannot be written ends nothing: not out of the timer, and not as a rejection nobody hears', async () => {
    const w = world();
    const unheard: unknown[] = [];
    const hear = (reason: unknown): void => { unheard.push(reason); };
    process.on('unhandledRejection', hear);
    try {
      const registry = createNotchRegistry({ surface: {} as never, settings: null, now: () => 0, log: () => { throw new Error('the log is full'); }, paused: () => false });
      registry.every('at once', 100, () => { throw new Error('it broke'); });
      registry.every('later', 200, async () => { await Promise.resolve(); throw new Error('it broke later'); });
      expect(() => { for (const one of w.started) one.fn(); }).not.toThrow();
      await settle();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(unheard).toEqual([]);
    } finally {
      process.off('unhandledRejection', hear);
    }
  });

  test('a run that takes time is started again while it is still under way, unless the clock was told to skip', async () => {
    const w = world();
    const ends: (() => void)[] = [];
    let asUsual = 0;
    let skipping = 0;
    const slow = (count: () => void) => () => { count(); return new Promise<void>((resolve) => { ends.push(resolve); }); };
    w.registry.every('as today', 100, slow(() => { asUsual++; }));
    w.registry.every('skipping', 200, slow(() => { skipping++; }), { skipWhileRunning: true });
    for (let run = 0; run < 3; run++) for (const one of w.started) one.fn();
    expect([asUsual, skipping]).toEqual([3, 1]);
    // The one under way ends: the next is started at its time.
    for (const end of ends.splice(0)) end();
    await settle();
    for (const one of w.started) one.fn();
    expect([asUsual, skipping]).toEqual([4, 2]);
    expect(w.logs).toEqual([]);
  });

  test('a skipping clock goes on after a run that failed, at once or later, and a run that takes no time is never skipped', async () => {
    const w = world();
    let later = 0;
    let atOnce = 0;
    let plain = 0;
    w.registry.every('failing later', 100, async () => { later++; await Promise.resolve(); throw new Error('later'); }, { skipWhileRunning: true });
    w.registry.every('failing at once', 200, () => { atOnce++; throw new Error('at once'); }, { skipWhileRunning: true });
    w.registry.every('plain', 300, () => { plain++; }, { skipWhileRunning: true });
    for (let run = 0; run < 3; run++) { for (const one of w.started) one.fn(); await settle(); }
    expect([later, atOnce, plain]).toEqual([3, 3, 3]);
  });

  test('a clock named in `ticks` skips when it says so', () => {
    const w = world();
    let runs = 0;
    w.registry.add(feature('moves', () => ({ api: api('moves'), ticks: [{ name: 'moving', everyMs: 700, skipWhileRunning: true, run: () => { runs++; return new Promise<void>(() => {}); } }] })));
    w.started[0]!.fn();
    w.started[0]!.fn();
    expect(runs).toBe(1);
  });

  test('what comes back ends that clock and no other', () => {
    const w = world();
    const end = w.registry.every('the first', 100, () => {});
    w.registry.every('the second', 200, () => {});
    end();
    expect(w.started.map((one) => one.cleared)).toEqual([true, false]);
    w.order.length = 0;
    w.registry.stop();
    // The one that was ended is not cleared a second time.
    expect(w.order).toEqual(['clock 200 cleared', 'inbox stopped']);
  });

  test('on a notch that was stopped no clock is started', () => {
    const w = world();
    w.registry.stop();
    w.registry.every('too late', 100, () => {});
    expect(w.started).toEqual([]);
  });
});

describe('making a feature', () => {
  test('it is made from the context, its clocks are started, and what it gives is handed back and found by its id', () => {
    const w = world();
    let seen: unknown = null;
    const made = w.registry.add(feature('moves', (ctx) => {
      seen = { surface: ctx.surface, inbox: ctx.inbox, settings: ctx.settings, now: ctx.now(), paused: ctx.paused() };
      return { api: api('moves'), ticks: [{ name: 'moving', everyMs: 700, run() {} }] };
    }));
    expect(made).toEqual(api('moves'));
    expect(w.registry.use('moves') as unknown).toBe(made);
    expect(seen).toEqual({ surface: { name: 'the surface' }, inbox: w.inbox, settings: null, now: 42, paused: false });
    expect(w.started.map((one) => one.ms)).toEqual([700]);
  });

  test('`paused` is asked each time, not once', () => {
    const w = world();
    let asked: () => boolean = () => false;
    w.registry.add(feature('moves', (ctx) => { asked = ctx.paused; return { api: api('moves') }; }));
    expect(asked()).toBe(false);
    w.state.paused = true;
    expect(asked()).toBe(true);
  });

  test('a clock named in `ticks` that throws is said by its name and throws nothing', () => {
    const w = world();
    w.registry.add(feature('moves', () => ({ api: api('moves'), ticks: [{ name: 'moving', everyMs: 700, run() { throw new Error('stuck'); } }] })));
    expect(() => w.started[0]!.fn()).not.toThrow();
    expect(w.logs[0]!.split('\n')[0]).toBe('[notch] moving failed: stuck');
  });

  test('one that was not given what it is made from is absent, and nothing is said', () => {
    const w = world();
    expect(w.registry.add(feature('memory', () => null))).toBeNull();
    expect(w.registry.use('memory')).toBeNull();
    expect(w.logs).toEqual([]);
    expect(() => w.registry.must(feature('prefs', () => null))).toThrow('[notch] prefs could not be made');
  });

  test('one that needs a part that is not there is not made, and the log says so once', () => {
    const w = world();
    let made = 0;
    const prefs = feature('prefs', () => { made++; return { api: api('prefs') }; }, { needs: ['moves', 'canDo'] });
    expect(w.registry.add(prefs)).toBeNull();
    expect(made).toBe(0);
    expect(w.logs).toEqual(['[notch] prefs was not made: it needs moves, canDo']);
    w.registry.add(feature('moves', () => ({ api: api('moves') })));
    w.registry.add(feature('canDo', () => ({ api: api('canDo') })));
    expect(w.registry.add(prefs)).toEqual(api('prefs'));
    expect(made).toBe(1);
    expect(w.logs).toHaveLength(1);
  });

  test('a part that is lent counts when it is there, and is found when it is made later', () => {
    const w = world();
    let where: unknown = null;
    w.registry.lend('where', () => where as never);
    const pause = feature('pause', (ctx) => ({ api: { asks: () => ctx.use('where') } as never }), { needs: ['where'] });
    const wanting = feature('pause', (ctx) => ({ api: { asks: () => ctx.use('where') } as never }), { wants: ['where'] });
    expect(w.registry.add(pause)).toBeNull();
    expect(w.logs).toEqual(['[notch] pause was not made: it needs where']);
    // Only wanted, it is made, and finds the part when it asks after the part was made.
    const made = w.registry.add(wanting) as unknown as { asks(): unknown };
    expect(made.asks()).toBeNull();
    where = api('where');
    expect(made.asks()).toEqual(api('where'));
  });

  test('the same id is not taken twice, by a feature or by a part that is lent', () => {
    const w = world();
    w.registry.add(feature('moves', () => ({ api: api('moves') })));
    w.registry.lend('where', () => null);
    expect(() => w.registry.add(feature('moves', () => ({ api: api('moves') })))).toThrow('[notch] moves is there already');
    expect(() => w.registry.add(feature('where', () => ({ api: api('where') })))).toThrow('[notch] where is there already');
    expect(() => w.registry.lend('moves', () => null)).toThrow('[notch] moves is there already');
    expect(() => w.registry.lend('where', () => null)).toThrow('[notch] where is there already');
  });

  test('none is made before the inbox, or on a notch that was stopped', () => {
    const early = world({ noInbox: true });
    expect(() => early.registry.add(feature('moves', () => ({ api: api('moves') })))).toThrow('[notch] moves cannot be made before the inbox');
    const late = world();
    late.registry.stop();
    expect(() => late.registry.add(feature('moves', () => ({ api: api('moves') })))).toThrow('[notch] moves cannot be made on a notch that was stopped');
    expect(() => late.registry.setInbox(late.inbox as never)).toThrow('[notch] the inbox is there already');
  });

  test('it is handed only the parts it named in its needs and wants: asking for another throws, by name', () => {
    const w = world();
    w.registry.lend('where', () => api('where'));
    w.registry.lend('mail', () => api('mail'));
    let asks: (id: NotchFeatureId) => unknown = () => null;
    w.registry.add(feature('moves', (ctx) => { asks = (id) => ctx.use(id); return { api: api('moves') }; }, { needs: ['where'], wants: ['mail', 'calls'] }));
    expect(asks('where')).toEqual(api('where'));
    expect(asks('mail')).toEqual(api('mail'));
    // Named and not there: null, as before.
    expect(asks('calls')).toBeNull();
    expect(() => asks('agents')).toThrow('[notch] moves asked for agents, which is not in its needs or wants');
    // Whoever holds the registry may ask for any.
    expect(w.registry.use('agents')).toBeNull();
  });

  test('one that gives something and has no place for it in that order cannot be made, and is stopped with the rest', () => {
    const w = world();
    const given: [string, NotchFeature<never>][] = [
      ['intents', { api: api('moves'), intents: () => [] }],
      ['homeRows', { api: api('moves'), homeRows: () => [] }],
      ['open', { api: api('moves'), open: async () => false }],
      ['settingsRows', { api: api('moves'), settingsRows: () => [] }],
      ['setWord', { api: api('moves'), setWord: () => false }],
      ['done', { api: api('moves'), done: () => [] }],
      ['undo', { api: api('moves'), undo: () => null }],
      ['hello', { api: api('moves'), hello: () => {} }],
    ];
    const kinds: Record<string, string> = { intents: 'says', homeRows: 'homeRows', open: 'homeRows', settingsRows: 'settingsRows', setWord: 'settingsRows', done: 'done', undo: 'undo', hello: 'hello' };
    for (const [member, made] of given) {
      const one = world();
      expect(() => one.registry.add(feature('moves', () => ({ ...made, stop() { one.order.push('moves stopped'); } }))))
        .toThrow(`[notch] moves gives ${member}, and has no place in the order of ${kinds[member]}`);
      one.registry.stop();
      expect(one.order).toEqual(['inbox stopped', 'moves stopped']);
    }
    // A part that is lent is refused the same way.
    expect(() => w.registry.lend('where', () => null, { homeRows: () => [] })).toThrow('[notch] where gives homeRows, and has no place in the order of homeRows');
  });
});

describe('what is gathered from every part', () => {
  const row = (id: string): NotchBlock => ({ kind: 'row', id, say: [id] });
  const done = (id: string): NotchDone => ({ id, at: 1, text: id, small: '', undo: true });
  const intent = (id: string, band: NotchIntent['band']): NotchIntent => ({ id, feature: id, says: id, band, act: 'none', first: 'acts', examples: [], match: () => null });
  /** A registry whose orders differ from the order the parts are made in. */
  const gathering = () => {
    const w = world({
      order: {
        says: ['canDo', 'moves', 'where'], homeRows: ['moves', 'where', 'canDo'], settingsRows: ['canDo', 'moves'],
        done: ['canDo', 'moves'], undo: ['canDo', 'moves'], hello: ['moves', 'where'],
      },
    });
    const opened: string[] = [];
    const heard: string[] = [];
    let where: unknown = null;
    w.registry.add(feature('moves', () => ({
      api: api('moves'),
      intents: () => [intent('moves.open', 'open'), intent('moves.first', 'control')],
      homeRows: () => [row('moves')],
      open: async (_stage, id) => { opened.push(`moves asked: ${id}`); return id === 'moves'; },
      settingsRows: () => [row('moves-setting')],
      setWord: (name) => name === 'speed',
      done: () => [done('moved')],
      undo: (id) => (id === 'moved' || id === 'both' ? ['Moves took it back.'] : null),
      hello: (sidecarId) => heard.push(`moves: ${sidecarId}`),
    })));
    w.registry.add(feature('canDo', () => ({
      api: api('canDo'),
      intents: () => [intent('cando.open', 'open')],
      homeRows: () => [row('cando')],
      open: async (_stage, id) => { opened.push(`canDo asked: ${id}`); return id === 'cando'; },
      settingsRows: () => [row('cando-setting')],
      setWord: (name) => name === 'all',
      done: () => [done('could')],
      undo: (id) => (id === 'could' || id === 'both' ? ['canDo took it back.'] : null),
    })));
    // A part that is not a feature yet gives the same, while it is there.
    w.registry.lend('where', () => where as never, {
      intents: () => [intent('where.open', 'open')],
      homeRows: () => [row('see')],
      open: async (_stage, id) => { opened.push(`where asked: ${id}`); return id === 'see'; },
      hello: (sidecarId) => heard.push(`where: ${sidecarId}`),
    });
    return { ...w, opened, heard, arrive: () => { where = api('where'); } };
  };

  test('each kind stands in its own order, not in the order the parts were made, and a part that is lent gives only while it is there', async () => {
    const w = gathering();
    // The table orders by band first; inside a band, by the order of `says`.
    expect(w.registry.all.intents().map((one) => one.id)).toEqual(['moves.first', 'cando.open', 'moves.open']);
    expect(w.registry.all.homeRows().map((one) => (one as { id: string }).id)).toEqual(['moves', 'cando']);
    expect(w.registry.all.settingsRows().map((one) => (one as { id: string }).id)).toEqual(['cando-setting', 'moves-setting']);
    expect(w.registry.all.done(0).map((one) => one.id)).toEqual(['could', 'moved']);
    w.registry.hello('pc');
    expect(w.heard).toEqual(['moves: pc']);
    w.arrive();
    expect(w.registry.all.intents().map((one) => one.id)).toEqual(['moves.first', 'cando.open', 'moves.open', 'where.open']);
    expect(w.registry.all.homeRows().map((one) => (one as { id: string }).id)).toEqual(['moves', 'see', 'cando']);
    w.registry.hello('laptop');
    expect(w.heard).toEqual(['moves: pc', 'moves: laptop', 'where: laptop']);
    // The ctx of a feature has the same view.
    let seen: string[] = [];
    w.registry.add(feature('prefs', (ctx) => { seen = ctx.all.homeRows().map((one) => (one as { id: string }).id); return { api: api('prefs') }; }));
    expect(seen).toEqual(['moves', 'see', 'cando']);
  });

  test('a row is opened by the first part in its order that owns it; a word, and an undo, by the first that takes it', async () => {
    const w = gathering();
    w.arrive();
    await w.registry.all.open({} as never, 'cando');
    expect(w.opened).toEqual(['moves asked: cando', 'where asked: cando', 'canDo asked: cando']);
    w.opened.length = 0;
    await w.registry.all.open({} as never, 'nobody');
    expect(w.opened).toEqual(['moves asked: nobody', 'where asked: nobody', 'canDo asked: nobody']);
    expect([w.registry.all.setWord('speed', 'x'), w.registry.all.setWord('all', 'x'), w.registry.all.setWord('none', 'x')]).toEqual([true, true, false]);
    expect(w.registry.all.undo('both')).toEqual(['canDo took it back.']);
    expect(w.registry.all.undo('moved')).toEqual(['Moves took it back.']);
    expect(w.registry.all.undo('nothing')).toBeNull();
  });

  test('on a notch that was stopped a page that comes up is told to nobody', () => {
    const w = gathering();
    w.arrive();
    w.registry.stop();
    w.registry.hello('pc');
    expect(w.heard).toEqual([]);
  });
});

describe('the way down', () => {
  test('the clocks first, then what is on the notch, then the features from the last made to the first, then the other parts as they were given', () => {
    const w = world();
    w.registry.onStop(() => w.order.push('part one stopped'));
    w.registry.every('by hand', 50, () => {});
    w.registry.add(feature('moves', () => ({ api: api('moves'), ticks: [{ name: 'moving', everyMs: 100, run() {} }], stop() { w.order.push('moves stopped'); } })));
    w.registry.add(feature('canDo', () => ({ api: api('canDo') })));
    w.registry.add(feature('prefs', (ctx) => { ctx.every('preferring', 200, () => {}); return { api: api('prefs'), stop() { w.order.push('prefs stopped'); } }; }));
    w.registry.onStop(() => w.order.push('part two stopped'));
    expect(w.registry.stopped()).toBe(false);
    w.registry.stop();
    expect(w.registry.stopped()).toBe(true);
    expect(w.order).toEqual([
      'clock 50 cleared', 'clock 100 cleared', 'clock 200 cleared',
      'inbox stopped',
      'prefs stopped', 'moves stopped',
      'part one stopped', 'part two stopped',
    ]);
    expect(w.started.filter((one) => !one.cleared)).toEqual([]);
  });

  test('one that fails to stop is said, whatever the error is, and the others are stopped all the same', () => {
    const w = world();
    w.inbox.stop = () => { throw new Error('the inbox is stuck'); };
    w.registry.add(feature('moves', () => ({ api: api('moves'), stop() { w.order.push('moves stopped'); } })));
    w.registry.add(feature('canDo', () => ({ api: api('canDo'), stop() { throw new ReferenceError('gone is not defined'); } })));
    w.registry.onStop(() => { throw 'a part is stuck'; });
    w.registry.onStop(() => w.order.push('the last part stopped'));
    expect(() => w.registry.stop()).not.toThrow();
    expect(w.order).toEqual(['moves stopped', 'the last part stopped']);
    expect(w.logs).toEqual([
      '[notch] a part of the notch did not stop: the inbox is stuck',
      '[notch] a part of the notch did not stop: gone is not defined',
      '[notch] a part of the notch did not stop: a part is stuck',
    ]);
  });

  test('when a feature cannot be made, what was made before it is what is stopped, and its own clock with it', () => {
    const w = world();
    w.registry.add(feature('moves', () => ({ api: api('moves'), ticks: [{ name: 'moving', everyMs: 100, run() {} }], stop() { w.order.push('moves stopped'); } })));
    expect(() => w.registry.add(feature('canDo', (ctx) => { ctx.every('half made', 300, () => {}); throw new Error('no such table'); }))).toThrow('no such table');
    expect(w.registry.use('canDo')).toBeNull();
    w.registry.stop();
    expect(w.order).toEqual(['clock 100 cleared', 'clock 300 cleared', 'inbox stopped', 'moves stopped']);
    // A part that was never made is not a part that failed to stop.
    expect(w.logs).toEqual([]);
  });

  test('before the inbox is made there is only the clocks and the parts to stop', () => {
    const w = world({ noInbox: true });
    w.registry.every('by hand', 50, () => {});
    w.registry.onStop(() => w.order.push('a part stopped'));
    w.registry.stop();
    expect(w.order).toEqual(['clock 50 cleared', 'a part stopped']);
    expect(w.logs).toEqual([]);
  });
});

describe('the quiet links at the foot of Home', () => {
  const linked = () => {
    const w = world();
    const pressed: string[] = [];
    w.registry.add(feature('memory', () => ({
      api: api('memory'),
      homeLinks: () => [{ id: 'memory', label: 'Memory', quiet: true }],
      press: async (_stage, link) => { pressed.push(`memory asked: ${link}`); return link === 'memory' ? 'stay' : null; },
    })));
    w.registry.add(feature('moves', () => ({ api: api('moves') })));
    let connected = true;
    w.registry.add(feature('prefs', () => ({
      api: api('prefs'),
      homeLinks: () => [...(connected ? [{ id: 'connections', label: 'Connections', quiet: true }] : []), { id: 'settings', label: 'Settings', quiet: true }],
      press: async (_stage, link) => { pressed.push(`prefs asked: ${link}`); return link === 'settings' ? 'leave' : link === 'connections' ? 'stay' : null; },
    })));
    return { ...w, pressed, disconnect: () => { connected = false; } };
  };

  test('they stand in the order their features were made, as they are when Home asks', () => {
    const w = linked();
    expect(w.registry.homeLinks().map((link) => link.id)).toEqual(['memory', 'connections', 'settings']);
    w.disconnect();
    expect(w.registry.homeLinks()).toEqual([{ id: 'memory', label: 'Memory', quiet: true }, { id: 'settings', label: 'Settings', quiet: true }]);
  });

  test('a press is answered by the feature that owns the link, and by none when it is nobody\'s', async () => {
    const w = linked();
    expect(await w.registry.press({} as never, 'memory')).toBe('stay');
    expect(w.pressed).toEqual(['memory asked: memory']);
    expect(await w.registry.press({} as never, 'settings')).toBe('leave');
    expect(await w.registry.press({} as never, 'dashboard')).toBeNull();
    expect(w.pressed.slice(1)).toEqual(['memory asked: settings', 'prefs asked: settings', 'memory asked: dashboard', 'prefs asked: dashboard']);
  });

  test('with no feature that has one there is none', async () => {
    const w = world();
    w.registry.add(feature('moves', () => ({ api: api('moves') })));
    expect(w.registry.homeLinks()).toEqual([]);
    expect(await w.registry.press({} as never, 'memory')).toBeNull();
  });
});
