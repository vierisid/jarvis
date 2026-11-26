import { describe, expect, test } from 'bun:test';
import { notchIntentTable, resolveIntent, routeByIntents, type NotchIntent } from './intents.ts';

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
  test('the lists of the parts are put together in the order they are given in, and a part that was not made gives none', () => {
    const a = intent('a.one', 'go'), b = intent('b.one', 'stop'), c = intent('c.one', 'go');
    expect(notchIntentTable([[a], null, undefined, [b, c]]).map((one) => one.id)).toEqual(['a.one', 'b.one', 'c.one']);
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
