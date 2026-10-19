import { afterEach, expect, test } from 'bun:test';
import { initDatabase, closeDb } from './schema';
import { createEntity } from './entities';
import { createFact, correctFact } from './facts';
import { readMemoryPage, memoryPageResponse } from './memory-page';
afterEach(closeDb);
test('keyset pages hydrate at most 100 records and visit every entity once', () => {
  initDatabase(':memory:', { quiet: true });
  for (let i = 0; i < 205; i++) createEntity('person', `Fixture ${i}`);
  const first = readMemoryPage('entities'); expect(first.items).toHaveLength(100);
  const second = readMemoryPage('entities', first.nextCursor!); expect(second.items).toHaveLength(100);
  const third = readMemoryPage('entities', second.nextCursor!); expect(third.items).toHaveLength(5); expect(third.nextCursor).toBeNull();
  expect(new Set([...first.items, ...second.items, ...third.items].map(v => v!.id)).size).toBe(205);
  expect(memoryPageResponse(new Request('http://localhost/api/vault/page?kind=secrets')).status).toBe(400);
});
test('facts retain qualification and omit superseded versions on every page', () => {
  initDatabase(':memory:', { quiet: true });
  const entity = createEntity('person', 'Fixture');
  const fact = createFact(entity.id, 'editor', 'old');
  correctFact(fact.id, 'new', 'fixture');
  const page = readMemoryPage('facts');
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toEqual(expect.objectContaining({ object: 'new' }));
});
