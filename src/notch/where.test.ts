import { describe, expect, test } from 'bun:test';
import { captureMayBeKept, setCaptureGuard } from '../awareness/capture-guard.ts';
import { NotchInbox } from './inbox.ts';
import type { NotchLine, NotchToPage } from './protocol.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface, type NotchSurfacePort } from './surface.ts';
import { NOTCH_NEVER_WATCH_RPC, NOTCH_WHERE_EVENT, attachNotchWhere, notchAppKey, parseNotchWhere } from './where.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
// A 1 by 1 PNG, as base64.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function harness(options: { watching?: boolean } = {}) {
  const pushed: NotchToPage[] = [];
  const rpcs: { id: string; method: string; params: Record<string, unknown> }[] = [];
  let pageEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  let whereEvent: (sidecarId: string, event: { event_type: string; payload: unknown; binary?: unknown }) => void = () => {};
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
  const logs: string[] = [];
  const surface = new NotchSurface(port, (line) => logs.push(line));
  let where: ReturnType<typeof attachNotchWhere>;
  const inbox = new NotchInbox(surface, { clock, log: (line) => logs.push(line), home: (stage) => where.see(stage) });
  const fromPage = (message: unknown): void => pageEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 1 });
  let asleep = false;
  let never: string[] = [];
  let watching = options.watching ?? true;
  where = attachNotchWhere(surface, inbox, {
    onEvent(listener) { whereEvent = listener; },
    onSidecarDisconnected(listener) { gone = listener; },
    async dispatchRPC(id, method, params) {
      rpcs.push({ id, method, params });
      if (method !== NOTCH_NEVER_WATCH_RPC) throw new Error('unknown');
      never = params.watch ? never.filter((app) => app !== params.app) : [...never, String(params.app)];
      return { never };
    },
  }, { asleep: () => asleep, sleep: () => { asleep = true; }, watching: () => watching, log: (line) => logs.push(line) });
  const line = (): NotchLine | null => surface.current().line;
  const text = (l: NotchLine | null): string => (l?.say ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('');
  const rowText = (block: unknown): string => {
    const b = block as { say?: unknown[]; lead?: string };
    return `${b.lead ? `${b.lead}: ` : ''}${(b.say ?? []).map((part) => (typeof part === 'string' ? part : (part as { em?: string }).em ?? '')).join('')}`;
  };
  return {
    where, surface, pushed, rpcs, logs, line, rowText,
    said: () => text(line()),
    last: <T extends NotchToPage['type']>(type: T) => [...pushed].reverse().find((m) => m.type === type) as Extract<NotchToPage, { type: T }> | undefined,
    tell(payload: Record<string, unknown>, icon = false, id = 'pc') {
      whereEvent(id, { event_type: NOTCH_WHERE_EVENT, payload, ...(icon ? { binary: { type: 'inline', mime_type: 'image/png', data: PNG } } : {}) });
    },
    gone: (id = 'pc') => gone(id),
    sleep(on: boolean) { asleep = on; },
    setWatching(on: boolean) { watching = on; },
    async open() { fromPage({ type: 'open' }); await settle(); },
    async answer(act: string, more: Record<string, unknown> = {}) { fromPage({ type: 'answer', id: line()!.id, act, ...more }); await settle(); },
    async advance(ms: number) {
      now += ms;
      for (const timer of [...timers].filter((t) => t.at <= now)) { const at = timers.indexOf(timer); if (at >= 0) { timers.splice(at, 1); timer.fn(); } }
      await settle();
    },
    blocks: () => { const l = line(); return l?.kind === 'sheet' ? l.blocks : []; },
  };
}

const notepad = { app: 'notepad', name: 'Notepad', title: 'Untitled - Notepad', look: '', still: false, never: [], icon: 'k1' };

describe('what a desktop app says about where you are', () => {
  test('is read carefully: a name of one line, a list of plain names, and no title while it looks away', () => {
    expect(parseNotchWhere({ app: 'Notepad.exe', name: ' Note\npad ', title: 'a\tb', look: '', still: true, never: ['Steam.EXE', 'steam', 7, ''], icon: 'k' }))
      .toEqual({ app: 'notepad', name: 'Note pad', title: 'a b', look: '', still: true, never: ['steam'], iconKey: 'k' });
    expect(parseNotchWhere({ app: 'chrome', title: 'My Bank - Chrome', look: 'bank' })?.title).toBe('');
    expect(parseNotchWhere({ app: 'chrome', look: 'sideways' })?.look).toBe('');
    expect(parseNotchWhere({ app: 'chrome' })?.name).toBe('chrome');
    expect(parseNotchWhere('notepad')).toBeNull();
    expect(notchAppKey('Steam.exe')).toBe('steam');
  });
});

describe('the resting notch shows where you are, and whether it is looking', () => {
  test('the front app and its icon, the moment the desktop app says so', () => {
    const h = harness();
    h.tell(notepad, true);
    expect(h.last('where')?.app).toEqual({ name: 'Notepad', icon: `data:image/png;base64,${PNG}` });
    // The icon is sent once: the next time the key alone is enough.
    h.tell({ ...notepad, app: 'steam', name: 'Steam', title: 'Steam', icon: 'k2' });
    expect(h.last('where')?.app).toEqual({ name: 'Steam' });
    h.tell(notepad);
    expect(h.last('where')?.app).toEqual({ name: 'Notepad', icon: `data:image/png;base64,${PNG}` });
  });

  test('a password or a bank: eyes aside, no app shown, and it says why the first time only', async () => {
    const h = harness();
    h.tell(notepad, true);
    h.tell({ ...notepad, app: 'chrome', name: 'Google Chrome', title: '', look: 'password' });
    await settle();
    expect(h.last('face')?.mood).toBe('away');
    expect(h.last('where')?.app).toBeNull();
    expect(h.said()).toBe('A password. I am not looking.');
    await h.answer('done');
    h.tell(notepad);
    expect(h.last('face')?.mood).toBe('idle');
    expect(h.last('where')?.app?.name).toBe('Notepad');
    h.tell({ ...notepad, look: 'password' });
    await settle();
    // The second time the eyes say it.
    expect(h.line()).toBeNull();
    expect(h.last('face')?.mood).toBe('away');
    h.tell({ ...notepad, app: 'chrome', name: 'Google Chrome', look: 'bank' });
    await settle();
    expect(h.said()).toBe('Your bank. I look away in here.');
    // What is logged is that it looked away, never what was in front.
    expect(h.logs.join('\n')).not.toContain('Notepad');
    expect(h.logs.join('\n')).not.toContain('Chrome');
  });

  test('an app on the never-watch list, or watching switched off: eyes closed, no app shown', () => {
    const h = harness();
    h.tell({ ...notepad, app: 'steam', name: 'Steam', look: 'never', never: ['steam'] });
    expect(h.last('face')?.mood).toBe('closed');
    // No app was ever shown, so there is nothing to take away.
    expect(h.last('where')).toBeUndefined();
    h.tell(notepad);
    expect(h.last('face')?.mood).toBe('idle');
    h.setWatching(false);
    h.where.refresh();
    expect(h.last('face')?.mood).toBe('closed');
    expect(h.last('where')?.app).toBeNull();
  });

  test('asleep: no app is shown, and the closed eyes are left to the pause', () => {
    const h = harness();
    h.tell(notepad, true);
    const faces = h.pushed.filter((m) => m.type === 'face').length;
    h.sleep(true);
    h.where.refresh();
    expect(h.last('where')?.app).toBeNull();
    expect(h.pushed.filter((m) => m.type === 'face').length).toBe(faces);
    h.sleep(false);
    h.where.refresh();
    expect(h.last('where')?.app?.name).toBe('Notepad');
  });

  test('a desktop app that goes away takes what it said with it', () => {
    const h = harness();
    h.tell(notepad, true);
    h.gone();
    expect(h.last('where')?.app).toBeNull();
    expect(h.where.mayKeep('pc', 'notepad')).toBe(true);
  });
});

describe('"What I see", in plain words', () => {
  test('names the app and its window, and offers to never watch it', async () => {
    const h = harness();
    h.tell(notepad, true);
    expect(h.rowText(h.where.row())).toBe('I see Notepad.');
    await h.open();
    expect(h.said()).toBe('What I see');
    const [first, buttons, note] = h.blocks();
    expect(h.rowText(first)).toBe('Notepad: Untitled - Notepad. I look at this screen about every 15 seconds, when it has changed, and read the text on it.');
    expect(buttons).toMatchObject({ kind: 'buttons', buttons: [{ id: 'sleep', label: 'Sleep' }, { id: 'never', label: 'Never watch Notepad' }] });
    expect(h.rowText(note)).toBe('Eyes open means I am watching. Eyes closed means I see nothing.');
  });

  test('"Never watch" asks that computer to change its list, and the sheet shows what it answered', async () => {
    const h = harness();
    h.tell(notepad, true);
    await h.open();
    await h.answer('button', { button: 'never' });
    expect(h.rpcs).toEqual([{ id: 'pc', method: NOTCH_NEVER_WATCH_RPC, params: { app: 'notepad', watch: false } }]);
    expect(h.rowText(h.blocks()[0])).toBe('Not watching: You told me never to watch Notepad.');
    expect(h.rowText(h.blocks()[1])).toBe('Never watching: notepad.');
    expect(h.blocks()[2]).toMatchObject({ buttons: [{ id: 'sleep' }, { id: 'never', label: 'Watch Notepad again' }] });
    expect(h.last('face')?.mood).toBe('closed');
    await h.answer('button', { button: 'never' });
    expect(h.rpcs[1]!.params).toEqual({ app: 'notepad', watch: true });
    expect(h.blocks()[1]).toMatchObject({ kind: 'buttons' });
    expect(h.last('face')?.mood).toBe('idle');
  });

  test('it says when it is looking away, and why', async () => {
    const h = harness();
    h.tell({ ...notepad, app: 'chrome', name: 'Google Chrome', look: 'bank' });
    await settle();
    await h.answer('done');
    expect(h.rowText(h.where.row())).toBe('I am looking away.');
    await h.open();
    expect(h.rowText(h.blocks()[0])).toBe('Looking away: This looks like your bank. Banks and passwords are never read. I look away by myself.');
  });

  test('Sleep on the sheet is the product\'s own pause', async () => {
    const h = harness();
    h.tell(notepad, true);
    await h.open();
    let slept = false;
    const before = h.where;
    expect(before).toBeDefined();
    await h.answer('button', { button: 'sleep' });
    slept = h.where.mayKeep('pc', 'notepad') === false;
    expect(slept).toBe(true);
  });
});

describe('the second door for what a desktop app captured', () => {
  test('nothing is kept while that machine looks away, for an app on its list, or asleep', () => {
    const h = harness();
    h.tell({ ...notepad, never: ['steam'] });
    expect(h.where.mayKeep('pc', 'notepad')).toBe(true);
    expect(h.where.mayKeep('pc', 'Steam.exe')).toBe(false);
    expect(h.where.mayKeep('another', 'steam')).toBe(true);
    h.tell({ ...notepad, look: 'password' });
    expect(h.where.mayKeep('pc', 'notepad')).toBe(false);
    h.tell(notepad);
    h.sleep(true);
    expect(h.where.mayKeep('pc', 'notepad')).toBe(false);
  });

  test('the brain asks it before keeping a capture, a window change or an idle report, and nothing else', () => {
    try {
      const asked: string[] = [];
      setCaptureGuard((id, app) => { asked.push(`${id} ${app}`); return app !== 'steam'; });
      expect(captureMayBeKept('pc', { event_type: 'screen_capture', payload: { app_name: 'steam' } })).toBe(false);
      expect(captureMayBeKept('pc', { event_type: 'screen_capture', payload: { app_name: 'notepad' } })).toBe(true);
      expect(captureMayBeKept('pc', { event_type: 'context_changed', payload: { from_app: 'notepad', to_app: 'steam' } })).toBe(false);
      expect(captureMayBeKept('pc', { event_type: 'idle_detected', payload: { app_name: 'steam' } })).toBe(false);
      expect(captureMayBeKept('pc', { event_type: 'clipboard_change', payload: { text: 'x' } })).toBe(true);
      expect(asked).toEqual(['pc steam', 'pc notepad', 'pc steam', 'pc steam']);
      // A guard that cannot answer does not open the door.
      setCaptureGuard(() => { throw new Error('broken'); });
      expect(captureMayBeKept('pc', { event_type: 'screen_capture', payload: {} })).toBe(false);
    } finally {
      setCaptureGuard(null);
    }
    // With nothing set (the notch is off) everything is kept, as before.
    expect(captureMayBeKept('pc', { event_type: 'screen_capture', payload: { app_name: 'steam' } })).toBe(true);
  });
});
