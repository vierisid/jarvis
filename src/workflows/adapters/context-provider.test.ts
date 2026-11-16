import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, closeDb } from '../../vault/schema';
import { createEntity, findEntities } from '../../vault/entities';
import { JarvisContextProviderAdapter } from './context-provider';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jarvis-ctx-')); initDatabase(join(dir, 'vault.db'), { quiet: true }); });
afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

test('vault_search leaves out workflow bookkeeping entities but keeps them in the vault', async () => {
  createEntity('person', 'Ada');
  createEntity('project', 'lbk0h4QNrT2dLz9oEdSQQ', { entity_kind: 'workflow' });
  createEntity('concept', 'zkRaquk048rgAX6HlPz84', { entity_kind: 'draft_version' });
  createEntity('project', 'Morloven', { entity_kind: 'brand' });
  const adapter = new JarvisContextProviderAdapter();
  expect((await adapter.vaultSearch({})).map(e => e.name).sort()).toEqual(['Ada', 'Morloven']);
  expect(await adapter.vaultSearch({ type: 'project' })).toHaveLength(1);
  expect(findEntities({})).toHaveLength(4);
});
