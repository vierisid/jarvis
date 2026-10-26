import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initDatabase, getDb, closeDb } from '../vault/schema';
import { createEntity } from '../vault/entities';
import { createFact, correctFact } from '../vault/facts';
import { createApiRoutes, type ApiContext } from './api-routes';
import { MemoryForget } from '../brief/memory-forget';

let savedForget: string | undefined;
beforeEach(() => { savedForget = process.env.JARVIS_BRIEF_MEMORY_FORGET; initDatabase(':memory:', { quiet: true }); });
afterEach(() => { closeDb(); if (savedForget === undefined) delete process.env.JARVIS_BRIEF_MEMORY_FORGET; else process.env.JARVIS_BRIEF_MEMORY_FORGET = savedForget; });

const routes = () => createApiRoutes({} as ApiContext) as Record<string, any>;
const post = (body: unknown) => routes()['/api/vault/facts'].POST(new Request('http://localhost/api/vault/facts', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));
const factCount = () => getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM facts').get()!.n;
const evidenceCount = () => getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM fact_evidence').get()!.n;

test('#1099: an API client cannot replay a corrected automatic fact by posting its source', async () => {
  const subject = createEntity('person', 'Ada').id;
  const original = createFact(subject, 'lives_in', 'Berlin', { source: 'goal_completion' });
  const replacement = correctFact(original.id, 'Hamburg', 'Moved');
  expect(replacement.id).not.toBe(original.id);
  const facts = factCount(), evidence = evidenceCount();

  const response = await post({ subject_id: subject, predicate: 'lives_in', object: 'Berlin', source: 'goal_completion' });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain('source');
  // Nothing was written, and the retired fact was not handed back as if it were new.
  expect(factCount()).toBe(facts);
  expect(evidenceCount()).toBe(evidence);
});

test('#1099: every automatic and decision source is refused; user-entered sources are accepted', async () => {
  const subject = createEntity('person', 'Ada').id;
  for (const source of ['llm_extraction', 'goal_completion', 'user_profile', 'user_correction', 'user_confirmation', 'synthetic_fixture', 'Dashboard', ' dashboard']) {
    const response = await post({ subject_id: subject, predicate: 'note', object: `x-${source}`, source });
    expect({ source, status: response.status }).toEqual({ source, status: 400 });
  }
  expect(factCount()).toBe(0);

  for (const [i, source] of (['dashboard', 'user', 'api', undefined] as const).entries()) {
    const response = await post({ subject_id: subject, predicate: 'note', object: `ok-${i}`, source });
    expect(response.status).toBe(200);
    const fact = await response.json();
    expect(fact.status).not.toBe('superseded');
    expect(fact.source).toBe(source ?? 'dashboard');
    expect(fact.basis).toBe('unspecified');
  }
  expect(factCount()).toBe(4);
});

test('#1099: a non-string source is a 400, not a 500', async () => {
  const subject = createEntity('person', 'Ada').id;
  for (const source of [42, ['dashboard'], { a: 1 }]) {
    const response = await post({ subject_id: subject, predicate: 'note', object: 'x', source });
    expect({ source, status: response.status }).toEqual({ source, status: 400 });
  }
  expect(factCount()).toBe(0);
});

test('#1099: a forgotten automatic fact is refused as a bad source, and Forget still suppresses the automatic writer', async () => {
  process.env.JARVIS_BRIEF_MEMORY_FORGET = '1';
  const subject = createEntity('person', 'Ada').id;
  const fact = createFact(subject, 'lives_in', 'Berlin', { source: 'goal_completion' });
  const service = new MemoryForget(getDb()), read = service.get(fact.id);
  if (read.state !== 'ready') throw new Error('fixture fact is not live');
  service.forget(fact.id, { requestId: crypto.randomUUID(), expectedRevision: read.revision, confirmed: true });
  expect(factCount()).toBe(0);

  // Before #1099 this reached FactSuppressedError and answered 500.
  const replay = await post({ subject_id: subject, predicate: 'lives_in', object: 'Berlin', source: 'goal_completion' });
  expect(replay.status).toBe(400);
  expect(factCount()).toBe(0);
  // The automatic writer itself is still suppressed (F-19 unchanged).
  expect(() => createFact(subject, 'lives_in', 'Berlin', { source: 'goal_completion' })).toThrow('forgotten');
  // A person re-entering the fact by hand is new input, as before.
  expect((await post({ subject_id: subject, predicate: 'lives_in', object: 'Berlin' })).status).toBe(200);
  expect(factCount()).toBe(1);
});
