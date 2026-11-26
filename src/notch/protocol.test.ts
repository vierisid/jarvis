import { describe, expect, test } from 'bun:test';
import {
  NOTCH_FOLD_CHOICES_MS, NOTCH_FOLD_MS, NOTCH_GATE_MS, NOTCH_PROTOCOL_VERSION, notchAfter, notchRuled, notchRules, parseNotchFromPage, parseNotchToPage,
  readNotchToPage,
} from './protocol.ts';
import type { NotchBlock, NotchFromPage, NotchLine, NotchToPage } from './protocol.ts';

const word = { name: 'when', value: 'Tuesday', options: ['Tuesday', 'Friday'], label: 'Day', read: 'day', syn: { Friday: ['end of the week'] }, free: true, long: false } as const;

/** Every kind of block, with everything a block can carry. */
const blocks: NotchBlock[] = [
  { kind: 'row', id: 'r1', lead: 'Marco', say: ['asks for ', { em: 'the deck' }], tail: 'now', small: '2 min', buttons: [{ id: 'b', label: 'Open', key: 1 }, { id: 'q', label: 'later', quiet: true }], go: true, gone: false, beads: ['ok', 'ask', 'bad'] },
  { kind: 'paper', to: ['To ', { em: 'Marco' }], lines: [['Hi ', { word: { ...word, options: [...word.options], syn: { Friday: ['end of the week'] } } }], ['Bye']], numbered: true, file: { name: 'deck.pdf', size: '2 MB' } },
  { kind: 'note', say: ['Press ', { key: 'yes' }, ' to send.'] },
  { kind: 'buttons', buttons: [{ id: 'a', label: 'Approve', key: 1 }] },
  { kind: 'file', icon: 'doc', name: 'notes.txt', meta: '4 KB' },
  { kind: 'map', nodes: [{ id: 'me', label: 'You', x: 222, y: 102, kind: 'me' }, { id: 'mail', label: 'Mail', x: 40, y: 30, kind: 'tool' }], links: [['me', 'mail']], sources: [{ name: 'Mail', found: '12 threads', state: 'done' }, { name: 'Calendar' }], tour: ['me', 'mail'] },
];

/** Every kind of line, with everything a line can carry, as something that shows a line gives it: without its rules. */
const lines: NotchLine[] = [
  { id: 'say-1', kind: 'say', say: ['Sent to ', { em: 'Marco' }, '.'], ms: 2400, left: 900, mood: 'happy', mark: 'check', who: 'Scout', src: 'mail', arrive: 'left', unasked: true, step: 'step 3/11' },
  { id: 'offer-1', kind: 'offer', say: ['Reply to ', { em: 'Marco' }, '?'], yes: 'show', fold: 0, keys: 'talk' },
  { id: 'offer-2', kind: 'offer', say: ['Which one?'], options: ['This', 'That'], fold: 14000 },
  { id: 'offer-3', kind: 'offer', say: ['Try Esc.'], keys: 'esc' },
  { id: 'sheet-1', kind: 'sheet', say: ['A draft'], blocks, yes: 'send', stay: true, no: 'back', whole: true },
  { id: 'ask-1', kind: 'ask', say: [], placeholder: 'Tell me', yes: 'ask', blocks: [], focus: true, stay: true },
  { id: 'work-1', kind: 'work', say: ['Pasting'], steps: 9, done: 2, canTalk: true },
  { id: 'work-2', kind: 'work', say: ['Putting it in the thread'], steps: 0, done: 0, asks: true },
  { id: 'send-1', kind: 'send', say: ['Sending'], ms: 4000, left: 0 },
  // A letter under its fuse: what goes out is on the notch while it burns.
  { id: 'send-2', kind: 'send', say: ['Offering ', { em: 'Tuesday at 10:00' }, ' to Leo'], ms: 8000, left: 5000, blocks: [{ kind: 'paper', to: ['To ', { em: 'Leo' }], lines: [['Hi Leo,'], [{ em: 'Tuesday at 10:00' }, ' would suit me.']] }] },
  { id: 'listen-1', kind: 'listen', say: [], heard: 'send the deck', over: true },
];

const icon = 'data:image/png;base64,iVBORw0KGgo=';
/** Rules that are in order, for a line whose something else is the thing being tried. */
const RULES = { after: { no: 'rest' }, away: 'none', asking: false, gate: { dead: 350, esc: 0 }, fold: 9000 } as const;
/** A line told to the page, in order but for what `line` itself says. */
const shown = (line: unknown): unknown => ({ type: 'patch', seq: 1, line: line && typeof line === 'object' && !Array.isArray(line) ? { ...RULES, ...line } : line });
/** As it travels: as text. */
const sent = <T>(message: T): unknown => JSON.parse(JSON.stringify(message));

describe('a message from the brain, read by the page', () => {
  test('everything a message can carry is read as it was sent', () => {
    const messages: NotchToPage[] = [
      ...lines.map((line): NotchToPage => ({ type: 'patch', seq: 4, line: notchRuled(line) })),
      ...lines.map((line): NotchToPage => ({ type: 'state', v: NOTCH_PROTOCOL_VERSION, brain: 'b1', seq: 9, line: notchRuled(line), count: 2 })),
      { type: 'state', v: NOTCH_PROTOCOL_VERSION, brain: 'b1', seq: 0, line: null, count: 0 },
      { type: 'state', v: NOTCH_PROTOCOL_VERSION, brain: 'a-B_9', seq: 1, line: null, count: 3, born: 'gather', face: 'closed', where: { name: 'Mail', icon }, eye: true, sound: true, park: 2, mouth: 'over' },
      { type: 'state', v: NOTCH_PROTOCOL_VERSION, brain: 'b1', seq: 2, line: null, count: 0, where: null },
      { type: 'patch', seq: 1 },
      { type: 'patch', seq: 2, line: null },
      { type: 'patch', seq: 3, count: 4 },
      { type: 'patch', seq: 4, face: 'away' },
      { type: 'patch', seq: 5, where: { name: 'Notes' } },
      { type: 'patch', seq: 6, where: null },
      { type: 'patch', seq: 7, eye: false, sound: false, park: 0, mouth: 'shut' },
      { type: 'patch', seq: 8, edit: { id: 'work-1' } },
      { type: 'patch', seq: 9, edit: { id: 'work-1', done: 3, say: ['Pasting, ', { em: 'without fees' }], heard: 'so far', over: true, blocks, away: 'none' } },
      { type: 'patch', seq: Number.MAX_SAFE_INTEGER, line: null, count: 1, face: 'idle', where: null, eye: true, sound: true, park: 3, mouth: 'open', edit: { id: 'x', done: 1 } },
      { type: 'effect', seq: 1 },
      { type: 'effect', seq: 2, mood: 'proud', gesture: 'gecko', lip: 'reach', birth: 'bead', aim: 0.3, body: 'hops', kick: -120, edge: 'carry', side: 'right', gulp: true },
      { type: 'ack', n: 1, took: true },
      { type: 'ack', n: 77, took: false },
      { type: 'refuse', v: 2 },
      { type: 'refuse', v: 9 },
    ];
    for (const message of messages) expect(parseNotchToPage(sent(message))).toEqual(message);
  });

  test('what comes back is a new object: the one that was given is not kept', () => {
    const given: NotchToPage = { type: 'patch', seq: 1, line: notchRuled({ id: 'a', kind: 'sheet', say: ['A'], blocks: [{ kind: 'note', say: ['n'] }] }) };
    const read = parseNotchToPage(given) as typeof given;
    expect(read).toEqual(given);
    expect(read).not.toBe(given);
    expect(read.line).not.toBe(given.line);
    expect(read.line!.after).not.toBe(given.line!.after);
    expect(read.line!.gate).not.toBe(given.line!.gate);
  });

  test('a field that is there with nothing in it was left out', () => {
    const line = { ...RULES, id: 'a', kind: 'offer', say: ['Reply?'], yes: 'send', options: undefined, mood: undefined, unasked: undefined, keys: null };
    expect(parseNotchToPage({ type: 'patch', seq: 1, line })).toEqual({ type: 'patch', seq: 1, line: { ...RULES, id: 'a', kind: 'offer', say: ['Reply?'], yes: 'send' } });
    // But for the line of a patch: there, nothing is "back to the eyes", and left out is "the line stays".
    expect(parseNotchToPage({ type: 'patch', seq: 1, line: null })).toEqual({ type: 'patch', seq: 1, line: null });
    expect(parseNotchToPage({ type: 'patch', seq: 1, line: undefined, count: null, edit: null })).toEqual({ type: 'patch', seq: 1 });
  });

  test('what a message does not have is not carried along', () => {
    const read = parseNotchToPage({ type: 'patch', seq: 1, extra: 1, line: { ...RULES, id: 'a', kind: 'say', say: ['Hi'], ms: 10, onclick: 'x', blocks: 'no', gate: { dead: 350, esc: 0, more: 1 }, after: { no: 'rest', dance: 'rest' } } });
    const { fold: _fold, ...rules } = RULES;
    expect(read).toEqual({ type: 'patch', seq: 1, line: { ...rules, id: 'a', kind: 'say', say: ['Hi'], ms: 10 } });
  });

  test('each kind of line, with rules that are in order, is a message: what is tried below is what is wrong with it', () => {
    for (const line of lines) expect(parseNotchToPage(shown(line))).not.toBeNull();
    expect(parseNotchToPage(shown({ id: 'a', kind: 'say', say: ['Approve?'], ms: 100 }))).not.toBeNull();
  });

  test('anything that is not exactly a message is nothing', () => {
    const say = ['Approve?'];
    const state = { type: 'state', v: NOTCH_PROTOCOL_VERSION, brain: 'b1', seq: 1, line: null, count: 0 };
    const hostile: unknown[] = [
      null, undefined, 42, 'patch', [], {}, { type: 'nothing' }, { type: 7 }, [{ type: 'patch', seq: 1 }],
      // A line that is not one.
      shown('x'), shown([]), shown({}), shown(7),
      shown({ kind: 'say', say, ms: 100 }),
      shown({ id: '', kind: 'say', say, ms: 100 }),
      shown({ id: 7, kind: 'say', say, ms: 100 }),
      shown({ id: 'x'.repeat(201), kind: 'say', say, ms: 100 }),
      shown({ id: 'a', say }),
      shown({ id: 'a', kind: 'banner', say }),
      shown({ id: 'a', kind: 'say', ms: 100 }),
      shown({ id: 'a', kind: 'say', say: 'Sent.', ms: 100 }),
      shown({ id: 'a', kind: 'say', say }),
      shown({ id: 'a', kind: 'say', say, ms: '100' }),
      shown({ id: 'a', kind: 'say', say, ms: null }),
      shown({ id: 'a', kind: 'say', say, ms: 100, left: 'some' }),
      shown({ id: 'a', kind: 'send', say }),
      shown({ id: 'a', kind: 'send', say, ms: 100, left: {} }),
      // A letter under a fuse that cannot be read whole is no fuse at all: the page must not burn it over nothing.
      shown({ id: 'a', kind: 'send', say, ms: 100, blocks: 'a letter' }),
      shown({ id: 'a', kind: 'send', say, ms: 100, blocks: [{ kind: 'scroll', lines: [] }] }),
      shown({ id: 'a', kind: 'send', say, ms: 100, blocks: [{ kind: 'paper', lines: 'Hi' }] }),
      // A part of a sentence that is not one.
      shown({ id: 'a', kind: 'say', say: [7], ms: 100 }),
      shown({ id: 'a', kind: 'say', say: [null], ms: 100 }),
      shown({ id: 'a', kind: 'say', say: [{}], ms: 100 }),
      shown({ id: 'a', kind: 'say', say: [{ nope: 1 }], ms: 100 }),
      shown({ id: 'a', kind: 'say', say: [{ em: 7 }], ms: 100 }),
      shown({ id: 'a', kind: 'say', say: [{ key: 'f13' }], ms: 100 }),
      shown({ id: 'a', kind: 'say', say: [{ word: 'Tuesday' }], ms: 100 }),
      shown({ id: 'a', kind: 'say', say: [{ word: { name: 'w', value: 'a' } }], ms: 100 }),
      shown({ id: 'a', kind: 'say', say: [{ word: { name: 'w', value: 'a', options: [1] } }], ms: 100 }),
      shown({ id: 'a', kind: 'say', say: [{ word: { name: 'w', value: 'a', options: [], read: 'mind' } }], ms: 100 }),
      shown({ id: 'a', kind: 'say', say: [{ word: { name: 'w', value: 'a', options: [], syn: { a: 'b' } } }], ms: 100 }),
      shown({ id: 'a', kind: 'say', say: [{ word: { name: 'w', value: 'a', options: [], free: 'yes' } }], ms: 100 }),
      // What must not be guessed at.
      shown({ id: 'a', kind: 'offer', say, unasked: 'yes' }),
      shown({ id: 'a', kind: 'offer', say, yes: 1 }),
      shown({ id: 'a', kind: 'offer', say, options: 'this or that' }),
      shown({ id: 'a', kind: 'offer', say, options: [1, 2] }),
      shown({ id: 'a', kind: 'offer', say, fold: 'never' }),
      shown({ id: 'a', kind: 'offer', say, keys: 'enter' }),
      // A sheet and what it is made of.
      shown({ id: 'a', kind: 'sheet', say }),
      shown({ id: 'a', kind: 'sheet', say, blocks: {} }),
      shown({ id: 'a', kind: 'sheet', say, blocks: [null] }),
      shown({ id: 'a', kind: 'sheet', say, blocks: [{ kind: 'unknown' }] }),
      shown({ id: 'a', kind: 'sheet', say, blocks: [{ kind: 'paper' }] }),
      shown({ id: 'a', kind: 'sheet', say, blocks: [{ kind: 'paper', lines: ['a line'] }] }),
      shown({ id: 'a', kind: 'sheet', say, blocks: [{ kind: 'paper', lines: [], file: { name: 'a' } }] }),
      shown({ id: 'a', kind: 'sheet', say, blocks: [{ kind: 'row' }] }),
      shown({ id: 'a', kind: 'sheet', say, blocks: [{ kind: 'row', say, buttons: [{ id: 'b' }] }] }),
      shown({ id: 'a', kind: 'sheet', say, blocks: [{ kind: 'row', say, buttons: [{ id: 'b', label: 'B', key: '1' }] }] }),
      shown({ id: 'a', kind: 'sheet', say, blocks: [{ kind: 'row', say, go: 1 }] }),
      shown({ id: 'a', kind: 'sheet', say, blocks: [{ kind: 'note' }] }),
      shown({ id: 'a', kind: 'sheet', say, blocks: [{ kind: 'buttons' }] }),
      shown({ id: 'a', kind: 'sheet', say, blocks: [{ kind: 'file', icon: 'exe', name: 'a', meta: 'b' }] }),
      shown({ id: 'a', kind: 'sheet', say, blocks: [{ kind: 'file', icon: 'doc', name: 'a' }] }),
      shown({ id: 'a', kind: 'sheet', say, blocks: [], stay: 'yes' }),
      shown({ id: 'a', kind: 'sheet', say, blocks: [], whole: 1 }),
      shown({ id: 'a', kind: 'ask', say, yes: 'ask', blocks: [] }),
      shown({ id: 'a', kind: 'ask', say, placeholder: 'p', blocks: [] }),
      shown({ id: 'a', kind: 'ask', say, placeholder: 'p', yes: 'ask' }),
      shown({ id: 'a', kind: 'work', say, steps: 3 }),
      shown({ id: 'a', kind: 'work', say, steps: '3', done: 0 }),
      shown({ id: 'a', kind: 'listen', say }),
      // Its rules: a page has none of its own, so it cannot make up for one that is missing or wrong.
      { type: 'patch', seq: 1, line: { id: 'a', kind: 'say', say, ms: 100 } },
      shown({ id: 'a', kind: 'say', say, ms: 100, after: undefined }),
      shown({ id: 'a', kind: 'say', say, ms: 100, after: 'rest' }),
      shown({ id: 'a', kind: 'say', say, ms: 100, after: [] }),
      shown({ id: 'a', kind: 'say', say, ms: 100, after: { yes: 'vanish' } }),
      shown({ id: 'a', kind: 'say', say, ms: 100, after: { yes: true } }),
      shown({ id: 'a', kind: 'say', say, ms: 100, away: undefined }),
      shown({ id: 'a', kind: 'say', say, ms: 100, away: 'yes' }),
      shown({ id: 'a', kind: 'say', say, ms: 100, asking: undefined }),
      shown({ id: 'a', kind: 'say', say, ms: 100, asking: 'yes' }),
      shown({ id: 'a', kind: 'say', say, ms: 100, gate: undefined }),
      shown({ id: 'a', kind: 'say', say, ms: 100, gate: 350 }),
      shown({ id: 'a', kind: 'say', say, ms: 100, gate: { dead: 350 } }),
      shown({ id: 'a', kind: 'say', say, ms: 100, gate: { esc: 0 } }),
      shown({ id: 'a', kind: 'say', say, ms: 100, gate: { dead: -1, esc: 0 } }),
      shown({ id: 'a', kind: 'say', say, ms: 100, gate: { dead: '350', esc: 0 } }),
      shown({ id: 'a', kind: 'say', say, ms: 100, gate: { dead: 350, esc: 0, whole: 'all' } }),
      // An offer always says when it folds: the page no longer has a time of its own to fall back on.
      shown({ id: 'a', kind: 'offer', say, fold: undefined }),
      shown({ id: 'a', kind: 'offer', say, fold: -1 }),
      // The other messages.
      { ...state, line: { id: 'a', kind: 'sheet', say } },
      { ...state, count: undefined },
      { ...state, count: 'two' },
      { ...state, eye: 'open' },
      { ...state, seq: undefined }, { ...state, seq: -1 }, { ...state, seq: 1.5 }, { ...state, seq: '1' }, { ...state, seq: 2 ** 60 },
      { ...state, brain: undefined }, { ...state, brain: '' }, { ...state, brain: 7 }, { ...state, brain: 'a b' }, { ...state, brain: 'x'.repeat(65) },
      { ...state, v: 'two' }, { ...state, v: 0 }, { ...state, v: 2.5 },
      { type: 'patch' }, { type: 'patch', seq: '3' }, { type: 'patch', seq: -1 }, { type: 'patch', seq: 1.5 }, { type: 'patch', seq: null },
      { type: 'patch', seq: 1, count: '3' },
      { type: 'patch', seq: 1, eye: 'open' }, { type: 'patch', seq: 1, sound: 1 },
      { type: 'patch', seq: 1, edit: 'x' }, { type: 'patch', seq: 1, edit: {} }, { type: 'patch', seq: 1, edit: { id: 7 } }, { type: 'patch', seq: 1, edit: { id: '' } },
      { type: 'patch', seq: 1, edit: { id: 'x'.repeat(201) } },
      { type: 'patch', seq: 1, edit: { id: 'a', done: 'all' } },
      { type: 'patch', seq: 1, edit: { id: 'a', say: 'new words' } },
      { type: 'patch', seq: 1, edit: { id: 'a', blocks: [{ kind: 'paper' }] } },
      { type: 'patch', seq: 1, edit: { id: 'a', over: 'yes' } },
      { type: 'patch', seq: 1, edit: { id: 'a', away: 'maybe' } },
      { type: 'effect' }, { type: 'effect', seq: 'next' }, { type: 'effect', seq: -4, gesture: 'wink' },
      { type: 'ack' }, { type: 'ack', n: 1 }, { type: 'ack', took: true }, { type: 'ack', n: 0, took: true }, { type: 'ack', n: 1.5, took: true },
      { type: 'ack', n: '1', took: true }, { type: 'ack', n: 1, took: 'yes' }, { type: 'ack', n: 1, took: 1 },
      { type: 'refuse' }, { type: 'refuse', v: 'two' }, { type: 'refuse', v: 0 },
    ];
    for (const message of hostile) {
      expect([JSON.stringify(message), parseNotchToPage(message)]).toEqual([JSON.stringify(message), null]);
    }
  });

  test('what only dresses a line is left out when it is not known, and the line is still said', () => {
    const { fold: _fold, ...rules } = RULES;
    const read = parseNotchToPage(shown({ id: 'a', kind: 'say', say: ['Here.'], ms: 4000, mood: 'furious', mark: 'star', who: 7, src: 'fax', arrive: 'teleport', step: 3 }));
    expect(read).toEqual({ type: 'patch', seq: 1, line: { ...rules, id: 'a', kind: 'say', say: ['Here.'], ms: 4000 } });
    expect(parseNotchToPage({ type: 'state', v: NOTCH_PROTOCOL_VERSION, brain: 'b', seq: 1, line: null, count: 1, born: 'hatch', face: 'furious', where: 'here', mouth: 'wide', park: 'two' }))
      .toEqual({ type: 'state', v: NOTCH_PROTOCOL_VERSION, brain: 'b', seq: 1, line: null, count: 1, where: null });
    // And of what the notch is: a face it cannot make and a mouth it does not have change nothing, and the rest of the patch stands.
    expect(parseNotchToPage({ type: 'patch', seq: 1, face: 'furious', mouth: 'gulp', park: 2.9, count: 2 })).toEqual({ type: 'patch', seq: 1, park: 2, count: 2 });
    expect(parseNotchToPage({ type: 'patch', seq: 1, park: -3 })).toEqual({ type: 'patch', seq: 1, park: 0 });
  });

  test('a movement that is not known is left out, and the others are made', () => {
    expect(parseNotchToPage({ type: 'effect', seq: 1, body: 'dance', kick: null, lip: 'reach', aim: 'left', edge: 'fly', side: 'up', gesture: 'wink', mood: 'x', birth: 'y', gulp: 'yes' }))
      .toEqual({ type: 'effect', seq: 1, lip: 'reach', gesture: 'wink' });
  });

  test('what the notch is cannot travel as a movement: an effect carries none of it', () => {
    expect(parseNotchToPage({ type: 'effect', seq: 1, gesture: 'wink', eye: true, sound: true, park: 2, mouth: 'open', count: 3, face: 'closed', line: null }))
      .toEqual({ type: 'effect', seq: 1, gesture: 'wink' });
  });

  test('the map takes what it can of what it is given', () => {
    const read = parseNotchToPage(shown({
      id: 'm', kind: 'sheet', say: ['Looking around'], blocks: [{
        kind: 'map', nodes: [{ id: 'a', label: 'A', x: 9e9, y: 'low', kind: 'spaceship' }, null, { id: 7 }, { id: 'b', label: 'B', x: 10, y: 20, kind: 'tool' }],
        links: 'none', sources: [null, { name: 4 }, { name: 'Mail', found: 3, state: 'busy' }], tour: ['a', 9],
      }],
    })) as Extract<NotchToPage, { type: 'patch' }>;
    expect((read.line as Extract<NotchLine, { kind: 'sheet' }>).blocks).toEqual([{
      kind: 'map', nodes: [{ id: 'a', label: 'A', x: 444, y: 0, kind: 'thing' }, { id: 'b', label: 'B', x: 10, y: 20, kind: 'tool' }],
      links: [], sources: [{ name: 'Mail' }], tour: ['a'],
    }]);
  });

  test('an icon is only ever a small PNG, here too', () => {
    expect(parseNotchToPage({ type: 'patch', seq: 1, where: { name: '  Mail  ', icon: 'javascript:alert(1)' } })).toEqual({ type: 'patch', seq: 1, where: { name: 'Mail' } });
    expect(parseNotchToPage({ type: 'patch', seq: 1, where: { icon } })).toEqual({ type: 'patch', seq: 1, where: null });
    expect(parseNotchToPage({ type: 'patch', seq: 1, where: null })).toEqual({ type: 'patch', seq: 1, where: null });
    expect(parseNotchToPage({ type: 'patch', seq: 1 })).toEqual({ type: 'patch', seq: 1 });
  });

  test('a message of a kind the page has never heard of is told apart from one that is wrong', () => {
    // What a newer brain may say: well formed, and unknown here. So is everything version 1 said but its state.
    for (const message of [{ type: 'sparkle' }, { type: 'show', line: lines[0] }, { type: 'rest' }, { type: 'count', count: 2 }, { type: 'face', mood: 'away' },
      { type: 'where', app: null }, { type: 'update', id: 'a' }, { type: 'act', gesture: 'wink' }]) {
      expect(readNotchToPage(message)).toEqual({ message: null, why: 'unknown' });
      expect(parseNotchToPage(message)).toBeNull();
    }
    // One that was numbered says its number: it is counted as read, so that the next is not a gap.
    expect(readNotchToPage({ type: 'sparkle', seq: 12, much: true })).toEqual({ message: null, why: 'unknown', seq: 12 });
    expect(readNotchToPage({ type: 'sparkle', seq: -1 })).toEqual({ message: null, why: 'unknown' });
    // It says it is something the page knows, and is not; or it is not a message at all.
    for (const message of [null, 42, [], {}, { type: 7 }, { type: 'patch' }, { type: 'effect' }, { type: 'ack', n: 1 }]) {
      expect(readNotchToPage(message)).toEqual({ message: null, why: 'malformed' });
    }
    // Wrong as it is, one that was numbered says its number too: it was the next in the row.
    expect(readNotchToPage({ type: 'patch', seq: 1, count: 'x' })).toEqual({ message: null, why: 'malformed', seq: 1 });
    expect(readNotchToPage(shown({ id: 'a', kind: 'banner', say: [] }))).toMatchObject({ message: null, why: 'malformed' });
    expect(readNotchToPage({ type: 'patch', seq: 1, line: null })).toEqual({ message: { type: 'patch', seq: 1, line: null } });
  });

  test('a state from a brain of another version is not read at all, and says which version it was', () => {
    // Version 1 said no version: its state is known by that.
    expect(readNotchToPage({ type: 'state', line: null, count: 0 })).toEqual({ message: null, why: 'version', v: 1 });
    expect(readNotchToPage({ type: 'state', v: 1, line: null, count: 0 })).toEqual({ message: null, why: 'version', v: 1 });
    // A newer one, whatever else it says, and however little of it this page could read.
    expect(readNotchToPage({ type: 'state', v: 3, brain: 'b', seq: 1, line: { something: 'new' }, count: 'many' })).toEqual({ message: null, why: 'version', v: 3 });
    expect(parseNotchToPage({ type: 'state', v: 3, brain: 'b', seq: 1, line: null, count: 0 })).toBeNull();
    // A version that is no number is not a version: that is a message that is wrong.
    expect(readNotchToPage({ type: 'state', v: 'two', brain: 'b', seq: 1, line: null, count: 0 })).toEqual({ message: null, why: 'malformed', seq: 1 });
  });

  test('a state whose line cannot be read keeps the rest of what it says, and says the line was lost', () => {
    const state = { type: 'state', v: NOTCH_PROTOCOL_VERSION, brain: 'b1', seq: 5 };
    const read = readNotchToPage({ ...state, count: 3, face: 'closed', eye: true, park: 1, line: { ...RULES, id: 'a', kind: 'sheet', say: ['Approve?'] } });
    expect(read).toEqual({ message: { ...state, line: null, count: 3, face: 'closed', eye: true, park: 1 }, lineLost: true } as never);
    // So does one whose line is in order but for its rules.
    expect(readNotchToPage({ ...state, count: 3, line: { id: 'a', kind: 'say', say: ['Hi'], ms: 100 } })).toEqual({ message: { ...state, line: null, count: 3 }, lineLost: true } as never);
    // Whole, it is not a message.
    expect(parseNotchToPage({ ...state, count: 3, line: { ...RULES, id: 'a', kind: 'sheet', say: ['Approve?'] } })).toBeNull();
    // What is wrong outside the line is wrong for all of it.
    expect(readNotchToPage({ ...state, count: 'three', line: null })).toEqual({ message: null, why: 'malformed', seq: 5 });
    // A patch has no such mercy: one whose line cannot be read is dropped whole, with whatever else it said.
    expect(readNotchToPage({ type: 'patch', seq: 1, count: 3, line: { ...RULES, id: 'a', kind: 'sheet', say: ['Approve?'] } })).toEqual({ message: null, why: 'malformed', seq: 1 });
  });
});

describe('a message from the page, read by the brain', () => {
  test('everything a message can carry is read as it was sent', () => {
    const messages: NotchFromPage[] = [
      { type: 'hello', v: 2 }, { type: 'hello', v: 2, page: 'a1B2_c-3' }, { type: 'hello', v: 1 }, { type: 'hello', v: 7, page: 'x'.repeat(64) },
      { type: 'answer', id: 'l1', act: 'yes' },
      { type: 'answer', n: 1, id: 'l1', act: 'yes', since: 0 },
      { type: 'answer', n: Number.MAX_SAFE_INTEGER, id: 'x'.repeat(200), act: 'pick', option: 'Friday', index: 1, since: 86_400_000 },
      { type: 'answer', n: 3, id: 's', act: 'button', button: 'b', row: 'r' },
      { type: 'answer', n: 4, id: 's', act: 'go', row: 'r' },
      { type: 'answer', n: 5, id: 's', act: 'word', word: 'tone', value: 'firmly' },
      { type: 'answer', n: 6, id: 'a', act: 'ask', text: 'x'.repeat(4000) },
      { type: 'answer', n: 7, id: 'f', act: 'done', seen: true },
      { type: 'answer', n: 8, id: 'f', act: 'undo' }, { type: 'answer', n: 9, id: 'w', act: 'stop' }, { type: 'answer', n: 10, id: 'o', act: 'no' },
      { type: 'answer', n: 11, id: 'o', act: 'fold' }, { type: 'answer', n: 12, id: 'r', act: 'done' },
      { type: 'answer', n: 13, id: 'o', act: 'yes', since: 400, brain: 'b1_x-2' },
      { type: 'hand', id: 'l1', on: true }, { type: 'hand', id: 'l1', on: false },
      { type: 'at', seq: 0 }, { type: 'at', seq: 41 },
      { type: 'open' }, { type: 'stop' }, { type: 'signed-out' },
      { type: 'drag', state: 'over' }, { type: 'drag', state: 'left' }, { type: 'drag', state: 'lost' },
    ];
    for (const message of messages) expect(parseNotchFromPage(sent(message))).toEqual(message);
  });

  test('what a message does not have is not carried along, and only the word itself says a letter was seen', () => {
    expect(parseNotchFromPage({ type: 'answer', n: 2, id: 'l1', act: 'yes', key: 'pc\npage\n2', extra: 1, seen: 'yes' })).toEqual({ type: 'answer', n: 2, id: 'l1', act: 'yes' });
    expect(parseNotchFromPage({ type: 'answer', id: 'l1', act: 'done', seen: 1 })).toEqual({ type: 'answer', id: 'l1', act: 'done' });
    expect(parseNotchFromPage({ type: 'hello', v: 2, page: 'p', token: 'x' })).toEqual({ type: 'hello', v: 2, page: 'p' });
    expect(parseNotchFromPage({ type: 'at', seq: 3, line: 'l1' })).toEqual({ type: 'at', seq: 3 });
    expect(parseNotchFromPage({ type: 'hand', id: 'l1', on: true, x: 4 })).toEqual({ type: 'hand', id: 'l1', on: true });
  });

  test('anything that is not exactly a message is nothing', () => {
    const hostile: unknown[] = [
      null, undefined, 7, 'open', [], {}, { type: 'shutdown' }, [{ type: 'open' }],
      { type: 'hello' }, { type: 'hello', v: 0 }, { type: 'hello', v: -2 }, { type: 'hello', v: 2.5 }, { type: 'hello', v: '2' },
      { type: 'hello', v: 2, page: '' }, { type: 'hello', v: 2, page: 7 }, { type: 'hello', v: 2, page: 'a b' }, { type: 'hello', v: 2, page: 'a\nb' },
      { type: 'hello', v: 2, page: 'x'.repeat(65) }, { type: 'hello', v: 2, page: null },
      { type: 'answer' }, { type: 'answer', id: 'l1' }, { type: 'answer', act: 'yes' }, { type: 'answer', id: '', act: 'yes' },
      { type: 'answer', id: 'x'.repeat(201), act: 'yes' }, { type: 'answer', id: 'l1', act: 'approve' }, { type: 'answer', id: 7, act: 'yes' },
      { type: 'answer', id: 'l1', act: 'yes', n: 0 }, { type: 'answer', id: 'l1', act: 'yes', n: -1 }, { type: 'answer', id: 'l1', act: 'yes', n: 1.5 },
      { type: 'answer', id: 'l1', act: 'yes', n: '1' }, { type: 'answer', id: 'l1', act: 'yes', n: null }, { type: 'answer', id: 'l1', act: 'yes', n: 2 ** 60 },
      { type: 'answer', id: 'l1', act: 'yes', n: Number.NaN }, { type: 'answer', id: 'l1', act: 'yes', n: Number.POSITIVE_INFINITY },
      { type: 'answer', id: 'l1', act: 'yes', brain: '' }, { type: 'answer', id: 'l1', act: 'yes', brain: 'a b' }, { type: 'answer', id: 'l1', act: 'yes', brain: 7 },
      { type: 'answer', id: 'l1', act: 'yes', brain: 'x'.repeat(65) },
      { type: 'answer', id: 'l1', act: 'yes', since: -1 }, { type: 'answer', id: 'l1', act: 'yes', since: 0.5 }, { type: 'answer', id: 'l1', act: 'yes', since: 'soon' },
      { type: 'answer', id: 'l1', act: 'pick', index: -1 }, { type: 'answer', id: 'l1', act: 'pick', index: 100 }, { type: 'answer', id: 'l1', act: 'pick', index: 1.5 },
      { type: 'answer', id: 'l1', act: 'word', value: 7 }, { type: 'answer', id: 'l1', act: 'word', word: 'x'.repeat(501) },
      { type: 'answer', id: 'l1', act: 'ask', text: 'x'.repeat(4001) }, { type: 'answer', id: 'l1', act: 'ask', text: 7 },
      { type: 'hand' }, { type: 'hand', id: 'l1' }, { type: 'hand', on: true }, { type: 'hand', id: '', on: true }, { type: 'hand', id: 'l1', on: 1 },
      { type: 'hand', id: 'x'.repeat(201), on: true }, { type: 'hand', id: 7, on: true },
      { type: 'at' }, { type: 'at', seq: -1 }, { type: 'at', seq: 1.5 }, { type: 'at', seq: '4' }, { type: 'at', seq: null }, { type: 'at', seq: 2 ** 60 },
      { type: 'drag' }, { type: 'drag', state: 'dropped' },
    ];
    for (const message of hostile) {
      expect([JSON.stringify(message), parseNotchFromPage(message)]).toEqual([JSON.stringify(message), null]);
    }
  });
});

describe('the rules of a line, which the brain writes into it', () => {
  const by = (id: string): NotchLine => lines.find((line) => line.id === id)!;
  const GONE = { no: 'rest', fold: 'rest' } as const;

  test('what an answer does to each kind of line', () => {
    const afters = Object.fromEntries(lines.map((line) => [line.id, notchRules(line).after]));
    expect(afters).toEqual({
      // A no and a fold end any line, as they always did on the brain's side.
      'say-1': { ...GONE, yes: 'rest', done: 'rest' },
      'offer-1': { ...GONE, yes: 'hold' },
      'offer-2': { ...GONE, pick: 'hold' },
      // Only Esc is shown: a yes is told, and the line stays as it is.
      'offer-3': { ...GONE },
      'sheet-1': { ...GONE, yes: 'hold' },
      'ask-1': { ...GONE, ask: 'hold' },
      'work-1': { ...GONE, stop: 'hold' },
      'work-2': { ...GONE, stop: 'hold' },
      'send-1': { ...GONE, undo: 'hold', done: 'hold' },
      'send-2': { ...GONE, undo: 'hold', done: 'hold' },
      'listen-1': { ...GONE },
    });
    // A sheet with no yes has none to hold; a button, a row and a word never end a line.
    expect(notchRules({ id: 's', kind: 'sheet', say: [], blocks: [] }).after).toEqual(GONE);
    for (const line of lines) for (const act of ['button', 'go', 'word'] as const) expect(notchAfter(line, act)).toBeUndefined();
    expect(notchAfter(by('offer-3'), 'yes')).toBeUndefined();
    expect(notchAfter(by('send-1'), 'done')).toBe('hold');
    expect(notchAfter(by('say-1'), 'done')).toBe('rest');
  });

  test('what a press somewhere else is', () => {
    const away = (line: NotchLine): string => notchRules(line).away;
    // A sheet that only shows something, and a field: a no.
    expect(away({ id: 's', kind: 'sheet', say: [], blocks: [] })).toBe('no');
    expect(away({ id: 'a', kind: 'ask', say: [], placeholder: 'p', yes: 'ask', blocks: [{ kind: 'note', say: ['n'] }] })).toBe('no');
    // A sheet that asks for a decision, a field that stays, a question about a file that was dropped: nothing.
    expect(away({ id: 's', kind: 'sheet', say: [], blocks: [], yes: 'send' })).toBe('none');
    expect(away({ id: 's', kind: 'sheet', say: [], blocks: [], stay: true })).toBe('none');
    expect(away(by('ask-1'))).toBe('none');
    expect(away({ id: 'a', kind: 'ask', say: [], placeholder: 'p', yes: 'ask', blocks: [{ kind: 'file', icon: 'doc', name: 'a', meta: 'b' }] })).toBe('none');
    // And everything else, a letter under its fuse among it: only Esc takes that back.
    for (const id of ['say-1', 'offer-1', 'offer-2', 'offer-3', 'work-1', 'send-1', 'send-2', 'listen-1']) expect(away(by(id))).toBe('none');
  });

  test('which lines wait for the person', () => {
    const asking = Object.fromEntries(lines.map((line) => [line.id, notchRules(line).asking]));
    expect(asking).toEqual({
      'say-1': false, 'offer-1': true, 'offer-2': true, 'offer-3': true, 'sheet-1': true, 'ask-1': true,
      // Work only when it leads into a letter, and a send only when it carries one.
      'work-1': false, 'work-2': true, 'send-1': false, 'send-2': true, 'listen-1': false,
    });
    // A sheet that stays only to be read is not a question, and neither is one with a yes that a click away may close.
    expect(notchRules({ id: 's', kind: 'sheet', say: [], blocks: [], stay: true }).asking).toBe(false);
    expect(notchRules({ id: 's', kind: 'sheet', say: [], blocks: [], yes: 'send' }).asking).toBe(false);
  });

  test('for how long a line takes no answer', () => {
    expect(notchRules(by('offer-1')).gate).toEqual({ dead: NOTCH_GATE_MS.dead, esc: 0 });
    // One that came by itself: longer for a yes, and as long for Esc.
    expect(notchRules(by('say-1')).gate).toEqual({ dead: NOTCH_GATE_MS.unasked, esc: NOTCH_GATE_MS.unasked });
    expect(notchRules({ ...by('offer-1'), unasked: false }).gate).toEqual({ dead: NOTCH_GATE_MS.dead, esc: 0 });
    // A sheet that must be seen whole says for how long its end must have been up, and no other line does.
    expect(notchRules(by('sheet-1')).gate).toEqual({ dead: NOTCH_GATE_MS.dead, esc: 0, whole: NOTCH_GATE_MS.whole });
    expect(notchRules({ id: 's', kind: 'sheet', say: [], blocks: [], yes: 'send', whole: false }).gate.whole).toBeUndefined();
    expect([NOTCH_GATE_MS.dead, NOTCH_GATE_MS.unasked, NOTCH_GATE_MS.whole]).toEqual([350, 700, 600]);
  });

  test('when an offer folds, and that nothing else does', () => {
    expect(notchRules({ id: 'o', kind: 'offer', say: [] }).fold).toBe(NOTCH_FOLD_MS);
    expect(notchRules({ id: 'o', kind: 'offer', say: [], options: ['a'] }).fold).toBe(NOTCH_FOLD_CHOICES_MS);
    expect(notchRules({ id: 'o', kind: 'offer', say: [], options: [] }).fold).toBe(NOTCH_FOLD_MS);
    expect(notchRules(by('offer-1')).fold).toBe(0);
    expect(notchRules({ id: 'o', kind: 'offer', say: [], fold: 3000 }).fold).toBe(3000);
    expect(notchRules({ id: 'o', kind: 'offer', say: [], fold: -5 }).fold).toBe(0);
    expect([NOTCH_FOLD_MS, NOTCH_FOLD_CHOICES_MS]).toEqual([9000, 14000]);
    for (const line of lines) if (line.kind !== 'offer') expect('fold' in notchRules(line)).toBe(false);
  });

  test('rules that whoever shows a line wrote into it are written over, and the line given is not written to', () => {
    const given = { id: 'o', kind: 'offer', say: ['Reply?'], after: { yes: 'rest' }, away: 'no', asking: false, gate: { dead: 0, esc: 0 } } as NotchLine;
    const told = notchRuled(given);
    expect(told).toEqual({ id: 'o', kind: 'offer', say: ['Reply?'], after: { yes: 'hold', no: 'rest', fold: 'rest' }, away: 'none', asking: true, gate: { dead: 350, esc: 0 }, fold: 9000 });
    expect(given.after).toEqual({ yes: 'rest' });
    expect('fold' in given).toBe(false);
  });
});

describe('a line the brain holds answered', () => {
  test('says so as `held`, read only as true or false, and is nothing else', () => {
    const line = { ...notchRuled({ id: 'f', kind: 'send', say: ['Sent'], ms: 4000 } as NotchLine), held: true };
    expect(parseNotchToPage({ type: 'patch', seq: 1, line })).toEqual({ type: 'patch', seq: 1, line });
    const { held: _held, ...open } = line;
    expect(parseNotchToPage({ type: 'patch', seq: 1, line: { ...open, held: false } })).toEqual({ type: 'patch', seq: 1, line: open });
    expect(parseNotchToPage({ type: 'patch', seq: 1, line: { ...open, held: 'yes' } })).toBeNull();
  });
});
