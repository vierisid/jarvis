import { describe, expect, test } from 'bun:test';
import { notchBeforeNotes, notchBeforeWho, type NotchBeforeSources } from './before.ts';
import type { NotchBlock, NotchPart } from './protocol.ts';

const ANNA = { name: 'Anna Rossi', address: 'anna@lumen.example' };
const LEO = { name: 'Leo Bianchi', address: 'leo@lumen.example' };
const SAM = { name: 'Sam Rivers', address: 'sam@northwind.example' };
const AT = new Date(2026, 9, 28, 10, 0).getTime();
const text = (parts: NotchPart[]): string => parts.map((part) => (typeof part === 'string' ? part : 'em' in part ? part.em : '')).join('');
const rows = (blocks: NotchBlock[]): string[] => blocks.map((block) => (block.kind === 'row' ? `${block.lead}: ${text(block.say)}` : ''));

function sources(more: Partial<NotchBeforeSources> = {}): NotchBeforeSources {
  return {
    people: () => [ANNA, LEO, SAM],
    calls: () => [{
      at: AT, with: 'Anna', summary: 'She liked the workflow demo.',
      actions: [{ what: 'Send pricing for 5 seats on the Pro plan', owner: 'mine', by: 'Friday' }, { what: 'Check the contract start date', owner: 'theirs', by: '' }],
    }],
    mail: (address) => (address === ANNA.address ? [
      { at: AT + 86_400_000, about: 'Anna wants the contract to start on 1 December.', subject: 'Contract', state: 'ready' },
      { at: AT - 86_400_000, about: 'Anna asked for the deck.', subject: 'Deck', state: 'sent' },
    ] : []),
    facts: (about) => (about === ANNA.name ? [{ text: 'Anna Rossi prefers calls on Thursdays.' }] : []),
    ...more,
  };
}

describe('who a meeting is with', () => {
  test('the calendar\'s guests say it, when exactly one of them is somebody the owner writes with', () => {
    expect(notchBeforeWho({ title: 'Weekly sync', who: ['me@northwind.example', 'anna@lumen.example'] }, sources())).toEqual(ANNA);
    expect(notchBeforeWho({ title: 'Weekly sync', who: ['me@northwind.example', ' ANNA@lumen.example '] }, sources())).toEqual(ANNA);
    // Two known people: whose notes would it be?
    expect(notchBeforeWho({ title: 'Call with Anna', who: ['me@northwind.example', 'anna@lumen.example', 'leo@lumen.example'] }, sources())).toBeNull();
    // A room full of people of whom none is known.
    expect(notchBeforeWho({ title: 'Call with Anna', who: ['me@northwind.example', 'a@x.example', 'b@x.example'] }, sources())).toBeNull();
    // One guest nobody knows by mail: the title may still say who.
    expect(notchBeforeWho({ title: 'Call with Anna', who: ['me@northwind.example', 'someone@x.example'] }, sources())).toEqual(ANNA);
  });

  test('without guests the title says it, when exactly one known person is named in it', () => {
    expect(notchBeforeWho({ title: 'Call with Anna' }, sources())).toEqual(ANNA);
    expect(notchBeforeWho({ title: 'Thursday review: Anna Rossi' }, sources())).toEqual(ANNA);
    expect(notchBeforeWho({ title: 'anna / vieri' }, sources())).toEqual(ANNA);
    // Nobody is named, or two are.
    expect(notchBeforeWho({ title: 'Board call' }, sources())).toBeNull();
    expect(notchBeforeWho({ title: 'Anna and Leo: pricing' }, sources())).toBeNull();
    // A name inside another word is not a name: "Samples review" is not about Sam.
    expect(notchBeforeWho({ title: 'Samples review' }, sources())).toBeNull();
    expect(notchBeforeWho({ title: 'Leonardo demo' }, sources())).toBeNull();
  });

  test('a first name two people have names neither, and a whole name names the one', () => {
    const people = () => [ANNA, { name: 'Anna Conti', address: 'conti@lumen.example' }, LEO];
    expect(notchBeforeWho({ title: 'Call with Anna' }, sources({ people }))).toBeNull();
    expect(notchBeforeWho({ title: 'Call with Anna Conti' }, sources({ people }))).toEqual({ name: 'Anna Conti', address: 'conti@lumen.example' });
  });

  test('somebody only a call knows is known by the name said then', () => {
    const only = sources({ people: () => [LEO], calls: () => [{ at: AT, with: 'Vera', summary: 'A first call.', actions: [] }] });
    expect(notchBeforeWho({ title: 'Call with Vera' }, only)).toEqual({ name: 'Vera', address: '' });
    expect(notchBeforeWho({ title: 'Call with Giulia' }, only)).toBeNull();
  });
});

describe('what is known before a meeting', () => {
  test('the last call and what each side owed, the mail that waits and the last that was answered, and what is remembered', () => {
    const notes = notchBeforeNotes({ title: 'Call with Anna' }, sources())!;
    expect(notes.who).toBe('Anna');
    expect(rows(notes.blocks)).toEqual([
      '28 Oct: Last call. She liked the workflow demo.',
      'You owed: Send pricing for 5 seats on the Pro plan, by Friday',
      'Anna owed: Check the contract start date',
      'Waits: Anna wants the contract to start on 1 December.',
      '27 Oct: Anna asked for the deck.',
      'Known: Anna Rossi prefers calls on Thursdays.',
    ]);
  });

  test('with nothing known there are no notes: nothing is said over an empty sheet', () => {
    expect(notchBeforeNotes({ title: 'Call with Leo' }, sources())).toBeNull();
    expect(notchBeforeNotes({ title: 'Board call' }, sources())).toBeNull();
    // A call with them that left nothing to say, and mail with no words about it.
    const empty = sources({ calls: () => [{ at: AT, with: 'Leo', summary: ' ', actions: [{ what: '', owner: 'mine', by: '' }] }], mail: () => [{ at: AT, about: '', subject: ' ', state: 'ready' }], facts: () => [{ text: ' ' }] });
    expect(notchBeforeNotes({ title: 'Call with Leo' }, empty)).toBeNull();
  });

  test('only the newest call with that person, and only theirs', () => {
    const calls = () => [
      { at: AT + 5 * 86_400_000, with: 'Leo Bianchi', summary: 'Leo wants a pilot.', actions: [] },
      { at: AT + 86_400_000, with: 'anna rossi', summary: 'The newer call with Anna.', actions: [] },
      { at: AT, with: 'Anna', summary: 'The older call with Anna.', actions: [] },
      { at: AT - 86_400_000, with: '', summary: 'A call with nobody named.', actions: [] },
    ];
    const notes = notchBeforeNotes({ title: 'Call with Anna' }, sources({ calls, mail: () => [], facts: undefined }))!;
    expect(rows(notes.blocks)).toEqual(['29 Oct: Last call. The newer call with Anna.']);
  });

  test('an action that is nobody\'s is open, and the sheet does not grow without end', () => {
    const calls = () => [{ at: AT, with: 'Anna', summary: '', actions: [
      { what: 'Decide the venue', owner: '', by: '' }, { what: 'Two', owner: 'mine', by: '' }, { what: 'Three', owner: 'mine', by: '' }, { what: 'Four', owner: 'theirs', by: '' }, { what: 'Five', owner: 'theirs', by: '' },
    ] }];
    const facts = () => [{ text: 'One.' }, { text: 'Two.' }, { text: 'Three.' }];
    const notes = notchBeforeNotes({ title: 'Call with Anna' }, sources({ calls, mail: () => [], facts }))!;
    expect(rows(notes.blocks)).toEqual(['Open: Decide the venue', 'You owed: Two', 'You owed: Three', 'Anna owed: Four', 'Known: One.', 'Known: Two.']);
    // A row is one line, however long what was written.
    const long = notchBeforeNotes({ title: 'Call with Anna' }, sources({ calls: () => [{ at: AT, with: 'Anna', summary: 'x'.repeat(900), actions: [] }], mail: () => [], facts: undefined }))!;
    expect(text((long.blocks[0] as Extract<NotchBlock, { kind: 'row' }>).say).length).toBeLessThanOrEqual(175);
  });

  test('mail that only waits, or was only answered, is one row; a subject stands in when nothing says what it was about', () => {
    const waits = notchBeforeNotes({ title: 'Call with Leo' }, sources({ calls: () => [], facts: undefined, mail: () => [{ at: AT, about: '', subject: 'Deck for Thursday?', state: 'ready' }] }))!;
    expect(rows(waits.blocks)).toEqual(['Waits: Deck for Thursday?']);
    const answered = notchBeforeNotes({ title: 'Call with Leo' }, sources({ calls: () => [], facts: undefined, mail: () => [{ at: AT, about: 'Leo asked for the deck.', subject: 'Deck', state: 'answered' }, { at: AT - 1, about: 'An older one.', subject: 'Old', state: 'sent' }] }))!;
    expect(rows(answered.blocks)).toEqual(['28 Oct: Leo asked for the deck.']);
    // Mail that was judged to need no reply, or was turned down, is not something to bring to a call.
    expect(notchBeforeNotes({ title: 'Call with Leo' }, sources({ calls: () => [], facts: undefined, mail: () => [{ at: AT, about: 'A newsletter.', subject: 'News', state: 'silent' }, { at: AT, about: 'Declined.', subject: 'No', state: 'declined' }] }))).toBeNull();
  });

  test('somebody only a call knows has no mail looked up for them', () => {
    let asked = 0;
    const notes = notchBeforeNotes({ title: 'Call with Vera' }, sources({ people: () => [LEO], calls: () => [{ at: AT, with: 'Vera', summary: 'A first call.', actions: [] }], mail: () => { asked++; return []; }, facts: undefined }))!;
    expect(rows(notes.blocks)).toEqual(['28 Oct: Last call. A first call.']);
    expect(asked).toBe(0);
  });
});
