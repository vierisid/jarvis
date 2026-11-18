import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { NotchInbox } from './inbox.ts';
import { attachNotchJobs, type NotchActResult, type NotchJobHands } from './jobs.ts';
import type { NotchLooked, NotchThing } from './look.ts';
import type { NotchLine, NotchPart, NotchToPage } from './protocol.ts';
import {
  NOTCH_HOLD_MS, NOTCH_PUT_SAID_MS, NOTCH_READ_MAX_BYTES, NOTCH_READ_WHAT, attachNotchPut, heldFrom, heldFromRows, heldIsTable, parseRead, putAnswer,
  putForm, putRequest, takesAThing,
} from './put.ts';
import { NOTCH_MESSAGE_EVENT, NotchSurface } from './surface.ts';
import type { NotchSurfacePort } from './surface.ts';

const settle = async (): Promise<void> => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const text = (parts: NotchPart[] | undefined): string =>
  (parts ?? []).map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : 'word' in part ? part.word.value : '')).join('');

const thing = (kind: string, more: Partial<NotchThing> = {}): NotchThing => ({ kind, name: '', value: '', parts: [], ...more });
const looked = (things: NotchThing[], more: Partial<NotchLooked> = {}): NotchLooked =>
  ({ id: 'l1', how: 'loop', refused: '', app: 'Grafana', title: 'Installs', around: [], things, picture: null, window: null, ...more });

const ROWS = [
  thing('row', { parts: ['Acme', '1,200.00', 'paid'] }),
  thing('row', { parts: ['Lumen', '430.33', 'late'] }),
  thing('row', { parts: ['Northwind', '91.00', 'paid'] }),
];
const FIELD = looked([thing('field', { role: 'Edit' })], { how: 'click', app: 'Notepad', at: { x: 900, y: 500 } });

describe('what is held, and what takes it', () => {
  test('rows are held as rows: cells parted by tabs, rows by line ends', () => {
    expect(heldFrom(looked(ROWS), 5)).toEqual({
      what: '3 rows', text: 'Acme\t1,200.00\tpaid\nLumen\t430.33\tlate\nNorthwind\t91.00\tpaid',
      rows: [['Acme', '1,200.00', 'paid'], ['Lumen', '430.33', 'late'], ['Northwind', '91.00', 'paid']], app: 'Grafana', at: 5,
    });
    // Several rows, or one row of several cells, have a form to choose. One value is just put.
    expect(heldIsTable(heldFrom(looked(ROWS), 5)!)).toBe(true);
    expect(heldIsTable(heldFrom(looked([ROWS[0]!]), 5)!)).toBe(true);
    expect(heldIsTable(heldFrom(looked([thing('text', { name: '1,291' })]), 5)!)).toBe(false);
  });

  test('one short thing is called by what it says, a long one by its kind', () => {
    expect(heldFrom(looked([thing('text', { name: '1,291' })]), 5)).toMatchObject({ what: '1,291', text: '1,291' });
    expect(heldFrom(looked([thing('cell', { name: 'B7', value: '42' })]), 5)).toMatchObject({ what: '42', text: '42' });
    expect(heldFrom(looked([thing('text', { name: 'Installs in the last thirty days, all channels' })]), 5)).toMatchObject({ what: 'this text' });
  });

  test('nothing is held of a look that read nothing, was refused, or was cut short where it was read', () => {
    expect(heldFrom(looked([]), 5)).toBeNull();
    expect(heldFrom(looked([thing('picture')]), 5)).toBeNull();
    expect(heldFrom(looked(ROWS, { refused: 'bank' }), 5)).toBeNull();
    // Half a text is not put anywhere.
    expect(heldFrom(looked([thing('text', { name: 'A very long paragraph that was cut where it was rea…' })]), 5)).toBeNull();
  });

  test('a field, a cell and a page of writing take a thing; a button, a link and a picture do not', () => {
    for (const place of [thing('field'), thing('cell'), thing('thing', { role: 'Document' }), thing('thing', { role: 'DataItem' }), thing('thing', { role: 'Edit' })]) expect(takesAThing(place)).toBe(true);
    for (const place of [thing('button', { role: 'Button' }), thing('link'), thing('picture'), thing('text', { role: 'Text' }), thing('row', { role: 'ListItem' })]) expect(takesAThing(place)).toBe(false);
    expect(takesAThing(undefined)).toBe(false);
  });
});

function harness(options: { result?: NotchActResult | null | 'lost'; paused?: () => boolean; read?: (picture: Uint8Array) => Promise<string[][] | null> } = {}) {
  let toSurface: (sidecarId: string, event: { event_type: string; payload: unknown }) => void = () => {};
  const pushed: NotchToPage[] = [];
  const port: NotchSurfacePort = {
    dispatchRPC(_sidecarId, _method, params) { pushed.push((params as { message: NotchToPage }).message); return Promise.resolve({}); },
    onEvent(listener) { toSurface = listener; },
    onSidecarDisconnected() {},
  };
  const timers: { fn: () => void; at: number }[] = [];
  let now = 1_000_000;
  const clock = {
    setTimeout: (fn: () => void, ms: number) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown) => { const at = timers.indexOf(handle as { fn: () => void; at: number }); if (at >= 0) timers.splice(at, 1); },
  };
  const surface = new NotchSurface(port, () => {});
  const fromPage = (message: unknown): void => toSurface('pc', { event_type: NOTCH_MESSAGE_EVENT, payload: { message } });
  fromPage({ type: 'hello', v: 1 });
  const inbox = new NotchInbox(surface, { clock, log: () => {} });
  const sent: Record<string, unknown>[] = [];
  const hands: NotchJobHands = {
    act(request) {
      sent.push(request);
      if (request.do !== 'paste') return Promise.resolve({ done: true });
      if (options.result === 'lost') return Promise.reject(new Error('no answer'));
      return Promise.resolve(options.result === undefined
        ? { done: true, app: 'Notepad', win: { id: '0x9', pid: 9, w: 800, h: 600 }, pt: { x: 200, y: 300 }, shape: { rows: 3, cols: 3, hash: 'abc' } }
        : options.result);
    },
  };
  const jobs = attachNotchJobs(inbox, { db: new Database(':memory:'), hands, sleep: async () => {}, now: () => now, log: () => {} });
  const holds: { what: string; ms: number }[] = [];
  const put = attachNotchPut({
    inbox, jobs, hands, paused: options.paused, read: options.read, now: () => now, log: () => {},
    hold: (_sidecarId, what, ms) => { holds.push({ what, ms }); },
  });
  const line = (): NotchLine | null => surface.current().line;
  const said = (): string => text(line()?.say);
  const reply = async (act: string, more: Record<string, unknown> = {}): Promise<void> => {
    fromPage({ type: 'answer', id: line()!.id, act, ...more });
    await settle();
  };
  /** Says something on the notch, as asking does: the words are routed, and what they set off is run. */
  const speak = async (words: string): Promise<string | null> => {
    const route = put.route(words);
    route?.run();
    await settle();
    return route?.did ?? null;
  };
  return { put, jobs, sent, holds, line, said, reply, speak, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('show it a thing, then point at a place', () => {
  // The plan's test, step 5: "Show it a number in one app, then point at a field in Notepad. Yes. It is there."
  test('what was shown is held, and the desktop app is told so it can say "Put ... here" before the click', async () => {
    const h = harness();
    // The look goes on to answer as it always does.
    expect(h.put.shown('pc', looked(ROWS))).toBe(false);
    expect(h.holds).toEqual([{ what: '3 rows', ms: NOTCH_HOLD_MS }]);
    expect(h.put.held()).toMatchObject({ what: '3 rows' });
  });

  test('a click on a field while it is held asks, and a yes puts it there', async () => {
    const h = harness();
    h.put.shown('pc', looked(ROWS));
    h.advance(20_000);
    // Taken: the look itself says nothing.
    expect(h.put.shown('pc', FIELD)).toBe(true);
    await settle();
    // Rows into a document go as a table, unless the person says otherwise.
    expect(h.said()).toBe('Put 3 rows here as a table?');
    expect(h.line()).toMatchObject({ kind: 'offer', yes: 'put' });
    // Nothing has been done yet.
    expect(h.sent).toEqual([]);
    await h.reply('yes');
    // As rows of cells, with the form they are to take: the desktop app makes the table.
    expect(h.sent[0]).toEqual({
      do: 'paste', screen: true, x: 900, y: 500, in: 'Notepad', as: 'table', hand: 0,
      rows: [['Acme', '1,200.00', 'paid'], ['Lumen', '430.33', 'late'], ['Northwind', '91.00', 'paid']],
    });
    // The pointer goes home when it is done.
    expect(h.sent[1]).toEqual({ do: 'home' });
    expect(h.said()).toBe('There. It is in Notepad.');
    // It is in what was done today. Into a page of writing, it cannot be taken back from there.
    expect(h.jobs.done(0)).toMatchObject([{ text: 'Put 3 rows from Grafana into Notepad as a table', undoable: false }]);
    // Put once: it is not held any more.
    expect(h.put.held()).toBeNull();
    expect(h.holds.at(-1)).toEqual({ what: '', ms: 0 });
  });

  test('what went into a cell can be taken back', async () => {
    const h = harness();
    h.put.shown('pc', looked(ROWS));
    h.put.shown('pc', looked([thing('cell', { role: 'DataItem', name: 'B7' })], { how: 'click', app: 'Excel', at: { x: 400, y: 300 } }));
    await settle();
    // Into a cell there is no form to choose: rows go in as cells.
    expect(h.said()).toBe('Put 3 rows here?');
    await h.reply('yes');
    expect(h.sent[0]).toMatchObject({ do: 'paste', as: 'cells', x: 400, y: 300 });
    expect(h.jobs.done(0)).toMatchObject([{ text: 'Put 3 rows from Grafana into Notepad', undoable: true }]);
    expect(h.jobs.store.since(0)[0]!.puts).toEqual([{ win: { id: '0x9', pid: 9, w: 800, h: 600 }, x: 200, y: 300, rows: 3, cols: 3, hash: 'abc' }]);
    // Never the text.
    expect(JSON.stringify(h.jobs.store.since(0))).not.toContain('Acme');
  });

  test('Esc puts nothing, and the thing is still held', async () => {
    const h = harness();
    h.put.shown('pc', looked(ROWS));
    h.put.shown('pc', FIELD);
    await settle();
    await h.reply('no');
    expect(h.sent).toEqual([]);
    expect(h.put.held()).toMatchObject({ what: '3 rows' });
  });

  test('a click on something that takes nothing is a look like any other, and is what is held from then on', async () => {
    const h = harness();
    h.put.shown('pc', looked(ROWS));
    const button = looked([thing('button', { role: 'Button', name: 'Send' })], { how: 'click', at: { x: 10, y: 10 } });
    expect(h.put.shown('pc', button)).toBe(false);
    expect(h.put.held()).toMatchObject({ what: 'Send' });
    // Circling a field is looking at it, not pointing at a place.
    expect(h.put.shown('pc', { ...FIELD, how: 'loop' })).toBe(false);
  });

  test('after ninety seconds it has forgotten, and says so instead of putting something stale', async () => {
    const h = harness();
    h.put.shown('pc', looked(ROWS));
    h.advance(NOTCH_HOLD_MS + 1000);
    expect(h.put.held()).toBeNull();
    expect(h.put.shown('pc', FIELD)).toBe(true);
    await settle();
    expect(h.said()).toBe('I no longer have what you showed me. Show me again, then point here.');
    expect(h.sent).toEqual([]);
    // Much later a click on a field is just a look.
    h.put.shown('pc', looked(ROWS));
    h.advance(10 * 60_000);
    expect(h.put.shown('pc', FIELD)).toBe(false);
  });

  test('when it cannot be put there, it says why and that nothing was put', async () => {
    const h = harness({ result: { done: false, why: 'elevated' } });
    h.put.shown('pc', looked(ROWS));
    h.put.shown('pc', FIELD);
    await settle();
    await h.reply('yes');
    expect(h.said()).toBe('That window runs as administrator, and I cannot reach it. Nothing was put there.');
    expect(h.jobs.done(0)).toEqual([]);
    // It is still held: the person can point somewhere else.
    expect(h.put.held()).toMatchObject({ what: '3 rows' });
  });

  test('a lost answer is not called done: it says to look', async () => {
    const h = harness({ result: 'lost' });
    h.put.shown('pc', looked(ROWS));
    h.put.shown('pc', FIELD);
    await settle();
    await h.reply('yes');
    expect(h.said()).toBe('I lost touch with your computer in the middle of it. Look whether it is there.');
    expect(h.jobs.done(0)).toEqual([]);
  });

  test('with everything stopped a yes puts nothing', async () => {
    const h = harness({ paused: () => true });
    h.put.shown('pc', looked(ROWS));
    h.put.shown('pc', FIELD);
    await settle();
    await h.reply('yes');
    expect(h.said()).toBe('Everything is stopped. Wake me first.');
    expect(h.sent).toEqual([]);
  });

  test('a look that was refused is neither held nor a place', () => {
    const h = harness();
    expect(h.put.shown('pc', looked(ROWS, { refused: 'password' }))).toBe(false);
    expect(h.put.held()).toBeNull();
    h.put.shown('pc', looked(ROWS));
    expect(h.put.shown('pc', { ...FIELD, refused: 'bank' })).toBe(false);
  });
});

// The owner, 16 November 2026: put it there "is only useful if the formatting is done correctly".
describe('the form a thing is put in', () => {
  test('the form can be changed on the line before the yes', async () => {
    const h = harness();
    h.put.shown('pc', looked(ROWS));
    h.put.shown('pc', FIELD);
    await settle();
    expect(h.line()).toMatchObject({ say: ['Put ', { em: '3 rows' }, ' here as ', { word: { name: 'as', value: 'a table', options: ['a table', 'a list', 'plain text'] } }, '?'] });
    await h.reply('word', { word: 'as', value: 'a list' });
    expect(h.said()).toBe('Put 3 rows here as a list?');
    // A value that is not one of the forms changes nothing.
    await h.reply('word', { word: 'as', value: 'a spreadsheet' });
    expect(h.said()).toBe('Put 3 rows here as a list?');
    await h.reply('yes');
    expect(h.sent[0]).toMatchObject({ do: 'paste', as: 'list', rows: [['Acme', '1,200.00', 'paid'], ['Lumen', '430.33', 'late'], ['Northwind', '91.00', 'paid']] });
    expect(h.jobs.done(0)).toMatchObject([{ text: 'Put 3 rows from Grafana into Notepad as a list' }]);
  });

  test('one value has no form: it is put as the words it is', async () => {
    const h = harness();
    h.put.shown('pc', looked([thing('text', { name: '1,291' })]));
    h.put.shown('pc', FIELD);
    await settle();
    expect(h.said()).toBe('Put 1,291 here?');
    await h.reply('yes');
    expect(h.sent[0]).toEqual({ do: 'paste', screen: true, x: 900, y: 500, in: 'Notepad', text: '1,291', hand: 0 });
  });

  test('what the words ask for', () => {
    expect(putForm('put it here as a table')).toBe('a table');
    expect(putForm('Paste that into the doc formatted as a table please')).toBe('a table');
    expect(putForm('as a bulleted list')).toBe('a list');
    expect(putForm('bullet points')).toBe('a list');
    expect(putForm('just plain text')).toBe('plain text');
    expect(putForm('put it here')).toBeNull();
    for (const said of ['Put it here', 'put that here as a table', 'Paste it into the doc', 'Okay, put this in my document as a table', 'insert it here', 'mettilo qui']) expect(putRequest(said)).toBe(true);
    for (const said of ['What does this put option do', 'I put it there yesterday', 'Can you summarise the table', '']) expect(putRequest(said)).toBe(false);
    // The verb alone is not enough: for a minute and a half after any look these pasted what had been looked
    // at into the window in front, with no question (the audit, 17 November 2026).
    for (const said of ['put a meeting with Sam on my calendar for Friday', 'Place an order for more paper', 'insert a row above', 'Drop Anna a note', 'paste the link from Leo into the chat', 'put the kettle on']) {
      expect([said, putRequest(said)]).toEqual([said, false]);
    }
    for (const said of ['paste', 'Paste here.', 'put them in the sheet', 'paste the table into my doc', 'insert the numbers here', 'incollalo qui']) expect([said, putRequest(said)]).toEqual([said, true]);
    for (const said of ['yes', 'Here', 'as a list', 'As a table.', 'table', 'make it a list', 'plain text', 'yes, as a table', 'in a table']) expect(putAnswer(said)).toBe(true);
    for (const said of ['the table is wrong', 'yes and then email it to Anna', 'what is a table', 'list my meetings']) expect(putAnswer(said)).toBe(false);
  });

  test('said instead of tapped: "as a list" answers the line that asked, and it is put in that form', async () => {
    const h = harness();
    h.put.shown('pc', looked(ROWS));
    h.put.shown('pc', FIELD);
    await settle();
    expect(await h.speak('as a list')).toBe('Put what you showed me where you pointed.');
    expect(h.sent[0]).toMatchObject({ do: 'paste', screen: true, x: 900, y: 500, as: 'list' });
    expect(h.said()).toBe('There. It is in Notepad.');
    // Once: the line that asked is gone, and saying it again finds nothing held.
    expect(h.put.route('as a list')).toBeNull();
    expect(h.sent.filter((request) => request.do === 'paste').length).toBe(1);
  });

  test('"yes" keeps the form the line shows', async () => {
    const h = harness();
    h.put.shown('pc', looked(ROWS));
    h.put.shown('pc', FIELD);
    await settle();
    await h.reply('word', { word: 'as', value: 'plain text' });
    await h.speak('yes');
    expect(h.sent[0]).toMatchObject({ do: 'paste', as: 'text' });
  });

  // Without pointing: it goes where the caret is in the window in front.
  test('"put it here as a table" with a thing held and no place pointed at puts it at the caret', async () => {
    const h = harness();
    h.put.shown('pc', looked(ROWS));
    expect(await h.speak('Put it here as a table')).toBe('Put what you showed me where you pointed.');
    expect(h.sent[0]).toEqual({
      do: 'paste', front: true, as: 'table', hand: 0,
      rows: [['Acme', '1,200.00', 'paid'], ['Lumen', '430.33', 'late'], ['Northwind', '91.00', 'paid']],
    });
    expect(h.said()).toBe('There. It is in Notepad.');
  });

  test('with nothing held the same words are an instruction like any other', () => {
    const h = harness();
    expect(h.put.route('Put it here as a table')).toBeNull();
    expect(h.put.route('as a list')).toBeNull();
    // Held too long ago is not held.
    h.put.shown('pc', looked(ROWS));
    h.advance(NOTCH_HOLD_MS + 1);
    expect(h.put.route('Put it here as a table')).toBeNull();
  });

  test('a few words long after the line asked are not its answer; other words never are', async () => {
    const h = harness();
    h.put.shown('pc', looked(ROWS));
    h.put.shown('pc', FIELD);
    await settle();
    expect(h.put.route('What is on my calendar today')).toBeNull();
    expect(h.put.route('the table is wrong')).toBeNull();
    h.advance(NOTCH_PUT_SAID_MS + 1);
    // "as a list" alone no longer answers it. "Put it here" still means what it says, while the thing is held.
    expect(h.put.route('as a list')).toBeNull();
  });
});

// The owner's first test, 16 November 2026: he circled five numbers on a
// dashboard in a browser, pointed at Notepad, and the name of the browser's
// window was put there. The browser says nothing about what is on its page,
// so all the look had was the page itself.
describe('a circle the program says nothing about is read off its picture', () => {
  const PICTURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  // What the desktop app tells of a circle drawn on such a page: the page, which the line was drawn inside.
  const PAGE = looked([thing('thing', { role: 'Document', name: 'Telemetry - Dashboard - Browser', over: true })], { app: 'Browser', picture: PICTURE });
  const READ = [['total installs', '12.0 K'], ['online now', '177'], ['DAU', '685'], ['WAU', '2.96 K'], ['MAU', '5.41 K']];
  /** A reading that answers when the test says so. */
  function reader() {
    const asked: Uint8Array[] = [];
    let answer: (rows: string[][] | null) => void = () => {};
    const read = (picture: Uint8Array): Promise<string[][] | null> => {
      asked.push(picture);
      return new Promise((resolve) => { answer = resolve; });
    };
    return { read, asked, answer: async (rows: string[][] | null) => { answer(rows); await settle(); } };
  }

  test('what a page, a pane or a window is called is never what was circled', () => {
    // The thing the line was drawn inside is where the circle is, not what it holds.
    expect(heldFrom(PAGE, 5)).toBeNull();
    expect(heldFrom(looked([thing('row', { parts: ['Acme', '91.00'] }), thing('thing', { role: 'Pane', name: 'Sheet', over: true })]), 5)).toBeNull();
    // A click on a page: its name is not carried either. What it holds is.
    expect(heldFrom(looked([thing('thing', { role: 'Document', name: 'Telemetry - Dashboard - Browser' })], { how: 'click' }), 5)).toBeNull();
    expect(heldFrom(looked([thing('thing', { role: 'Window', name: 'Browser' })], { how: 'click' }), 5)).toBeNull();
    expect(heldFrom(looked([thing('thing', { role: 'Document', name: 'notes.txt', value: 'Call Sam at four' })], { how: 'click' }), 5)).toMatchObject({ text: 'Call Sam at four' });
    // A button is still called what it is called.
    expect(heldFrom(looked([thing('button', { role: 'Button', name: 'Send' })], { how: 'click' }), 5)).toMatchObject({ text: 'Send' });
  });

  test('the answer of the model that copies is rows of cells, and nothing else is taken from it', () => {
    expect(parseRead('{"rows":[["DAU","685"],["WAU","2.96 K"]]}')).toEqual([['DAU', '685'], ['WAU', '2.96 K']]);
    // With words round it, or a fence: only the rows.
    expect(parseRead('Here it is:\n```json\n{"rows":[["DAU",685]]}\n```')).toEqual([['DAU', '685']]);
    // A cell is one cell wherever it is put: one line, no tabs.
    expect(parseRead(JSON.stringify({ rows: [['a\tb', 'two\nlines', '  spaced   out ']] }))).toEqual([['a b', 'two lines', 'spaced out']]);
    expect(parseRead('{"rows":[]}')).toEqual([]);
    for (const not of ['', 'I cannot read this.', '{"rows":"DAU 685"}', '{"rows":[["a"],"b"]}', '{"rows":[[{"x":1}]]}', '{"cells":[["a"]]}', '{"rows":[["a"]']) {
      expect(parseRead(not)).toBeNull();
    }
  });

  test('rows read off a picture are held like rows read from a program', () => {
    expect(heldFromRows(READ, 'Browser', 7)).toEqual({
      what: '5 rows', text: 'total installs\t12.0 K\nonline now\t177\nDAU\t685\nWAU\t2.96 K\nMAU\t5.41 K', rows: READ, app: 'Browser', at: 7,
    });
    // A row with nothing in a column still has that column; a row with nothing at all is no row.
    expect(heldFromRows([['a', 'b', 'c'], ['d'], ['', '']], 'Sheet', 7)).toMatchObject({ what: '2 rows', rows: [['a', 'b', 'c'], ['d', '', '']] });
    expect(heldFromRows([['177']], 'Browser', 7)).toMatchObject({ what: '177', text: '177' });
    expect(heldFromRows([['DAU', '685']], 'Browser', 7)).toMatchObject({ what: '1 row' });
    expect(heldFromRows([], 'Browser', 7)).toBeNull();
    expect(heldFromRows([[''], []], 'Browser', 7)).toBeNull();
  });

  test('the numbers are put, never the name of the window', async () => {
    const r = reader();
    const h = harness({ read: r.read });
    // The look goes on to answer as it always does.
    expect(h.put.shown('pc', PAGE)).toBe(false);
    expect(r.asked).toEqual([PICTURE]);
    // Beside the pointer at once, before it is known how much there is.
    expect(h.holds).toEqual([{ what: NOTCH_READ_WHAT, ms: NOTCH_HOLD_MS }]);
    expect(h.put.held()).toBeNull();
    h.advance(3000);
    await r.answer(READ);
    expect(h.put.held()).toMatchObject({ what: '5 rows', rows: READ });
    // Still ninety seconds from when it was shown, not from when it was read.
    expect(h.holds.at(-1)).toEqual({ what: '5 rows', ms: NOTCH_HOLD_MS - 3000 });
    expect(h.put.shown('pc', FIELD)).toBe(true);
    await settle();
    expect(h.said()).toBe('Put 5 rows here as a table?');
    await h.reply('yes');
    // The program the place was in goes with it: a yes that comes late puts nothing where another program is by then.
    expect(h.sent[0]).toEqual({ do: 'paste', screen: true, x: 900, y: 500, in: 'Notepad', as: 'table', hand: 0, rows: READ });
    expect(JSON.stringify(h.sent)).not.toContain('Telemetry');
    expect(h.said()).toBe('There. It is in Notepad.');
    // Put once. A click on the field after that is a look like any other.
    expect(h.put.shown('pc', FIELD)).toBe(false);
  });

  test('a place pointed at while it is still being read waits for it', async () => {
    const r = reader();
    const h = harness({ read: r.read });
    h.put.shown('pc', PAGE);
    // Taken: the click is for what was circled, not a new look.
    expect(h.put.shown('pc', FIELD)).toBe(true);
    await settle();
    expect(h.line()).toBeNull();
    await r.answer(READ);
    expect(h.said()).toBe('Put 5 rows here as a table?');
  });

  test('when it cannot be read it says so, and puts nothing', async () => {
    for (const answer of [null, [], [['', '']]] as (string[][] | null)[]) {
      const r = reader();
      const h = harness({ read: r.read });
      h.put.shown('pc', PAGE);
      await r.answer(answer);
      expect(h.put.held()).toBeNull();
      // Nothing stands beside the pointer any more.
      expect(h.holds.at(-1)).toEqual({ what: '', ms: 0 });
      expect(h.put.shown('pc', FIELD)).toBe(true);
      await settle();
      expect(h.said()).toBe('I could not read what you circled. Nothing was put there.');
      expect(h.sent).toEqual([]);
      // Said once. After that a click there is a look like any other.
      expect(h.put.shown('pc', FIELD)).toBe(false);
    }
    // A reading that fails outright is the same.
    const h = harness({ read: () => Promise.reject(new Error('no model')) });
    h.put.shown('pc', PAGE);
    await settle();
    expect(h.put.shown('pc', FIELD)).toBe(true);
    await settle();
    expect(h.said()).toBe('I could not read what you circled. Nothing was put there.');
  });

  test('with no model that sees pictures, nothing is held and nothing is promised', async () => {
    const h = harness();
    expect(h.put.shown('pc', PAGE)).toBe(false);
    expect(h.holds).toEqual([]);
    // A click on the field is a look like any other.
    expect(h.put.shown('pc', FIELD)).toBe(false);
  });

  test('a click is never read off a picture, nor a circle with no picture or one too heavy', () => {
    const r = reader();
    const h = harness({ read: r.read });
    h.put.shown('pc', looked([thing('thing', { role: 'Document', name: 'Browser' })], { how: 'click', picture: PICTURE }));
    h.put.shown('pc', looked([thing('thing', { role: 'Document', name: 'Browser', over: true })]));
    h.put.shown('pc', looked([thing('thing', { role: 'Document', name: 'Browser', over: true })], { picture: new Uint8Array(NOTCH_READ_MAX_BYTES + 1) }));
    expect(r.asked).toEqual([]);
    expect(h.holds).toEqual([]);
  });

  test('what a program reads itself is still taken from the program, exactly', () => {
    const r = reader();
    const h = harness({ read: r.read });
    h.put.shown('pc', looked(ROWS, { picture: PICTURE }));
    expect(r.asked).toEqual([]);
    expect(h.put.held()).toMatchObject({ what: '3 rows' });
  });

  test('something shown meanwhile is what is held: the reading that comes late is dropped', async () => {
    const r = reader();
    const h = harness({ read: r.read });
    h.put.shown('pc', PAGE);
    h.put.shown('pc', looked(ROWS));
    await r.answer(READ);
    expect(h.put.held()).toMatchObject({ what: '3 rows' });
    expect(h.holds.at(-1)).toEqual({ what: '3 rows', ms: NOTCH_HOLD_MS });
  });

  test('"put it here as a table" said while it is being read puts it at the caret once it is read', async () => {
    const r = reader();
    const h = harness({ read: r.read });
    h.put.shown('pc', PAGE);
    expect(await h.speak('Put it here as a list')).toBe('Put what you showed me where you pointed.');
    expect(h.sent).toEqual([]);
    await r.answer(READ);
    expect(h.sent[0]).toEqual({ do: 'paste', front: true, as: 'list', hand: 0, rows: READ });
    expect(h.said()).toBe('There. It is in Notepad.');
  });
});
