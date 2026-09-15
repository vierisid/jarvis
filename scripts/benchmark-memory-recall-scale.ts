import { initDatabase, closeDb, getDb } from '../src/vault/schema.ts';
import { createEntity } from '../src/vault/entities.ts';
import { createFact } from '../src/vault/facts.ts';
import { getKnowledgeForMessage } from '../src/vault/retrieval.ts';

const count = Number(process.argv[2] ?? 10_000);
if (!Number.isInteger(count) || count < 10 || count > 50_000) throw new Error('Fact count must be between 10 and 50000');
initDatabase(':memory:', { quiet: true });
try {
  getDb().transaction(() => {
    for (let i = 0; i < count / 10; i++) {
      const entity = createEntity('project', `Archived project ${i}`);
      for (let j = 0; j < 10 && i * 10 + j < count; j++) createFact(entity.id, `operating_note_${j}`, `Previous release discussion ${i}-${j}`, { source: 'archive' });
    }
    const target = createEntity('project', 'Zafír');
    createFact(target.id, 'release_owner', 'Kira', { source: 'planning' });
  })();
  const elapsed: number[] = [];
  for (let i = 0; i < 11; i++) {
    const start = performance.now();
    const context = getKnowledgeForMessage('Zafir release owner');
    elapsed.push(performance.now() - start);
    if (!context.includes('release_owner: Kira') || context.length > 12_000) throw new Error('Necessary context lost at scale');
  }
  const coldMs = elapsed.shift()!;
  elapsed.sort((a, b) => a - b);
  console.log(JSON.stringify({ distractorFacts: count, coldMs, medianMs: elapsed[4], p95Ms: elapsed[9],
    warmQueries: elapsed.length, method: 'in-memory SQLite, default ingestion and recall, no embeddings' }, null, 2));
} finally { closeDb(); }
