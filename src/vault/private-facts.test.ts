import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb, initDatabase } from './schema.ts';
import { createEntity } from './entities.ts';
import { correctFact, createFact, findFacts, getFact, setFactPrivate, updateFact } from './facts.ts';
import { getKnowledgeForMessage } from './retrieval.ts';
import { createFactDecisionRoutes } from './fact-routes.ts';
import { MemoryStream } from '../brief/memory-stream.ts';

beforeEach(() => { initDatabase(':memory:', { quiet: true }); });
afterEach(() => { closeDb(); });

const SECRET = 'salary is 123456 euros';
const seed = () => {
  const entity = createEntity('person', 'Marta Quill', {}, 'dashboard');
  const open = createFact(entity.id, 'role', 'works as a designer', { source: 'dashboard' });
  const secret = createFact(entity.id, 'private note', SECRET, { source: 'dashboard' });
  return { entity, open, secret };
};
const ask = () => getKnowledgeForMessage('What do you know about Marta Quill?');

describe('private facts stay out of every prompt (A-11)', () => {
  test('recall sends a fact until it is made private, then never, and the entity stays', () => {
    const { secret } = seed();
    expect(ask()).toContain(SECRET);
    setFactPrivate(secret.id, true);
    const context = ask();
    expect(context).not.toContain(SECRET);
    expect(context).not.toContain('private note');
    expect(context).toContain('works as a designer');
    expect(getKnowledgeForMessage('Marta Quill')).not.toContain('123456');
    setFactPrivate(secret.id, false);
    expect(ask()).toContain(SECRET);
  });

  test('an entity whose only facts are private reads as having none, without a hint of them', () => {
    const entity = createEntity('person', 'Rune Ostrom', {}, 'dashboard');
    const only = createFact(entity.id, 'diagnosis', 'confidential detail', { source: 'dashboard' });
    setFactPrivate(only.id, true);
    const context = getKnowledgeForMessage('Tell me about Rune Ostrom');
    expect(context).not.toContain('confidential detail');
    expect(context).not.toContain('diagnosis');
  });

  test('the owner still sees it: findFacts, getFact and the Memory stream list it as private', async () => {
    const { secret, entity } = seed();
    setFactPrivate(secret.id, true);
    expect(getFact(secret.id)?.is_private).toBe(1);
    expect(findFacts({ subject_id: entity.id }).map(f => f.id)).toContain(secret.id);
    expect(findFacts({ subject_id: entity.id, excludePrivate: true }).map(f => f.id)).not.toContain(secret.id);
    const stream = new MemoryStream(getDb());
    const page = await stream.read({ limit: 50 });
    expect(page.state).toBe('ready');
    const items = (page as any).data.items as Array<{ factId: string; private: boolean }>;
    expect(items.find(i => i.factId === secret.id)?.private).toBe(true);
    expect(items.find(i => i.factId !== secret.id)?.private).toBe(false);
  });

  test('a correction or revision of a private fact stays private', () => {
    const { secret } = seed();
    setFactPrivate(secret.id, true);
    const corrected = correctFact(secret.id, 'salary is 130000 euros', 'Raise');
    expect(corrected.id).not.toBe(secret.id);
    expect(corrected.is_private).toBe(1);
    expect(ask()).not.toContain('130000');
    const other = createFact(corrected.subject_id, 'private note', 'unrelated', { source: 'dashboard' });
    setFactPrivate(other.id, true);
    const revised = updateFact(other.id, { object: 'unrelated, revised' });
    expect(revised?.is_private).toBe(1);
  });

  test('profile answers cannot be made private here, with a next step', () => {
    const entity = createEntity('person', 'Owner', {}, 'user_profile');
    const fact = createFact(entity.id, 'preferred_name', 'Ada', { source: 'user_profile' });
    expect(() => setFactPrivate(fact.id, true)).toThrow(/profile/i);
    expect(getFact(fact.id)?.is_private).toBe(0);
  });

  test('the route validates its body and answers with the saved fact', async () => {
    const { secret } = seed();
    const route = (createFactDecisionRoutes() as any)['/api/vault/facts/:id/private'].POST;
    const send = (id: string, body: unknown) => route(Object.assign(new Request('http://localhost/x', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: { id } })) as Promise<Response>;
    expect((await send(secret.id, { private: 'yes' })).status).toBe(400);
    expect((await send(secret.id, { private: true, extra: 1 })).status).toBe(400);
    expect((await send(secret.id, 'not json')).status).toBe(400);
    expect((await send('missing', { private: true })).status).toBe(404);
    const ok = await send(secret.id, { private: true });
    expect(ok.status).toBe(200);
    expect((await ok.json()).is_private).toBe(1);
    expect(ask()).not.toContain(SECRET);
  });

  test('an older database gains the column without touching its rows (additive migration)', () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-private-'));
    try {
      const path = join(dir, 'old.db'); const old = new Database(path);
      old.exec(`CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT, name TEXT, properties TEXT, created_at INTEGER, updated_at INTEGER, source TEXT);
        CREATE TABLE facts (id TEXT PRIMARY KEY, subject_id TEXT, predicate TEXT, object TEXT, confidence REAL, source TEXT, created_at INTEGER, verified_at INTEGER);
        INSERT INTO entities VALUES ('e','person','Old Friend',NULL,1,1,NULL);
        INSERT INTO facts VALUES ('f','e','likes','tea',1,'dashboard',1,NULL);`);
      old.close();
      initDatabase(path, { quiet: true });
      expect(getFact('f')?.is_private).toBe(0);
      expect(getKnowledgeForMessage('Old Friend')).toContain('tea');
    } finally { closeDb(); rmSync(dir, { recursive: true, force: true }); }
  });
});
