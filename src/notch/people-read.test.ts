import { describe, expect, test } from 'bun:test';
import { NOTCH_PEOPLE_READ_MORE, NOTCH_PEOPLE_READ_PEOPLE, NOTCH_PEOPLE_READ_SAID_MAX, NOTCH_PEOPLE_READ_SYSTEM, peopleIndirect, peopleNamed, peopleReadMessages, peopleReadParse, peopleStranger } from './people-read.ts';
import { PEER_FILE_WHAT_MAX } from '../peers/notes.ts';

const PEOPLE = [{ name: 'Leo Rossi' }, { name: 'Anna Bianchi' }, { name: 'Will Hart' }, { name: 'Leo Marchetti' }];
const TWO = [{ name: 'Leo' }, { name: 'Anna Bianchi' }];

describe('who a sentence names', () => {
  test('a whole name, or a first name that only one of them has, however it is written down', () => {
    expect(peopleNamed('can you get me the logo from Anna', PEOPLE)).toEqual([1]);
    expect(peopleNamed('i need this from annas laptop', PEOPLE)).toEqual([1]);
    expect(peopleNamed("put it on Anna's Pillow", PEOPLE)).toEqual([1]);
    expect(peopleNamed('tell anna bianchi hi', PEOPLE)).toEqual([1]);
    expect(peopleNamed('tell Leo Rossi and Anna hi', PEOPLE)).toEqual([0, 1]);
    // Two of them are called Leo: "Leo" alone names neither.
    expect(peopleNamed('tell Leo hi', PEOPLE)).toEqual([]);
    expect(peopleNamed('tell Leo hi', TWO)).toEqual([0]);
  });

  test('a name inside another word names nobody, and a name that is also a word needs its capital', () => {
    expect(peopleNamed('Leopold wrote to me', TWO)).toEqual([]);
    expect(peopleNamed('the annals of the firm', TWO)).toEqual([]);
    expect(peopleNamed('will you remind me at five', PEOPLE)).toEqual([]);
    expect(peopleNamed('ask Will if he comes', PEOPLE)).toEqual([2]);
    expect(peopleNamed('what is the weather', PEOPLE)).toEqual([]);
    expect(peopleNamed('tell Leo hi', [])).toEqual([]);
  });
});

describe('a name that is nobody here, beside one that is', () => {
  test('said as a list with somebody here, it is somebody else', () => {
    for (const text of ['send Leo and Bob the deck', 'send Bob and Leo the deck', 'send the deck to Leo, Bob and Anna', 'tell Dana, Leo and Anna hi', 'ask Leo or Marco for it', 'send it to Leo and to Bob', 'get the deck from Leo and Dropbox']) {
      expect(peopleStranger(text, TWO)).toBe(true);
    }
  });

  test('people who are all here, a comma that is no list, and "and I" are not', () => {
    for (const text of ['tell Leo and Anna hi', 'send the deck to Leo, Anna Bianchi and Leo', 'tell Leo, Thursday works', 'tell Leo and I will come', 'Send Leo the deck', 'can you get me the logo from Leo', "give Leo's laptop and Anna's the file", 'tell Leo the deck and the Friday numbers are ready']) {
      expect(peopleStranger(text, TWO)).toBe(false);
    }
    expect(peopleStranger('send Leo and Bob the deck', [])).toBe(false);
  });
});

describe('words that are about the reader, not to them', () => {
  test('a "he", a "his", a "to", an "if": they cannot go as they are', () => {
    for (const [verb, words] of [['tell', 'I love him'], ['tell', 'his deck is great'], ['tell', "she's late again"], ['tell', 'to call me'], ['tell', 'not to worry'], ['tell', 'about the review'], ['ask', 'if he is coming'], ['ask', 'whether Friday works'], ['ask', 'when the deck is ready'], ['ask', 'for an update'], ['ask', 'how the launch went'], ['message', "they're late"]] as const) {
      expect(peopleIndirect(verb, words)).toBe(true);
    }
  });

  test('words that are already said to the reader go as they are, with no model', () => {
    for (const [verb, words] of [['tell', 'hi'], ['tell', 'I love you'], ['tell', 'the review moved to Friday'], ['tell', 'the theme is fine'], ['tell', 'when the deck is ready I will send it'], ['ask', 'Thursday or Friday?'], ['ask', 'is the deck ready'], ['tell', ''], ['tell', 'thermal paste arrived']] as const) {
      expect(peopleIndirect(verb, words)).toBe(false);
    }
  });
});

describe('the question that is put to the model', () => {
  test('it carries the people by number and the sentence, and nothing else of the owner\'s', () => {
    const messages = peopleReadMessages('  can you   get me the logo\nfrom Leo ', TWO);
    expect(messages[0]).toEqual({ role: 'system', content: NOTCH_PEOPLE_READ_SYSTEM });
    expect(messages[1]).toEqual({ role: 'user', content: "Colleagues:\n1. Leo\n2. Anna Bianchi\n\nThe owner's sentence:\ncan you get me the logo from Leo" });
  });

  test('a long sentence and a long list are cut, and what cannot be seen does not travel', () => {
    const many = Array.from({ length: NOTCH_PEOPLE_READ_PEOPLE + 5 }, (_, at) => ({ name: `Person ${at}` }));
    const messages = peopleReadMessages(`tell Leo ${'x'.repeat(2000)}​\u0007`, many);
    const [list, sentence] = messages[1]!.content.split("\n\nThe owner's sentence:\n");
    expect(list!.split('\n').length).toBe(NOTCH_PEOPLE_READ_PEOPLE + 1);
    expect(sentence!.length).toBe(NOTCH_PEOPLE_READ_SAID_MAX);
    expect(messages[1]!.content).not.toMatch(/[​\u0007]/);
  });

  test('it says each kind, the turning to the reader, and that nothing is added', () => {
    for (const kind of ['"tell"', '"ask"', '"file-from"', '"file-to"', '"do"', '"time"', '"look"', '"none"']) expect(NOTCH_PEOPLE_READ_SYSTEM).toContain(kind);
    expect(NOTCH_PEOPLE_READ_SYSTEM).toContain('"tell Leo I love him" gives "I love you"');
    expect(NOTCH_PEOPLE_READ_SYSTEM).toContain('Add nothing that was not said');
  });
});

describe('what the model answered', () => {
  const said = 'can you tell Leo I love him';
  test('each form is read, with the people as places in the list', () => {
    expect(peopleReadParse('{"kind":"tell","to":[1],"words":"I love you"}', 2, said)).toEqual({ kind: 'tell', to: [0], words: 'I love you' });
    expect(peopleReadParse('```json\n{"kind":"ask","to":[2],"words":"Are you coming?"}\n```', 2, 'ask Anna if she is coming')).toEqual({ kind: 'ask', to: [1], words: 'Are you coming?' });
    expect(peopleReadParse('Here it is: {"kind":"do","to":[1],"words":"Restart the server."}', 2, "restart the server on Leo's laptop")).toEqual({ kind: 'do', to: [0], words: 'Restart the server.' });
    expect(peopleReadParse('{"kind":"file-from","to":[1],"what":"the logo"}', 2, said)).toEqual({ kind: 'file-from', to: [0], what: 'the logo' });
    expect(peopleReadParse('{"kind":"file-to","to":[1,2,1],"what":"the deck"}', 2, said)).toEqual({ kind: 'file-to', to: [0, 1], what: 'the deck' });
    expect(peopleReadParse('{"kind":"time","to":[1],"minutes":60}', 2, said)).toEqual({ kind: 'time', to: [0], minutes: 60 });
    expect(peopleReadParse('{"kind":"time","to":[1]}', 2, said)).toEqual({ kind: 'time', to: [0], minutes: 30 });
    expect(peopleReadParse('{"kind":"time","to":[1],"minutes":100000}', 2, said)).toEqual({ kind: 'time', to: [0], minutes: 30 });
    expect(peopleReadParse('{"kind":"look","to":[2]}', 2, said)).toEqual({ kind: 'look', to: [1] });
    expect(peopleReadParse('{"kind":"none"}', 2, said)).toEqual({ kind: 'none' });
  });

  test('anything that is none of the forms is no reading', () => {
    for (const raw of ['', 'I think it is a message.', '{"kind":"tell"', '[1,2]', '{"kind":"poem","to":[1],"words":"x"}', '{"kind":"tell","words":"hi"}', '{"kind":"tell","to":[],"words":"hi"}', '{"kind":"tell","to":"1","words":"hi"}',
      '{"kind":"tell","to":[1],"words":""}', '{"kind":"tell","to":[1],"words":"   "}', '{"kind":"tell","to":[1],"words":5}', '{"kind":"tell","to":[1]}', '{"kind":"file-from","to":[1]}', '{"kind":"file-from","to":[1],"what":""}']) {
      expect(peopleReadParse(raw, 2, said)).toBeNull();
    }
  });

  test('somebody who was not in the list is nobody, and the whole reading falls', () => {
    for (const to of ['[3]', '[0]', '[-1]', '[1.5]', '[1,3]', '["Leo"]', '[null]']) {
      expect(peopleReadParse(`{"kind":"file-to","to":${to},"what":"the deck"}`, 2, said)).toBeNull();
    }
  });

  test('only a file of the owner\'s own can be for several', () => {
    for (const kind of ['tell', 'ask', 'do']) expect(peopleReadParse(`{"kind":"${kind}","to":[1,2],"words":"hi"}`, 2, said)).toBeNull();
    expect(peopleReadParse('{"kind":"file-from","to":[1,2],"what":"the deck"}', 2, said)).toBeNull();
    expect(peopleReadParse('{"kind":"time","to":[1,2],"minutes":30}', 2, said)).toBeNull();
    expect(peopleReadParse('{"kind":"look","to":[1,2]}', 2, said)).toBeNull();
  });

  test('the words for the reader cannot be much longer than what was said, and a file\'s words not longer than a file\'s may be', () => {
    const just = 'y'.repeat(said.length + NOTCH_PEOPLE_READ_MORE);
    expect(peopleReadParse(JSON.stringify({ kind: 'tell', to: [1], words: just }), 2, said)).toEqual({ kind: 'tell', to: [0], words: just });
    expect(peopleReadParse(JSON.stringify({ kind: 'tell', to: [1], words: `${just}y` }), 2, said)).toBeNull();
    expect(peopleReadParse(JSON.stringify({ kind: 'file-from', to: [1], what: 'z'.repeat(PEER_FILE_WHAT_MAX + 1) }), 2, said)).toBeNull();
  });

  test('what cannot be seen is taken out of the words before they are counted or sent', () => {
    expect(peopleReadParse('{"kind":"tell","to":[1],"words":"I love\\u200b you\\n\\u0007"}', 2, said)).toEqual({ kind: 'tell', to: [0], words: 'I love you' });
  });
});
