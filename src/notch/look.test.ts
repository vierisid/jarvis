import { describe, expect, test } from 'bun:test';
import { NotchInbox } from './inbox.ts';
import {
  NOTCH_LOOK_EVENT, NOTCH_LOOK_FILE, NOTCH_LOOK_PICTURE, NOTCH_LOOK_QUESTION, NOTCH_LOOK_WINDOW, attachNotchLook, lookAddsUp, lookAmount, lookCount,
  lookFiles, lookNumber, lookOne, lookRefusal, lookSeveral, lookSums, lookText, parseNotchLookBody,
} from './look.ts';
import type { NotchLookDeps, NotchLooked, NotchThing } from './look.ts';
import type { NotchLine, NotchPart, NotchToPage } from './protocol.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';
import type { NotchAskFile } from './asks.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | undefined): string => (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const WINDOW = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9, 9, 9]);

/**
 * What the desktop app sends beside a `taken` event: a length, the words as
 * JSON (which say how long the first picture is), the picture of what was
 * circled, then the picture of the window round it.
 */
function body(told: Record<string, unknown>, picture: Uint8Array | null = PNG, window: Uint8Array | null = null): Uint8Array {
  const words = new TextEncoder().encode(JSON.stringify({ ...told, picture_bytes: picture?.length ?? 0 }));
  const out = new Uint8Array(4 + words.length + (picture?.length ?? 0) + (window?.length ?? 0));
  new DataView(out.buffer).setUint32(0, words.length, false);
  out.set(words, 4);
  if (picture) out.set(picture, 4 + words.length);
  if (window) out.set(window, 4 + words.length + (picture?.length ?? 0));
  return out;
}

const row = (name: string, ...parts: string[]): NotchThing => ({ kind: 'row', name, value: '', parts });
const cell = (value: string): NotchThing => ({ kind: 'cell', name: '', value, parts: [] });
const looked = (things: NotchThing[], extra: Partial<NotchLooked> = {}): NotchLooked =>
  ({ id: 'L1', how: 'loop', refused: '', app: 'excel', title: 'Payouts - Excel', around: [], things, picture: PNG, window: null, ...extra });

describe('what travels beside a look', () => {
  test('is read back as where it was, what was read, and the picture', () => {
    const got = parseNotchLookBody(body({ app: 'excel', title: 'Payouts  -  Excel', things: [
      { kind: 'row', role: 'ListItem', name: 'Acme', parts: ['Acme', '120'] },
      { kind: 'button', name: 'Send' },
    ] }))!;
    expect(got.app).toBe('excel');
    expect(got.title).toBe('Payouts - Excel');
    expect(got.things).toEqual([
      { kind: 'row', name: 'Acme', value: '', parts: ['Acme', '120'] },
      { kind: 'button', name: 'Send', value: '', parts: [] },
    ]);
    expect([...got.picture!]).toEqual([...PNG]);
    expect(got.window).toBeNull();
    expect(got.around).toEqual([]);
  });

  // The owner, 15 November 2026: the worth of a look is what stands round the thing.
  test('carries the names of what the thing stands in, and a second picture of the whole window', () => {
    const got = parseNotchLookBody(body({ app: 'chrome', title: 'Telemetry - Grafana', around: ['Installs', ' Telemetry  overview ', 7, '', 'a', 'b', 'c', 'd'],
      things: [{ kind: 'text', name: '1,284' }] }, PNG, WINDOW))!;
    expect(got.around).toEqual(['Installs', 'Telemetry overview', 'a', 'b', 'c']);
    expect([...got.picture!]).toEqual([...PNG]);
    expect([...got.window!]).toEqual([...WINDOW]);
    // Only the window: no close picture was cut.
    const only = parseNotchLookBody(body({ things: [] }, null, WINDOW))!;
    expect(only.picture).toBeNull();
    expect([...only.window!]).toEqual([...WINDOW]);
  });

  test('a desktop app that says nothing of lengths sent one picture, and that is what it is', () => {
    const words = new TextEncoder().encode(JSON.stringify({ things: [] }));
    const old = new Uint8Array(4 + words.length + PNG.length);
    new DataView(old.buffer).setUint32(0, words.length, false);
    old.set(words, 4);
    old.set(PNG, 4 + words.length);
    const got = parseNotchLookBody(old)!;
    expect([...got.picture!]).toEqual([...PNG]);
    expect(got.window).toBeNull();
    // A length that cannot be right is not believed: everything is the first picture.
    const lying = new TextEncoder().encode(JSON.stringify({ things: [], picture_bytes: 9999 }));
    const wrong = new Uint8Array(4 + lying.length + PNG.length);
    new DataView(wrong.buffer).setUint32(0, lying.length, false);
    wrong.set(lying, 4);
    wrong.set(PNG, 4 + lying.length);
    expect([...parseNotchLookBody(wrong)!.picture!]).toEqual([...PNG]);
  });

  test('everything in it is cut to its limit, and what is not text is not kept', () => {
    const got = parseNotchLookBody(body({
      app: 'a'.repeat(500), title: 7,
      things: [
        ...Array.from({ length: 80 }, (_, at) => ({ kind: 'row', name: `r${at}` })),
      ],
    }))!;
    expect(got.app.length).toBe(80);
    expect(got.title).toBe('');
    expect(got.things.length).toBe(60);
    const odd = parseNotchLookBody(body({ things: [
      { kind: 'DROP TABLE', name: 'x\u0000y\n z', value: 'v'.repeat(900), parts: ['a', 7, '', 'b', ...Array.from({ length: 20 }, () => 'c')] },
      'not a thing', null,
    ] }))!;
    expect(odd.things).toEqual([{ kind: 'thing', name: 'x y z', value: 'v'.repeat(200), parts: ['a', 'b', ...Array.from({ length: 8 }, () => 'c')] }]);
  });

  test('a picture that is not a PNG, or is too heavy, is not kept; the words are', () => {
    expect(parseNotchLookBody(body({ things: [] }, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])))!.picture).toBeNull();
    expect(parseNotchLookBody(body({ things: [] }, null))!.picture).toBeNull();
    const heavy = new Uint8Array(4 * 1024 * 1024 + 9);
    heavy.set(PNG);
    const got = parseNotchLookBody(body({ things: [{ kind: 'row', name: 'Acme' }] }, heavy))!;
    expect(got.picture).toBeNull();
    expect(got.things.length).toBe(1);
  });

  test('what cannot be read is nothing, not a guess', () => {
    expect(parseNotchLookBody(new Uint8Array([1, 2]))).toBeNull();
    expect(parseNotchLookBody(new Uint8Array([0, 0, 1, 0, 1, 2, 3]))).toBeNull();
    const broken = body({ things: [] });
    broken[5] = 0x7b;
    broken[6] = 0x7b;
    expect(parseNotchLookBody(broken)).toBeNull();
  });
});

describe('a number as people write them in a table', () => {
  test('is read whichever way its thousands and decimals are marked', () => {
    const value = (said: string): number | null => lookNumber(said)?.value ?? null;
    expect(value('120')).toBe(120);
    expect(value('1,291.00')).toBe(1291);
    expect(value('1.291,00')).toBe(1291);
    expect(value('1,291')).toBe(1291);
    expect(value('1.291')).toBe(1291);
    expect(value('12,5')).toBe(12.5);
    expect(value('12.5')).toBe(12.5);
    expect(value('1 291,50')).toBe(1291.5);
    expect(value("1'291.50")).toBe(1291.5);
    expect(value('1,234,567')).toBe(1234567);
    expect(value('0.07')).toBe(0.07);
    expect(value('-45')).toBe(-45);
    expect(value('−45')).toBe(-45);
    expect(value('(45)')).toBe(-45);
    expect(value('+3')).toBe(3);
  });

  test('keeps its unit and how many decimals it had', () => {
    expect(lookNumber('$430.33')).toEqual({ value: 430.33, unit: '$', decimals: 2 });
    expect(lookNumber('430,33 €')).toEqual({ value: 430.33, unit: '€', decimals: 2 });
    expect(lookNumber('EUR 1.200')).toEqual({ value: 1200, unit: 'EUR', decimals: 0 });
    expect(lookNumber('12 %')).toEqual({ value: 12, unit: '%', decimals: 0 });
    expect(lookNumber('-$5')).toEqual({ value: -5, unit: '$', decimals: 0 });
  });

  test('a date, a time, a size, a phone number and a word are not numbers', () => {
    for (const not of ['', 'Acme', '12/11/2026', '2026-11-12', '10:30', '24 KB', '3 items', '+39 333 123 4567', '1.2.3', '12,', '1,23,4', 'A1', '1e9', '12 34']) {
      expect(lookNumber(not)).toBeNull();
    }
  });
});

describe('several things, counted and added up without a model', () => {
  test('three rows with one column of numbers: three, and their sum', () => {
    const things = [row('Acme', 'Acme', '120'), row('Lumen', 'Lumen', '740.50'), row('Northwind', 'Northwind', '430.50')];
    expect(lookCount(things)).toBe('3 rows');
    expect(lookSums(things)).toEqual(['1,291.00']);
    expect(text(lookSeveral(things))).toBe('3 rows. They add up to 1,291.00.');
  });

  test('cents are added as cents', () => {
    expect(lookSums([cell('0.10'), cell('0.20')])).toEqual(['0.30']);
    expect(lookSums([cell('1,5'), cell('2,25')])).toEqual(['3.75']);
  });

  test('the unit is said when they all have the same one, and left out when they do not', () => {
    expect(text(lookSeveral([cell('$430.33'), cell('$860.67')]))).toBe('2 cells. They add up to $1,291.00.');
    expect(lookSums([cell('10 €'), cell('5 €')])).toEqual(['€15']);
    expect(lookSums([cell('10 %'), cell('5 %')])).toEqual(['15%']);
    expect(lookSums([cell('$10'), cell('5 €')])).toEqual(['15']);
  });

  test('two columns of numbers are two sums; a column with a word in it is not added', () => {
    const things = [row('', 'Acme', '2', '120.00'), row('', 'Lumen', '3', '80.00')];
    expect(lookSums(things)).toEqual(['5', '200.00']);
    expect(text(lookSeveral(things))).toBe('2 rows. The columns add up to 5 and 200.00.');
    expect(lookSums([row('', 'Acme', '2'), row('', 'Lumen', 'n/a')])).toEqual([]);
  });

  test('rows of different lengths are added when each has exactly one number', () => {
    expect(lookSums([row('', 'Acme', 'paid', '120'), row('', 'Lumen', '80')])).toEqual(['200']);
    expect(lookSums([row('', 'Acme', '2', '120'), row('', 'Lumen', '80')])).toEqual([]);
  });

  test('with nothing to add, it says how many and names them', () => {
    expect(text(lookSeveral([row('Budget.xlsx', 'Budget.xlsx', '24 KB'), row('Deck.pdf', 'Deck.pdf', '2 MB')]))).toBe('2 rows: Budget.xlsx, Deck.pdf.');
    const many = Array.from({ length: 5 }, (_, at) => row(`File ${at + 1}`));
    expect(text(lookSeveral(many))).toBe('5 rows: File 1, File 2, File 3, and 2 more.');
    expect(text(lookSeveral([{ kind: 'row', name: '', value: '', parts: [] }, { kind: 'button', name: '', value: '', parts: [] }]))).toBe('2 things.');
  });

  test('arithmetic is the whole answer only for rows or cells of numbers', () => {
    expect(lookAddsUp([row('Acme', 'Acme', '120'), row('Lumen', 'Lumen', '80')])).toBe(true);
    expect(lookAddsUp([cell('1'), cell('2')])).toBe(true);
    // Files in a folder have no sum: what they mean is not arithmetic.
    expect(lookAddsUp([row('Budget.xlsx', 'Budget.xlsx', '24 KB'), row('Deck.pdf', 'Deck.pdf', '2 MB')])).toBe(false);
    // A title and a figure on a dashboard are two things of two kinds.
    expect(lookAddsUp([{ kind: 'text', name: 'Installs', value: '', parts: [] }, { kind: 'text', name: '1,284', value: '', parts: [] }])).toBe(false);
    expect(lookAddsUp([{ kind: 'heading', name: '10', value: '', parts: [] }, { kind: 'heading', name: '20', value: '', parts: [] }])).toBe(false);
    expect(lookAddsUp([cell('1')])).toBe(false);
    expect(lookAddsUp([])).toBe(false);
  });

  test('a sum is said grouped in threes, with the decimals the numbers had', () => {
    expect(lookAmount(1234567.5, 2, '')).toBe('1,234,567.50');
    expect(lookAmount(-45, 0, '$')).toBe('-$45');
    expect(lookAmount(1200, 0, 'EUR')).toBe('1,200 EUR');
  });
});

describe('one thing, when no model can be asked what it means', () => {
  test('is its name and what it says', () => {
    expect(text(lookOne(row('Budget.xlsx', 'Budget.xlsx', '12 Nov 2026', 'Excel Worksheet', '24 KB')))).toBe('Budget.xlsx: 12 Nov 2026 · Excel Worksheet · 24 KB');
    expect(text(lookOne({ kind: 'button', name: 'Close', value: '', parts: [] }))).toBe('Close, a button.');
    expect(text(lookOne({ kind: 'field', name: 'Amount', value: '120', parts: [] }))).toBe('Amount: 120');
    expect(text(lookOne({ kind: 'picture', name: '', value: '', parts: [] }))).toBe('A picture with no name I can read.');
  });
});

describe('what a question about a look carries', () => {
  test('three files: what was read, as text, the picture of it, and the picture of the window round it', () => {
    const files = lookFiles(looked([row('Acme', 'Acme', '120'), row('Lumen', 'Lumen', '80')], { around: ['Payouts by customer', 'Sheet1'], window: WINDOW }));
    expect(files.map((file) => [file.kind, file.name, file.mediaType])).toEqual([
      ['document', NOTCH_LOOK_FILE, 'text/plain'], ['screenshot', NOTCH_LOOK_PICTURE, 'image/png'], ['screenshot', NOTCH_LOOK_WINDOW, 'image/png'],
    ]);
    expect(new TextDecoder().decode(files[0]!.bytes)).toBe(
      'App: excel\nWindow: Payouts - Excel\nIt stands in (nearest first): Payouts by customer > Sheet1\nWhat the person circled (2 rows):\n1. row: Acme | 120\n2. row: Lumen | 80');
    expect([...files[2]!.bytes]).toEqual([...WINDOW]);
    expect(lookFiles(looked([], { picture: null })).length).toBe(1);
    expect(lookText(looked([], { app: '', title: '' }))).toBe('App: not known\nWindow: not known\nNothing there could be read as text.');
    // A name that the cells do not repeat is said before them.
    expect(lookText(looked([{ kind: 'row', name: 'Row 4', value: '', parts: ['Acme', '120'] }]))).toContain('1. row: Row 4: Acme | 120');
  });
});

describe('why nothing was looked at', () => {
  test('is said in the words of the place', () => {
    expect(lookRefusal('password')).toBe('A password is being typed. I am not looking.');
    expect(lookRefusal('bank')).toBe('Your bank. I look away in here.');
    expect(lookRefusal('never')).toContain('never to watch this app');
    expect(lookRefusal('off')).toBe('Watching is switched off, so I did not look.');
    expect(lookRefusal('something new')).toBe('I am not looking in here.');
  });
});

function harness(options: { modelReady?: NotchLookDeps['modelReady']; talking?: () => boolean; paused?: () => boolean } = {}) {
  let onEvent: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const pushed: NotchToPage[] = [];
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { onEvent = listener; },
    onSidecarDisconnected() {},
  };
  const timers: { fn: () => void; at: number }[] = [];
  let now = 0;
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
  const surface = new NotchSurface(port, () => {});
  onEvent('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message: { type: 'hello', v: 1 } } });
  const inbox = new NotchInbox(surface, { clock, log: () => {} });
  const asked: { text: string; files: NotchAskFile[] }[] = [];
  const logs: string[] = [];
  let fromApp: (sidecarId: string, event: { event_type: string; payload: unknown; binary?: unknown }) => void = () => {};
  let gone: (sidecarId: string) => void = () => {};
  const look = attachNotchLook(
    { onEvent: (listener) => { fromApp = listener; }, onSidecarDisconnected: (listener) => { gone = listener; } },
    {
      inbox, ask: (words, files) => { asked.push({ text: words, files }); }, talking: () => options.talking?.() ?? false,
      modelReady: options.modelReady, paused: options.paused, graceMs: 20, takeMs: 60, log: (line) => logs.push(line),
    });
  const line = (): NotchLine | null => surface.current().line;
  const send = (payload: Record<string, unknown>, bytes?: Uint8Array, sidecarId = 'pc'): void =>
    fromApp(sidecarId, { event_type: NOTCH_LOOK_EVENT, payload, ...(bytes ? { binary: { type: 'inline', data: Buffer.from(bytes).toString('base64') } } : {}) });
  return {
    look, asked, logs, line, send,
    said: (): string => text(line()?.say),
    disconnect: (sidecarId = 'pc') => gone(sidecarId),
    begun: (id = 'L1'): void => send({ phase: 'begun', look_id: id }),
    taken: (things: Record<string, unknown>[], extra: Record<string, unknown> = {}, id = 'L1', picture: Uint8Array | null = PNG, window: Uint8Array | null = null, around: string[] = []): void =>
      send({ phase: 'taken', look_id: id, how: 'loop', things: things.length, ...extra }, body({ app: 'excel', title: 'Payouts - Excel', around, things }, picture, window)),
    async wait(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); await settle(); },
  };
}

const threeRows = [
  { kind: 'row', name: 'Acme', parts: ['Acme', '120'] },
  { kind: 'row', name: 'Lumen', parts: ['Lumen', '740.50'] },
  { kind: 'row', name: 'Northwind', parts: ['Northwind', '430.50'] },
];

describe('a look with nothing said', () => {
  // The owner's test for pass 9: "Circle three rows. It says three, with a sum if they are numbers."
  test('three rows of numbers: one line with how many and their sum, at once, and nothing is asked', async () => {
    const h = harness();
    h.begun();
    h.taken(threeRows);
    expect(h.line()).toBeNull();
    await h.wait(40);
    expect(h.said()).toBe('3 rows. They add up to 1,291.00.');
    expect(h.asked).toEqual([]);
    // What was read is never in the log.
    expect(h.logs.join('\n')).not.toContain('Acme');
    expect(h.logs.join('\n')).toContain('3 thing(s)');
  });

  // The owner, 15 November 2026, after circling the number of installs on a dashboard and being told
  // only that he was circling it: "it should give me, your installs are this and they've gone up by this much".
  test('a figure on a dashboard is not named back: what it means is asked, with what stands round it and both pictures', async () => {
    const h = harness();
    h.begun();
    h.taken([{ kind: 'text', name: '1,284' }], {}, 'L1', PNG, WINDOW, ['Installs', 'Telemetry overview']);
    await h.wait(40);
    expect(h.asked.map((ask) => [ask.text, ask.files.map((file) => file.name)])).toEqual([
      [NOTCH_LOOK_QUESTION, [NOTCH_LOOK_FILE, NOTCH_LOOK_PICTURE, NOTCH_LOOK_WINDOW]],
    ]);
    const read = new TextDecoder().decode(h.asked[0]!.files[0]!.bytes);
    expect(read).toContain('It stands in (nearest first): Installs > Telemetry overview');
    expect(read).toContain('1. text: 1,284');
    // The look says nothing by itself: the answer is the instruction's.
    expect(h.line()).toBeNull();
    expect(h.logs.join('\n')).not.toContain('Installs');
    expect(h.logs.join('\n')).toContain('2 name(s) round them');
  });

  test('several things that are not rows of numbers are asked about too', async () => {
    const h = harness();
    h.taken([{ kind: 'text', name: 'Installs' }, { kind: 'text', name: '1,284' }, { kind: 'text', name: '+12%' }]);
    await h.wait(40);
    expect(h.asked.map((ask) => ask.text)).toEqual([NOTCH_LOOK_QUESTION]);
    const files = harness();
    files.taken([{ kind: 'row', name: 'Budget.xlsx', parts: ['Budget.xlsx', '24 KB'] }, { kind: 'row', name: 'Deck.pdf', parts: ['Deck.pdf', '2 MB'] }]);
    await files.wait(40);
    expect(files.asked.length).toBe(1);
  });

  test('with no model to ask, what was read is said as it is', async () => {
    const one = harness({ modelReady: () => false });
    one.taken([{ kind: 'row', name: 'Budget.xlsx', parts: ['Budget.xlsx', '24 KB'] }]);
    await one.wait(40);
    expect(one.said()).toBe('Budget.xlsx: 24 KB');
    expect(one.asked).toEqual([]);
    const several = harness({ modelReady: () => false });
    several.taken([{ kind: 'text', name: 'Installs' }, { kind: 'text', name: '1,284' }]);
    await several.wait(40);
    expect(several.said()).toBe('2 texts: Installs, 1,284.');
    const nothing = harness({ modelReady: () => false });
    nothing.taken([]);
    await nothing.wait(40);
    expect(nothing.said()).toBe('I could not read what that is.');
  });

  test('nothing could be read: the pictures are asked about; with none it says so', async () => {
    const h = harness();
    h.begun();
    h.taken([]);
    await h.wait(40);
    expect(h.asked.map((ask) => [ask.text, ask.files.map((file) => file.name)])).toEqual([[NOTCH_LOOK_QUESTION, [NOTCH_LOOK_FILE, NOTCH_LOOK_PICTURE]]]);
    expect(h.line()).toBeNull();
    const blind = harness();
    blind.taken([], {}, 'L2', null);
    await blind.wait(40);
    expect(blind.asked).toEqual([]);
    expect(blind.said()).toBe('I could not read what that is.');
  });

  test('where the desktop app looked away it says why, at once, and nothing is read', async () => {
    const h = harness({ talking: () => true });
    h.begun();
    h.send({ phase: 'taken', look_id: 'L1', how: 'click', refused: 'bank' });
    await settle();
    expect(h.said()).toBe('Your bank. I look away in here.');
    expect(h.asked).toEqual([]);
  });

  test('with everything stopped it says so and asks nothing', async () => {
    const h = harness({ paused: () => true });
    h.taken([{ kind: 'button', name: 'Close' }]);
    await h.wait(40);
    expect(h.said()).toBe('Everything is stopped. Wake me first.');
    expect(h.asked).toEqual([]);
  });

  test('a line that was thrown away says nothing', async () => {
    const h = harness();
    h.begun();
    h.send({ phase: 'dropped', look_id: 'L1' });
    await h.wait(40);
    expect(h.line()).toBeNull();
    expect(h.look.during('pc', 0)).toBe(false);
  });
});

describe('a look and what is said with the keys held', () => {
  test('while the keys are held it waits: what is said, or that nothing is, decides', async () => {
    let talking = true;
    const h = harness({ talking: () => talking });
    h.begun();
    expect(h.look.during('pc', 0)).toBe(true);
    h.taken(threeRows);
    await h.wait(40);
    // Still held: nothing is said yet.
    expect(h.line()).toBeNull();
    // The keys came up and nothing was said.
    talking = false;
    h.look.alone('pc');
    await settle();
    expect(h.said()).toBe('3 rows. They add up to 1,291.00.');
    expect(h.look.during('pc', 0)).toBe(false);
  });

  test('"nothing was said" can come before the look is read: it answers when it is', async () => {
    const h = harness({ talking: () => false });
    h.begun();
    h.look.alone('pc');
    await settle();
    expect(h.line()).toBeNull();
    h.taken(threeRows);
    await settle();
    expect(h.said()).toBe('3 rows. They add up to 1,291.00.');
  });

  test('something was said: the words carry what was circled, and the look says nothing by itself', async () => {
    const h = harness({ talking: () => true });
    h.begun();
    h.taken(threeRows);
    const files = await h.look.files('pc');
    expect(files!.map((file) => file.name)).toEqual([NOTCH_LOOK_FILE, NOTCH_LOOK_PICTURE]);
    expect(new TextDecoder().decode(files![0]!.bytes)).toContain('2. row: Lumen | 740.50');
    await h.wait(40);
    expect(h.line()).toBeNull();
    expect(h.look.during('pc', 0)).toBe(false);
    // Asked for once: there is nothing to give a second time.
    expect(await h.look.files('pc')).toBeNull();
  });

  test('the words can be ready before the look is: they wait for it, and not for ever', async () => {
    const h = harness({ talking: () => false });
    h.begun();
    const waiting = h.look.files('pc');
    h.taken(threeRows);
    expect((await waiting)!.length).toBe(2);
    await h.wait(40);
    expect(h.line()).toBeNull();
    // A look that never comes: the words go alone.
    const never = harness();
    never.begun('L9');
    expect(await never.look.files('pc')).toBeNull();
  });

  test('a look that was refused has nothing to go with the words', async () => {
    const h = harness({ talking: () => true });
    h.begun();
    const waiting = h.look.files('pc');
    h.send({ phase: 'taken', look_id: 'L1', how: 'loop', refused: 'password' });
    expect(await waiting).toBeNull();
  });

  test('a click told before the keys had become talking waits a moment for them', async () => {
    let talking = false;
    const h = harness({ talking: () => talking });
    h.taken([{ kind: 'button', name: 'Close' }], { how: 'click' });
    // The hold becomes talking 150 ms after the keys go down.
    talking = true;
    await h.wait(40);
    expect(h.line()).toBeNull();
    talking = false;
    h.look.alone('pc');
    await settle();
    expect(h.asked.map((ask) => ask.text)).toEqual([NOTCH_LOOK_QUESTION]);
  });

  test('only a look begun since the keys went down belongs to that hold', () => {
    const h = harness();
    h.begun();
    expect(h.look.during('pc', Date.now() - 1000)).toBe(true);
    expect(h.look.during('pc', Date.now() + 1000)).toBe(false);
    expect(h.look.during('other', 0)).toBe(false);
  });

  test('a new line takes the place of one that was never finished; a desktop app that goes away takes its look with it', async () => {
    const h = harness({ talking: () => true });
    h.begun('L1');
    const first = h.look.files('pc');
    h.begun('L2');
    expect(await first).toBeNull();
    h.disconnect();
    expect(h.look.during('pc', 0)).toBe(false);
  });

  test('an id that is not an id, and an event of another kind, are not a look', async () => {
    const h = harness();
    h.send({ phase: 'begun', look_id: 'not an id!' });
    h.send({ phase: 'begun' });
    expect(h.look.during('pc', 0)).toBe(false);
    h.send({ phase: 'sideways', look_id: 'L1' });
    expect(h.look.during('pc', 0)).toBe(false);
  });
});
