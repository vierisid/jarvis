import { afterEach, describe, expect, test } from 'bun:test';
import { NOTCH_TOLD_SOURCE, createNotchRemember, onlySaidWords, parseRemembered } from './remember.ts';
import type { NotchRememberDeps } from './remember.ts';
import { matchEntityByName } from '../daemon/room-action-targets.ts';
import { createEntity, getEntity, listEntityNames } from '../vault/entities.ts';
import { createFact, findFacts, getFact } from '../vault/facts.ts';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { MemoryStream } from '../brief/memory-stream.ts';

afterEach(() => closeDb());

/** The real memory, with the model's reply given. */
function real(reply: string | Error): NotchRememberDeps {
  initDatabase(':memory:', { quiet: true });
  return {
    ask: async () => { if (reply instanceof Error) throw reply; return reply; },
    entities: () => listEntityNames(),
    match: (entities, name) => matchEntityByName(entities, name),
    owner: () => null,
    createEntity: (type, name) => createEntity(type, name, undefined, NOTCH_TOLD_SOURCE),
    createFact: (subjectId, predicate, object, evidence) => createFact(subjectId, predicate, object, { ...evidence, confirmed: true }),
    read: (factId) => {
      const fact = getFact(factId);
      const subject = fact ? getEntity(fact.subject_id) : null;
      return fact && subject ? { subject: subject.name, predicate: fact.predicate, object: fact.object } : null;
    },
    log: () => {},
  };
}

const ANNA = '{"subject":"Anna","type":"person","me":false,"predicate":"prefers","object":"calls"}';

describe('"Remember that Anna prefers calls."', () => {
  test('is one confirmed fact, with the sentence as its evidence, read back from memory', async () => {
    const remember = createNotchRemember(real(ANNA));
    const result = await remember('Anna prefers calls', 'Remember that Anna prefers calls.', 'ask1');
    expect(result).toEqual({ ok: true, said: 'Remembered: Anna prefers calls.', understood: 'Anna · prefers · calls' });
    const anna = listEntityNames().find((entity) => entity.name === 'Anna')!;
    const facts = findFacts({ subject_id: anna.id });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ predicate: 'prefers', object: 'calls', source: NOTCH_TOLD_SOURCE, basis: 'confirmed', binding_eligible: true });
    expect(facts[0]!.verified_at).not.toBeNull();
    expect(facts[0]!.evidence[0]).toMatchObject({ source: NOTCH_TOLD_SOURCE, source_ref: 'notch:ask1', quote: 'Remember that Anna prefers calls.' });
  });

  test('the Memory room shows "you told me" as where it came from', async () => {
    const remember = createNotchRemember(real(ANNA));
    await remember('Anna prefers calls', 'Remember that Anna prefers calls.', 'ask1');
    const result = await new MemoryStream(getDb()).read({}) as { state: string; data: { items: { sentence: string; basis: string; sourceSummary: { labels: string[] } }[] } };
    expect(result.state).toBe('ready');
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]).toMatchObject({ sentence: 'Anna prefers calls', basis: 'confirmed' });
    expect(result.data.items[0]!.sourceSummary.labels).toEqual(['you told me']);
  });

  test('said twice, it is still one fact', async () => {
    const remember = createNotchRemember(real(ANNA));
    await remember('Anna prefers calls', 'Remember that Anna prefers calls.', 'ask1');
    await remember('Anna prefers calls', 'Remember that Anna prefers calls.', 'ask2');
    expect(findFacts({})).toHaveLength(1);
    expect(listEntityNames()).toHaveLength(1);
  });

  test('a name memory already knows is used, not made again', async () => {
    const deps = real(ANNA);
    const known = createEntity('person', 'Anna Rossi');
    const result = await createNotchRemember(deps)('Anna prefers calls', 'Remember that Anna prefers calls.', 'ask1');
    expect(result).toMatchObject({ ok: true, said: 'Remembered: Anna Rossi prefers calls.' });
    expect(findFacts({ subject_id: known.id })).toHaveLength(1);
  });

  test('a name that fits two people saves nothing and asks for the full name', async () => {
    const deps = real(ANNA);
    createEntity('person', 'Anna Rossi');
    createEntity('person', 'Anna Lima');
    const result = await createNotchRemember(deps)('Anna prefers calls', 'Remember that Anna prefers calls.', 'ask1');
    expect(result).toEqual({ ok: false, why: 'I know more than one Anna. Say the full name. Nothing was saved.' });
    expect(findFacts({})).toHaveLength(0);
  });

  test('a fact about the speaker goes to their own entry', async () => {
    const deps = real('{"subject":"me","type":"person","me":true,"predicate":"prefers","object":"short emails"}');
    const me = createEntity('person', 'Sam');
    deps.owner = () => me;
    const result = await createNotchRemember(deps)('I prefer short emails', 'Remember that I prefer short emails.', 'ask1');
    expect(result).toMatchObject({ ok: true, said: 'Remembered: Sam prefers short emails.' });
  });

  test('a reply that is not the object asked for saves nothing', async () => {
    for (const reply of ['', 'Sure! Anna prefers calls.', '{"subject":"Anna"}', new Error('no model')]) {
      const result = await createNotchRemember(real(reply))('Anna prefers calls', 'Remember that Anna prefers calls.', 'ask1');
      expect(result).toEqual({ ok: false, why: 'I could not work out what to remember. Nothing was saved.' });
      expect(findFacts({})).toHaveLength(0);
      closeDb();
    }
  });

  test('a model that adds words that were not said saves nothing', async () => {
    const added = '{"subject":"Anna Rossi","type":"person","me":false,"predicate":"prefers","object":"calls"}';
    const result = await createNotchRemember(real(added))('Anna prefers calls', 'Remember that Anna prefers calls.', 'ask1');
    expect(result.ok).toBe(false);
    expect(findFacts({})).toHaveLength(0);
  });
});

describe('second batch of the edge-case audit', () => {
  test('with a question first: a no writes nothing at all, not even the name', async () => {
    const remember = createNotchRemember(real(ANNA));
    const asked: string[] = [];
    const result = await remember('Anna prefers calls', 'remember that Anna prefers calls', 'ask1', async (fact) => { asked.push(fact); return false; });
    expect(asked).toEqual(['Anna prefers calls']);
    expect(result).toEqual({ ok: false, why: 'Not saved.' });
    expect(findFacts({})).toHaveLength(0);
    expect(listEntityNames()).toHaveLength(0);
  });

  test('a "not" is never lost, and never added', () => {
    const likes = { subject: 'Anna', type: 'person' as const, me: false, predicate: 'likes', object: 'calls' };
    expect(onlySaidWords(likes, 'Anna does not like calls')).toBe(false);
    expect(onlySaidWords({ ...likes, predicate: 'does not like' }, 'Anna does not like calls')).toBe(true);
    expect(onlySaidWords({ ...likes, predicate: "doesn't like" }, 'Anna likes calls')).toBe(false);
    expect(onlySaidWords(likes, 'Anna likes calls')).toBe(true);
  });

  test('facts about the speaker go to one entry, however many are told', async () => {
    const deps = real('{"subject":"me","type":"person","me":true,"predicate":"prefers","object":"short emails"}');
    const remember = createNotchRemember(deps);
    await remember('I prefer short emails', 'Remember that I prefer short emails.', 'a1');
    deps.ask = async () => '{"subject":"me","type":"person","me":true,"predicate":"works from","object":"home"}';
    await createNotchRemember(deps)('I work from home', 'Remember that I work from home.', 'a2');
    expect(listEntityNames().map((entity) => entity.name)).toEqual(['The owner']);
    expect(findFacts({})).toHaveLength(2);
  });
});

describe('reading the split', () => {
  test('takes the object out of whatever surrounds it, and nothing else', () => {
    expect(parseRemembered(`Here: ${ANNA}`)).toEqual({ subject: 'Anna', type: 'person', me: false, predicate: 'prefers', object: 'calls' });
    expect(parseRemembered('{"subject":"x","predicate":"is","object":"y","type":"spaceship"}')?.type).toBe('concept');
    expect(parseRemembered('[1,2]')).toBeNull();
    expect(parseRemembered('{"subject":"","predicate":"is","object":"y"}')).toBeNull();
  });

  test('every word of the fact must have been said', () => {
    const parts = { subject: 'Anna', type: 'person' as const, me: false, predicate: 'prefers', object: 'calls' };
    expect(onlySaidWords(parts, 'Anna prefers calls')).toBe(true);
    expect(onlySaidWords({ ...parts, object: 'calls on Fridays' }, 'Anna prefers calls')).toBe(false);
    expect(onlySaidWords({ ...parts, me: true, subject: 'me' }, 'I prefer calls')).toBe(true);
  });
});
