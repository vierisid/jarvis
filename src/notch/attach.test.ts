import { describe, expect, test } from 'bun:test';
import { NOTCH_BACK_MOST, NOTCH_BACK_WITHIN_MS, NOTCH_CAPABILITY, NOTCH_REOPEN_AFTER_MS, NOTCH_REOPEN_APART_MS, NOTCH_SPAWN_AGAIN_MS, attachNotch, createNotchReopen, type NotchSidecar, type NotchSidecarPort } from './attach.ts';

/** A sidecar manager that records what it is asked to do. */
function fakePort(answer: () => Promise<unknown> = async () => ({ configured: true, enabled: true, surface: 'none' })) {
  const listeners: Array<(sidecar: NotchSidecar) => void> = [];
  const calls: Array<{ sidecarId: string; method: string; params?: Record<string, unknown> }> = [];
  const port: NotchSidecarPort = {
    onSidecarConnected(listener) { listeners.push(listener); },
    dispatchRPC(sidecarId, method, params) { calls.push({ sidecarId, method, params }); return answer(); },
  };
  return {
    port, calls, listeners,
    connect(sidecar: NotchSidecar) { for (const listener of listeners) listener(sidecar); },
  };
}

const capable: NotchSidecar = { id: 's1', name: 'desk', capabilities: ['pebble', NOTCH_CAPABILITY] };
const older: NotchSidecar = { id: 's2', name: 'old-desk', capabilities: ['pebble', 'windows'] };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('attachNotch', () => {
  // The invariant in docs/notch/README.md: off means the brain never mentions
  // the notch. This fails if the early return is removed, because the capable
  // sidecar below would then be sent notch.configure.
  test('with the switch off, registers nothing and sends nothing', async () => {
    const fake = fakePort();
    const lines: string[] = [];
    attachNotch(fake.port, { enabled: false, log: (line) => lines.push(line) });
    expect(fake.listeners).toHaveLength(0);
    fake.connect(capable);
    await settle();
    expect(fake.calls).toEqual([]);
    expect(lines).toEqual([]);
  });

  test('with the switch on, tells a capable desktop app to host it, once per connect', async () => {
    const fake = fakePort();
    const lines: string[] = [];
    attachNotch(fake.port, { enabled: true, log: (line) => lines.push(line) });
    fake.connect(capable);
    await settle();
    expect(fake.calls).toEqual([{ sidecarId: 's1', method: 'notch.configure', params: { enabled: true } }]);
    expect(lines).toEqual(['[notch] switch on', '[notch] "desk" ready, surface: none']);
  });

  test('opens the window on a desktop app that says it has one, on the given page', async () => {
    const fake = fakePort(async () => ({ configured: true, enabled: true, surface: 'window' }));
    const lines: string[] = [];
    attachNotch(fake.port, { enabled: true, pageUrl: 'http://localhost:3143/notch.html', log: (line) => lines.push(line) });
    fake.connect(capable);
    await settle();
    expect(fake.calls).toEqual([
      { sidecarId: 's1', method: 'notch.configure', params: { enabled: true } },
      { sidecarId: 's1', method: 'notch.spawn', params: { url: 'http://localhost:3143/notch.html' } },
    ]);
    expect(lines.at(-1)).toBe('[notch] "desk" is showing the notch');
  });

  /** A desktop app whose window cannot be made the first `fails` times it is asked for. */
  function stubborn(fails: number) {
    const calls: string[] = [];
    const listeners: Array<(sidecar: NotchSidecar) => void> = [];
    let asked = 0;
    const port: NotchSidecarPort = {
      onSidecarConnected(listener) { listeners.push(listener); },
      async dispatchRPC(_sidecarId, method) {
        calls.push(method);
        if (method !== 'notch.spawn') return { configured: true, enabled: true, surface: 'window' };
        if (++asked <= fails) throw new Error('HANDLER_ERROR: panel.spawn[notch]: could not create the window');
        return { spawned: true, already: false };
      },
    };
    const waits: number[] = [];
    const held: Array<() => void> = [];
    const wait = (ms: number): Promise<void> => { waits.push(ms); return new Promise<void>((done) => { held.push(done); }); };
    /** The wait that is on is over. */
    const pass = async (): Promise<void> => { held.shift()?.(); await settle(); };
    return { port, calls, waits, wait, pass, connect(sidecar: NotchSidecar) { for (const listener of listeners) listener(sidecar); } };
  }

  // The first start of a new profile: the window could not be made, once.
  // Without the second try that computer had no notch until its desktop app
  // was started again.
  test('a window that could not be made is asked for again, and the notch is there at the second try', async () => {
    const fake = stubborn(1);
    const lines: string[] = [];
    attachNotch(fake.port, { enabled: true, pageUrl: 'http://localhost:3143/notch.html', log: (line) => lines.push(line), wait: fake.wait });
    fake.connect(capable);
    await settle();
    expect(fake.calls).toEqual(['notch.configure', 'notch.spawn']);
    expect(fake.waits).toEqual([NOTCH_SPAWN_AGAIN_MS[0]!]);
    expect(lines.at(-1)).toBe('[notch] "desk" could not show the notch: HANDLER_ERROR: panel.spawn[notch]: could not create the window. Trying again in 2 s');
    await fake.pass();
    expect(fake.calls).toEqual(['notch.configure', 'notch.spawn', 'notch.spawn']);
    expect(lines.at(-1)).toBe('[notch] "desk" is showing the notch, at try 2');
  });

  test('three tries in all, then it is left and says so', async () => {
    const fake = stubborn(99);
    const lines: string[] = [];
    attachNotch(fake.port, { enabled: true, pageUrl: 'http://localhost:3143/notch.html', log: (line) => lines.push(line), wait: fake.wait });
    fake.connect(capable);
    await settle();
    await fake.pass();
    await fake.pass();
    await fake.pass();
    expect(fake.calls.filter((method) => method === 'notch.spawn').length).toBe(NOTCH_SPAWN_AGAIN_MS.length + 1);
    expect(fake.waits).toEqual([...NOTCH_SPAWN_AGAIN_MS]);
    expect(lines.at(-1)).toBe('[notch] "desk" could not show the notch: HANDLER_ERROR: panel.spawn[notch]: could not create the window');
  });

  test('a desktop app that connected again while a try waited is asked by its new connection only', async () => {
    const fake = stubborn(1);
    attachNotch(fake.port, { enabled: true, pageUrl: 'http://localhost:3143/notch.html', log: () => {}, wait: fake.wait });
    fake.connect(capable);
    await settle();
    // It connects again before the second try: that connection asks, and gets its window.
    fake.connect(capable);
    await settle();
    expect(fake.calls.filter((method) => method === 'notch.spawn').length).toBe(2);
    // The old connection's wait ends: it asks for nothing more.
    await fake.pass();
    expect(fake.calls.filter((method) => method === 'notch.spawn').length).toBe(2);
  });

  // A desktop app that only understands the switch must not be asked for a
  // window it cannot open: notch.spawn would come back METHOD_NOT_FOUND.
  test('does not ask for a window when the desktop app has no surface', async () => {
    const fake = fakePort(async () => ({ configured: true, enabled: true, surface: 'none' }));
    attachNotch(fake.port, { enabled: true, pageUrl: 'http://localhost:3143/notch.html', log: () => {} });
    fake.connect(capable);
    await settle();
    expect(fake.calls.map((call) => call.method)).toEqual(['notch.configure']);
  });

  test('never sends notch.* to a desktop app that does not advertise the capability', async () => {
    const fake = fakePort();
    const lines: string[] = [];
    attachNotch(fake.port, { enabled: true, log: (line) => lines.push(line) });
    fake.connect(older);
    await settle();
    expect(fake.calls).toEqual([]);
    expect(lines[1]).toContain('"old-desk" cannot host the notch');
  });

  test('a refused notch.configure is reported, not thrown', async () => {
    const fake = fakePort(async () => { throw new Error('METHOD_NOT_FOUND'); });
    const lines: string[] = [];
    attachNotch(fake.port, { enabled: true, log: (line) => lines.push(line) });
    fake.connect(capable);
    await settle();
    expect(lines[1]).toBe('[notch] "desk" did not accept notch.configure: METHOD_NOT_FOUND');
  });
  // The desktop app says whether it can hear the notch's keys. A machine that
  // cannot yet must be visible in the log, not found out by pressing keys.
  test('says whether the desktop app can hear the keys', async () => {
    for (const [keys, expected] of [['watch', 'keys: watch'], ['blocked', 'cannot hear the notch\'s keys'], ['pairs', 'hears the two pairs of keys without the Accessibility permission'], [undefined, 'surface: window']] as const) {
      const lines: string[] = [];
      const listeners: ((sidecar: { id: string; name: string; capabilities: string[] }) => void)[] = [];
      attachNotch({
        onSidecarConnected: (listener) => { listeners.push(listener); },
        dispatchRPC: async (_id, method) => (method === 'notch.configure' ? { configured: true, enabled: true, surface: 'window', keys } : { spawned: true }),
      }, { enabled: true, pageUrl: 'http://localhost:3143/notch.html', log: (line) => lines.push(line) });
      listeners[0]!({ id: 's1', name: 'pc', capabilities: ['notch'] });
      await new Promise((r) => setTimeout(r, 5));
      expect(lines.join('\n')).toContain(expected);
      if (keys === undefined) expect(lines.join('\n')).not.toContain('keys:');
    }
  });
});

// The hardening audit, 17 November 2026: the page's sign-in ends (twelve hours at most, four when it asked
// nothing), and from then every dropped file was refused: "Try dropping it again", for ever.
describe('a page whose sign-in has ended is opened again', () => {
  function reopener(spawn: Array<Record<string, unknown> | Error>) {
    const calls: string[] = [];
    const waits: number[] = [];
    let now = 1_000_000;
    let n = 0;
    const reopen = createNotchReopen({
      async dispatchRPC(_sidecarId, method) {
        calls.push(method);
        if (method !== 'notch.spawn') return { closed: true };
        const got = spawn[Math.min(n++, spawn.length - 1)]!;
        if (got instanceof Error) throw got;
        return got;
      },
    }, { pageUrl: 'http://localhost:3143/notch.html', log: () => {}, wait: async (ms) => { waits.push(ms); }, now: () => now });
    return { reopen, calls, waits, pass: (ms: number) => { now += ms; } };
  }

  test('closed, given a moment to be gone, and asked for anew', async () => {
    const h = reopener([{ spawned: true, already: false }]);
    expect(await h.reopen('s1')).toBe(true);
    expect(h.calls).toEqual(['notch.close', 'notch.spawn']);
    expect(h.waits).toEqual([NOTCH_REOPEN_AFTER_MS]);
  });

  test('"already there" is the window on its way out: it is asked for again', async () => {
    const h = reopener([{ spawned: true, already: true }, { spawned: true, already: false }]);
    expect(await h.reopen('s1')).toBe(true);
    expect(h.calls).toEqual(['notch.close', 'notch.spawn', 'notch.spawn']);
  });

  test('not more than once a minute for one desktop app, whatever the page says', async () => {
    const h = reopener([{ spawned: true, already: false }]);
    await h.reopen('s1');
    expect(await h.reopen('s1')).toBe(false);
    expect(h.calls).toEqual(['notch.close', 'notch.spawn']);
    // Another desktop app is its own.
    expect(await h.reopen('s2')).toBe(true);
    h.pass(NOTCH_REOPEN_APART_MS + 1);
    expect(await h.reopen('s1')).toBe(true);
  });

  // The hardening audit, 17 November 2026: Alt+F4 while the notch had the
  // keyboard closed its window, and it never came back until a reconnect.
  test('a notch whose window went away by itself is opened again, without a close', async () => {
    const h = reopener([{ spawned: true, already: false }]);
    expect(await h.reopen.closed('s1')).toBe(true);
    expect(h.calls).toEqual(['notch.spawn']);
    expect(h.waits).toEqual([NOTCH_REOPEN_AFTER_MS]);
  });

  test('the close a re-opening asked for is not answered with a second window', async () => {
    const calls: string[] = [];
    let heard: Promise<boolean> | null = null;
    const reopen = createNotchReopen({
      async dispatchRPC(_sidecarId, method) {
        calls.push(method);
        // The desktop app says "closed" while the re-opening is still going.
        if (method === 'notch.close') heard = reopen.closed('s1');
        return method === 'notch.spawn' ? { spawned: true, already: false } : { closed: true };
      },
    }, { pageUrl: 'http://localhost:3143/notch.html', log: () => {}, wait: async () => {} });
    expect(await reopen('s1')).toBe(true);
    expect(await heard!).toBe(false);
    expect(calls).toEqual(['notch.close', 'notch.spawn']);
  });

  test('a window that will not stay is left closed after a few times', async () => {
    const h = reopener([{ spawned: true, already: false }]);
    for (let i = 0; i < NOTCH_BACK_MOST; i++) expect(await h.reopen.closed('s1')).toBe(true);
    expect(await h.reopen.closed('s1')).toBe(false);
    expect(h.calls).toHaveLength(NOTCH_BACK_MOST);
    // Later it is put back again.
    h.pass(NOTCH_BACK_WITHIN_MS + 1);
    expect(await h.reopen.closed('s1')).toBe(true);
  });

  test('a desktop app that cannot be reached is not asked three times', async () => {
    const h = reopener([new Error('Sidecar not connected')]);
    expect(await h.reopen.closed('s1')).toBe(false);
    expect(h.calls).toEqual(['notch.spawn']);
  });
});
