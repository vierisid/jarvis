import { afterEach, beforeEach, expect, test } from 'bun:test';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { createEntity, getEntity, updateEntity } from '../vault/entities.ts';
import { createFact } from '../vault/facts.ts';
import { createRelationship } from '../vault/relationships.ts';
import { ENTITY_NAME_MAX_CHARS, RELATIONSHIP_TYPE_MAX_CHARS } from '../vault/input-limits.ts';
import { createApiRoutes, type ApiContext } from './api-routes.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => closeDb());

type Handler = (request: Request) => Response | Promise<Response>;
const routes = () => createApiRoutes({} as ApiContext) as Record<string, Record<string, Handler>>;
const post = (path: string, body: unknown) => routes()[path]!.POST!(new Request(`http://localhost${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));
const count = (table: string) => getDb().query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;

test('an entity name over the limit is refused with a 400 and nothing is stored', async () => {
  const response = await post('/api/vault/entities', { name: 'x'.repeat(1_000_000), type: 'person' });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain(String(ENTITY_NAME_MAX_CHARS));
  expect(count('entities')).toBe(0);
  expect((await post('/api/vault/entities', { name: 'x'.repeat(ENTITY_NAME_MAX_CHARS), type: 'person' })).status).toBe(200);
});

test.each(['a\u0000b', 'a\u0007b', 'a\u001bb', 'a\nb', 'a\tb', 'a\u007fb', 'a\u0085b', 'a\u009bb', 'a\u2028b', 'a\u2029b'])('an entity name with a control character or separator is refused: %j', async name => {
  const response = await post('/api/vault/entities', { name, type: 'person' });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain('control characters');
  expect(count('entities')).toBe(0);
});

test('fact text and predicate are bounded, and control characters are refused except tab and newline in the value', async () => {
  const id = createEntity('person', 'Ada').id;
  const fact = (predicate: string, object: string) => post('/api/vault/facts', { subject_id: id, predicate, object });
  expect((await fact('note', 'y'.repeat(4001))).status).toBe(400);
  expect((await fact('p'.repeat(201), 'ok')).status).toBe(400);
  expect((await fact('note', 'bad\u0000value')).status).toBe(400);
  expect((await fact('no\nte', 'ok')).status).toBe(400);
  expect(count('facts')).toBe(0);
  expect((await fact('note', 'line one\n\tline two')).status).toBe(200);
});

test('a relationship label is bounded and refuses control characters', async () => {
  const a = createEntity('person', 'Ada').id, b = createEntity('tool', 'Bun').id;
  const rel = (type: string) => post('/api/vault/relationships', { from_id: a, to_id: b, type });
  expect((await rel('t'.repeat(RELATIONSHIP_TYPE_MAX_CHARS + 1))).status).toBe(400);
  expect((await rel('uses\u0000')).status).toBe(400);
  expect(count('relationships')).toBe(0);
  expect((await rel('uses')).status).toBe(200);
});

test('internal writers never throw: a long or control-laden value is cleaned and cut', () => {
  const entity = createEntity('person', `${'x'.repeat(5000)}\u0000end`, undefined, 'llm_extraction');
  expect(entity.name.length).toBe(ENTITY_NAME_MAX_CHARS);
  expect(getEntity(entity.id)!.name).toBe(entity.name);
  const withControl = createEntity('tool', 'Bell\u0007Tool');
  expect(withControl.name).toBe('Bell Tool');
  const rel = createRelationship(entity.id, withControl.id, `${'r'.repeat(500)}`);
  expect(rel.type.length).toBe(RELATIONSHIP_TYPE_MAX_CHARS);
});

test('an entity name stored before the limit still reads back in full', () => {
  const id = 'legacy-long';
  getDb().prepare('INSERT INTO entities (id, type, name, properties, created_at, updated_at, source) VALUES (?, ?, ?, NULL, 1, 1, NULL)')
    .run(id, 'person', 'L'.repeat(5000));
  expect(getEntity(id)!.name).toHaveLength(5000);
});

test('an entity name with a lone surrogate, or nothing visible, is refused', async () => {
  expect((await post('/api/vault/entities', { name: 'a\ud800b', type: 'person' })).status).toBe(400);
  expect((await post('/api/vault/entities', { name: '   ', type: 'person' })).status).toBe(400);
  expect((await post('/api/vault/entities', { name: '‮⁦', type: 'person' })).status).toBe(400);
  expect(count('entities')).toBe(0);
});

test.each(['דנה כהן', 'محمد علي', 'می‌خواهم', '山田太郎',
  'Family \u{1F468}‍\u{1F469}‍\u{1F467} ❤️', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} team'])(
  'a name in any script, with ZWNJ, ZWJ, variation selectors or a flag tag sequence, is stored as written: %j', async name => {
    const response = await post('/api/vault/entities', { name, type: 'person' });
    expect(response.status).toBe(200);
    expect((await response.json()).name).toBe(name);
  });

test('the characters that reorder text are dropped from a stored name', async () => {
  const response = await post('/api/vault/entities', { name: 'cv‮gpj.exe', type: 'tool' });
  expect(response.status).toBe(200);
  expect((await response.json()).name).toBe('cvgpj.exe');
});

test('a corrected fact value is held to the same rule as a new one', async () => {
  const id = createEntity('person', 'Ada').id;
  const fact = createFact(id, 'note', 'old', { source: 'user' });
  const correct = (object: string) => routes()['/api/vault/facts/:id/correct']!.POST!(Object.assign(new Request('http://localhost/x', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true, reason: 'typo', object }),
  }), { params: { id: fact.id } }));
  expect((await correct('bad\u0000value')).status).toBe(400);
  expect((await correct('fine\nvalue')).status).toBe(200);
});

test('renaming an entity from an internal writer cleans the name too', () => {
  const id = createEntity('person', 'Ada').id;
  expect(updateEntity(id, { name: 'Ada\nLovelace' })!.name).toBe('Ada Lovelace');
});
