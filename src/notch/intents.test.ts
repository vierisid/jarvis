import { describe, expect, test } from 'bun:test';
import { matchingIntents, notchIntentTable, resolveIntent, routeByIntents, type NotchIntent } from './intents.ts';

/** An intent that takes a sentence when it begins with `word`, and counts how often it was asked and run. */
function intent(id: string, word: string, more: Partial<NotchIntent> = {}): NotchIntent & { asked: number; ran: number } {
  const made = {
    id, feature: id.split('.')[0]!, says: `takes "${word}"`, band: 'command' as const, act: 'none' as const, first: 'acts' as const, examples: [word],
    asked: 0, ran: 0,
    match(text: string) { made.asked++; return text.startsWith(word) ? { did: `${id} took it`, run: () => { made.ran++; } } : null; },
    ...more,
  };
  return made;
}

describe('the table of intents', () => {
  test('inside a band the lists of the parts keep the order they are given in, and a part that was not made gives none', () => {
    const a = intent('a.one', 'go'), b = intent('b.one', 'stop'), c = intent('c.one', 'go');
    expect(notchIntentTable([[a], null, undefined, [b, c]]).map((one) => one.id)).toEqual(['a.one', 'b.one', 'c.one']);
  });

  test('the bands are asked in their order, whatever order the parts come in: a control word, what is up, a command, what opens', () => {
    const open = intent('a.open', 'do it', { band: 'open' }), command = intent('b.run', 'do it', { band: 'command' });
    const up = intent('c.answer', 'do it', { band: 'up' }), control = intent('d.pause', 'pause', { band: 'control' });
    const later = intent('e.run', 'do it', { band: 'command' });
    const table = notchIntentTable([[open, command], [up, control], [later]]);
    expect(table.map((one) => one.id)).toEqual(['d.pause', 'c.answer', 'b.run', 'e.run', 'a.open']);
    // "Do it" with something up is the answer to it, not the command that the same words could be.
    expect(resolveIntent(table, 'do it')?.intent).toBe(up);
    expect(matchingIntents(table, 'do it').map((one) => one.id)).toEqual(['c.answer', 'b.run', 'e.run', 'a.open']);
    expect(() => notchIntentTable([[intent('f.odd', 'x', { band: 'first' as never })]])).toThrow('f.odd stands in no band');
  });

  test('a reply to a question the assistant asked is put to a control word only: no other intent is even asked', () => {
    const control = intent('a.pause', 'pause', { band: 'control', inReply: true });
    const up = intent('b.answer', 'do it', { band: 'up' }), command = intent('c.run', 'do it', { band: 'command' }), open = intent('d.open', 'settings', { band: 'open' });
    const table = notchIntentTable([[control, up, command, open]]);
    const reply = { source: 'typed', at: 1, reply: true } as const;
    for (const words of ['do it', 'settings', 'do it by email']) expect([words, resolveIntent(table, words, reply)]).toEqual([words, null]);
    expect([up.asked, command.asked, open.asked]).toEqual([0, 0, 0]);
    expect(matchingIntents(table, 'do it', reply)).toEqual([]);
    expect(resolveIntent(table, 'pause', reply)?.intent).toBe(control);
    // The same words, not as a reply.
    expect(resolveIntent(table, 'do it', { source: 'typed', at: 1 })?.intent).toBe(up);
    expect(resolveIntent(table, 'do it', { source: 'typed', at: 1, reply: false })?.intent).toBe(up);
    expect(resolveIntent(table, 'settings')?.intent).toBe(open);
  });

  test('two intents of one name are refused: the name is what is kept on an instruction', () => {
    expect(() => notchIntentTable([[intent('a.one', 'go')], [intent('a.one', 'stop')]])).toThrow('two intents are called a.one');
  });

  test('the first intent that matches takes the sentence, and those after it are not asked', () => {
    const a = intent('a.one', 'stop'), b = intent('b.one', 'go'), c = intent('c.one', 'go');
    const hit = resolveIntent(notchIntentTable([[a, b, c]]), 'go on');
    expect(hit?.intent).toBe(b);
    expect(hit?.did).toBe('b.one took it');
    expect([a.asked, b.asked, c.asked]).toEqual([1, 1, 0]);
  });

  test('a sentence that no intent matches is nobody\'s: null', () => {
    expect(resolveIntent(notchIntentTable([[intent('a.one', 'stop')]]), 'what is the weather')).toBeNull();
    expect(resolveIntent([], 'stop')).toBeNull();
  });

  test('nothing is done until what came back is run, and then it is done once', () => {
    const a = intent('a.one', 'go');
    const hit = resolveIntent([a], 'go')!;
    expect(a.ran).toBe(0);
    hit.run();
    expect(a.ran).toBe(1);
  });

  test('how the words came is handed to the intent as it was given', () => {
    const seen: unknown[] = [];
    const a = intent('a.one', 'go', { match: (_text, how) => { seen.push(how); return null; } });
    resolveIntent([a], 'go');
    resolveIntent([a], 'go', { source: 'spoken', at: 7 });
    expect(seen).toEqual([undefined, { source: 'spoken', at: 7 }]);
  });

  test('a part\'s own route is the first of its intents that takes the words, without the intent', () => {
    const a = intent('a.one', 'stop'), b = intent('a.two', 'go');
    const hit = routeByIntents([a, b], 'go');
    expect(hit && Object.keys(hit).sort()).toEqual(['did', 'run']);
    hit!.run();
    expect(b.ran).toBe(1);
    expect(routeByIntents([a, b], 'neither')).toBeNull();
  });
});
