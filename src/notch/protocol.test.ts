import { describe, expect, test } from 'bun:test';
import { parseNotchToPage } from './protocol.ts';
import type { NotchBlock, NotchLine, NotchToPage } from './protocol.ts';

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

/** Every kind of line, with everything a line can carry. */
const lines: NotchLine[] = [
  { id: 'say-1', kind: 'say', say: ['Sent to ', { em: 'Marco' }, '.'], ms: 2400, left: 900, mood: 'happy', mark: 'check', who: 'Scout', src: 'mail', arrive: 'left', unasked: true, step: 'step 3/11' },
  { id: 'offer-1', kind: 'offer', say: ['Reply to ', { em: 'Marco' }, '?'], yes: 'show', fold: 0, keys: 'talk' },
  { id: 'offer-2', kind: 'offer', say: ['Which one?'], options: ['This', 'That'], fold: 14000 },
  { id: 'sheet-1', kind: 'sheet', say: ['A draft'], blocks, yes: 'send', stay: true, no: 'back', whole: true },
  { id: 'ask-1', kind: 'ask', say: [], placeholder: 'Tell me', yes: 'ask', blocks: [], focus: true, stay: true },
  { id: 'work-1', kind: 'work', say: ['Pasting'], steps: 9, done: 2, canTalk: true },
  { id: 'send-1', kind: 'send', say: ['Sending'], ms: 4000, left: 0 },
  { id: 'listen-1', kind: 'listen', say: [], heard: 'send the deck', over: true },
];

const icon = 'data:image/png;base64,iVBORw0KGgo=';

describe('a message from the brain, read by the page', () => {
  test('everything a message can carry is read as it was sent', () => {
    const messages: NotchToPage[] = [
      ...lines.map((line): NotchToPage => ({ type: 'show', line })),
      ...lines.map((line): NotchToPage => ({ type: 'state', line, count: 2 })),
      { type: 'state', line: null, count: 0 },
      { type: 'state', line: null, count: 3, born: 'gather', face: 'closed', where: { name: 'Mail', icon }, eye: true, sound: true },
      { type: 'state', line: null, count: 0, where: null },
      { type: 'rest' },
      { type: 'count', count: 4 },
      { type: 'face', mood: 'away' },
      { type: 'where', app: { name: 'Notes' } },
      { type: 'where', app: null },
      { type: 'update', id: 'work-1' },
      { type: 'update', id: 'work-1', done: 3, say: ['Pasting, ', { em: 'without fees' }], heard: 'so far', over: true, blocks },
      { type: 'act' },
      { type: 'act', mood: 'proud', gesture: 'gecko', lip: 'reach', birth: 'bead', aim: 0.3, body: 'hops', kick: -120, edge: 'carry', side: 'right', eye: false, mouth: 'gulp', park: 2, sound: false },
    ];
    for (const message of messages) {
      // As it travels: as text.
      expect(parseNotchToPage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    }
  });

  test('what comes back is a new object: the one that was given is not kept', () => {
    const given: NotchToPage = { type: 'show', line: { id: 'a', kind: 'sheet', say: ['A'], blocks: [{ kind: 'note', say: ['n'] }] } };
    const read = parseNotchToPage(given);
    expect(read).toEqual(given);
    expect(read).not.toBe(given);
    expect((read as typeof given).line).not.toBe(given.line);
  });

  test('a field that is there with nothing in it was left out', () => {
    const line = { id: 'a', kind: 'offer', say: ['Reply?'], yes: 'send', fold: undefined, options: undefined, mood: undefined, unasked: undefined, keys: null };
    expect(parseNotchToPage({ type: 'show', line })).toEqual({ type: 'show', line: { id: 'a', kind: 'offer', say: ['Reply?'], yes: 'send' } });
  });

  test('what a message does not have is not carried along', () => {
    const read = parseNotchToPage({ type: 'show', extra: 1, line: { id: 'a', kind: 'say', say: ['Hi'], ms: 10, onclick: 'x', blocks: 'no' } });
    expect(read).toEqual({ type: 'show', line: { id: 'a', kind: 'say', say: ['Hi'], ms: 10 } });
  });

  test('anything that is not exactly a message is nothing', () => {
    const say = ['Approve?'];
    const hostile: unknown[] = [
      null, undefined, 42, 'show', [], {}, { type: 'nothing' }, { type: 7 }, [{ type: 'rest' }],
      // A line that is not one.
      { type: 'show' }, { type: 'show', line: null }, { type: 'show', line: 'x' }, { type: 'show', line: [] },
      { type: 'show', line: { kind: 'say', say, ms: 100 } },
      { type: 'show', line: { id: '', kind: 'say', say, ms: 100 } },
      { type: 'show', line: { id: 7, kind: 'say', say, ms: 100 } },
      { type: 'show', line: { id: 'x'.repeat(201), kind: 'say', say, ms: 100 } },
      { type: 'show', line: { id: 'a', say } },
      { type: 'show', line: { id: 'a', kind: 'banner', say } },
      { type: 'show', line: { id: 'a', kind: 'say', ms: 100 } },
      { type: 'show', line: { id: 'a', kind: 'say', say: 'Sent.', ms: 100 } },
      { type: 'show', line: { id: 'a', kind: 'say', say } },
      { type: 'show', line: { id: 'a', kind: 'say', say, ms: '100' } },
      { type: 'show', line: { id: 'a', kind: 'say', say, ms: null } },
      { type: 'show', line: { id: 'a', kind: 'say', say, ms: 100, left: 'some' } },
      { type: 'show', line: { id: 'a', kind: 'send', say } },
      { type: 'show', line: { id: 'a', kind: 'send', say, ms: 100, left: {} } },
      // A part of a sentence that is not one.
      { type: 'show', line: { id: 'a', kind: 'say', say: [7], ms: 100 } },
      { type: 'show', line: { id: 'a', kind: 'say', say: [null], ms: 100 } },
      { type: 'show', line: { id: 'a', kind: 'say', say: [{}], ms: 100 } },
      { type: 'show', line: { id: 'a', kind: 'say', say: [{ nope: 1 }], ms: 100 } },
      { type: 'show', line: { id: 'a', kind: 'say', say: [{ em: 7 }], ms: 100 } },
      { type: 'show', line: { id: 'a', kind: 'say', say: [{ key: 'f13' }], ms: 100 } },
      { type: 'show', line: { id: 'a', kind: 'say', say: [{ word: 'Tuesday' }], ms: 100 } },
      { type: 'show', line: { id: 'a', kind: 'say', say: [{ word: { name: 'w', value: 'a' } }], ms: 100 } },
      { type: 'show', line: { id: 'a', kind: 'say', say: [{ word: { name: 'w', value: 'a', options: [1] } }], ms: 100 } },
      { type: 'show', line: { id: 'a', kind: 'say', say: [{ word: { name: 'w', value: 'a', options: [], read: 'mind' } }], ms: 100 } },
      { type: 'show', line: { id: 'a', kind: 'say', say: [{ word: { name: 'w', value: 'a', options: [], syn: { a: 'b' } } }], ms: 100 } },
      { type: 'show', line: { id: 'a', kind: 'say', say: [{ word: { name: 'w', value: 'a', options: [], free: 'yes' } }], ms: 100 } },
      // What must not be guessed at.
      { type: 'show', line: { id: 'a', kind: 'offer', say, unasked: 'yes' } },
      { type: 'show', line: { id: 'a', kind: 'offer', say, yes: 1 } },
      { type: 'show', line: { id: 'a', kind: 'offer', say, options: 'this or that' } },
      { type: 'show', line: { id: 'a', kind: 'offer', say, options: [1, 2] } },
      { type: 'show', line: { id: 'a', kind: 'offer', say, fold: 'never' } },
      { type: 'show', line: { id: 'a', kind: 'offer', say, keys: 'enter' } },
      // A sheet and what it is made of.
      { type: 'show', line: { id: 'a', kind: 'sheet', say } },
      { type: 'show', line: { id: 'a', kind: 'sheet', say, blocks: {} } },
      { type: 'show', line: { id: 'a', kind: 'sheet', say, blocks: [null] } },
      { type: 'show', line: { id: 'a', kind: 'sheet', say, blocks: [{ kind: 'unknown' }] } },
      { type: 'show', line: { id: 'a', kind: 'sheet', say, blocks: [{ kind: 'paper' }] } },
      { type: 'show', line: { id: 'a', kind: 'sheet', say, blocks: [{ kind: 'paper', lines: ['a line'] }] } },
      { type: 'show', line: { id: 'a', kind: 'sheet', say, blocks: [{ kind: 'paper', lines: [], file: { name: 'a' } }] } },
      { type: 'show', line: { id: 'a', kind: 'sheet', say, blocks: [{ kind: 'row' }] } },
      { type: 'show', line: { id: 'a', kind: 'sheet', say, blocks: [{ kind: 'row', say, buttons: [{ id: 'b' }] }] } },
      { type: 'show', line: { id: 'a', kind: 'sheet', say, blocks: [{ kind: 'row', say, buttons: [{ id: 'b', label: 'B', key: '1' }] }] } },
      { type: 'show', line: { id: 'a', kind: 'sheet', say, blocks: [{ kind: 'row', say, go: 1 }] } },
      { type: 'show', line: { id: 'a', kind: 'sheet', say, blocks: [{ kind: 'note' }] } },
      { type: 'show', line: { id: 'a', kind: 'sheet', say, blocks: [{ kind: 'buttons' }] } },
      { type: 'show', line: { id: 'a', kind: 'sheet', say, blocks: [{ kind: 'file', icon: 'exe', name: 'a', meta: 'b' }] } },
      { type: 'show', line: { id: 'a', kind: 'sheet', say, blocks: [{ kind: 'file', icon: 'doc', name: 'a' }] } },
      { type: 'show', line: { id: 'a', kind: 'sheet', say, blocks: [], stay: 'yes' } },
      { type: 'show', line: { id: 'a', kind: 'sheet', say, blocks: [], whole: 1 } },
      { type: 'show', line: { id: 'a', kind: 'ask', say, yes: 'ask', blocks: [] } },
      { type: 'show', line: { id: 'a', kind: 'ask', say, placeholder: 'p', blocks: [] } },
      { type: 'show', line: { id: 'a', kind: 'ask', say, placeholder: 'p', yes: 'ask' } },
      { type: 'show', line: { id: 'a', kind: 'work', say, steps: 3 } },
      { type: 'show', line: { id: 'a', kind: 'work', say, steps: '3', done: 0 } },
      { type: 'show', line: { id: 'a', kind: 'listen', say } },
      // The other messages.
      { type: 'state', count: 0, line: { id: 'a', kind: 'sheet', say } },
      { type: 'state', line: null },
      { type: 'state', line: null, count: 'two' },
      { type: 'state', line: null, count: 0, eye: 'open' },
      { type: 'count' }, { type: 'count', count: '3' },
      { type: 'face' }, { type: 'face', mood: 'furious' },
      { type: 'update' }, { type: 'update', id: 7 }, { type: 'update', id: '' },
      { type: 'update', id: 'a', done: 'all' },
      { type: 'update', id: 'a', say: 'new words' },
      { type: 'update', id: 'a', blocks: [{ kind: 'paper' }] },
      { type: 'update', id: 'a', over: 'yes' },
    ];
    for (const message of hostile) {
      expect([JSON.stringify(message), parseNotchToPage(message)]).toEqual([JSON.stringify(message), null]);
    }
  });

  test('what only dresses a line is left out when it is not known, and the line is still said', () => {
    const read = parseNotchToPage({
      type: 'show',
      line: { id: 'a', kind: 'say', say: ['Here.'], ms: 4000, mood: 'furious', mark: 'star', who: 7, src: 'fax', arrive: 'teleport', step: 3 },
    });
    expect(read).toEqual({ type: 'show', line: { id: 'a', kind: 'say', say: ['Here.'], ms: 4000 } });
    expect(parseNotchToPage({ type: 'state', line: null, count: 1, born: 'hatch', face: 'furious', where: 'here' }))
      .toEqual({ type: 'state', line: null, count: 1, where: null });
  });

  test('a movement that is not known is left out, and the others are made', () => {
    expect(parseNotchToPage({ type: 'act', body: 'dance', kick: null, lip: 'reach', aim: 'left', edge: 'fly', side: 'up', gesture: 'wink', eye: 1, sound: 'on', park: '2', mouth: 'wide', mood: 'x', birth: 'y' }))
      .toEqual({ type: 'act', lip: 'reach', gesture: 'wink' });
  });

  test('the map takes what it can of what it is given', () => {
    const read = parseNotchToPage({
      type: 'show',
      line: { id: 'm', kind: 'sheet', say: ['Looking around'], blocks: [{
        kind: 'map', nodes: [{ id: 'a', label: 'A', x: 9e9, y: 'low', kind: 'spaceship' }, null, { id: 7 }, { id: 'b', label: 'B', x: 10, y: 20, kind: 'tool' }],
        links: 'none', sources: [null, { name: 4 }, { name: 'Mail', found: 3, state: 'busy' }], tour: ['a', 9],
      }] },
    });
    expect(read).toEqual({
      type: 'show',
      line: { id: 'm', kind: 'sheet', say: ['Looking around'], blocks: [{
        kind: 'map', nodes: [{ id: 'a', label: 'A', x: 444, y: 0, kind: 'thing' }, { id: 'b', label: 'B', x: 10, y: 20, kind: 'tool' }],
        links: [], sources: [{ name: 'Mail' }], tour: ['a'],
      }] },
    });
  });

  test('an icon is only ever a small PNG, here too', () => {
    expect(parseNotchToPage({ type: 'where', app: { name: '  Mail  ', icon: 'javascript:alert(1)' } })).toEqual({ type: 'where', app: { name: 'Mail' } });
    expect(parseNotchToPage({ type: 'where', app: { icon } })).toEqual({ type: 'where', app: null });
    expect(parseNotchToPage({ type: 'where' })).toEqual({ type: 'where', app: null });
  });
});
