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

const postEntity = (body: unknown) => routes()['/api/vault/entities'].POST(new Request('http://localhost/api/vault/entities', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));
const entityCount = () => getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM entities').get()!.n;

test('#1113 for entities: only user-entered source labels are accepted', async () => {
  // `user_profile` is how the vault finds the owner's profile entity (the
  // newest one wins), so a posted one took the owner's place.
  for (const source of ['user_profile', 'goal_completion', 'llm_extraction', 'awareness', 'Dashboard', 42]) {
    const response = await postEntity({ name: 'Mallory', type: 'person', source });
    expect({ source, status: response.status }).toEqual({ source, status: 400 });
  }
  expect(entityCount()).toBe(0);
  for (const source of ['dashboard', 'user', 'api', undefined]) {
    const response = await postEntity({ name: `ok-${source}`, type: 'person', source });
    expect(response.status).toBe(200);
    expect((await response.json()).source).toBe(source ?? 'dashboard');
  }
});

test('#1118: a name is matched by the daemon over names only, with the shared matcher', async () => {
  createEntity('person', 'Alice Smith', { secret: 'x'.repeat(1000) });
  createEntity('person', 'James');
  createEntity('person', 'Bob'); createEntity('person', 'bob');
  const match = async (name: string) => (await routes()['/api/vault/entity-match'].GET(
    new Request(`http://localhost/api/vault/entity-match?name=${encodeURIComponent(name)}`))).json();
  expect((await match('alice')).entity.name).toBe('Alice Smith');
  // Only what a match needs: no properties travel.
  expect(Object.keys((await match('alice')).entity).sort()).toEqual(['id', 'name']);
  expect(await match('me')).toEqual({ entity: null });
  expect(await match('Bob')).toEqual({ entity: null, ambiguous: 2 });
  expect((await routes()['/api/vault/entity-match'].GET(new Request('http://localhost/api/vault/entity-match'))).status).toBe(400);
  expect((await routes()['/api/vault/entity-match'].GET(new Request(`http://localhost/api/vault/entity-match?name=${'a'.repeat(501)}`))).status).toBe(400);
  expect((await match('a'.repeat(500))).entity).toBeNull();
});

test('GET /api/vault/facts pages with limit and offset, and keeps the full list without them', async () => {
  const subject = createEntity('person', 'Ada').id;
  for (let i = 0; i < 7; i++) createFact(subject, 'note', `item ${i}`, { source: 'dashboard' });
  const get = async (qs = '') => routes()['/api/vault/facts'].GET(new Request(`http://localhost/api/vault/facts${qs}`));
  const all = await (await get()).json() as { id: string }[];
  expect(all).toHaveLength(7);
  const pages = [...await (await get('?limit=3')).json(), ...await (await get('?limit=3&offset=3')).json(), ...await (await get('?limit=3&offset=6')).json()];
  expect(pages.map((f: { id: string }) => f.id)).toEqual(all.map(f => f.id));
  for (const bad of ['?limit=0', '?limit=1001', '?limit=x', '?limit=1&offset=-1', '?offset=2']) expect((await get(bad)).status).toBe(400);
});
