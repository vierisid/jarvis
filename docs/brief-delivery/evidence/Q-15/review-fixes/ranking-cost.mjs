// Run from the repository root with Bun; arguments are exported pre-fix and baseline ranker files.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const load = path => import(pathToFileURL(resolve(path)).href);
const hash = data => createHash('sha256').update(data).digest('hex');
const paths = { baseline: process.argv[3], before: process.argv[2], after: 'src/vault/recall-ranking.ts' };
if (!paths.before || !paths.baseline) throw new Error('Supply pre-fix and baseline ranker source paths');
const { initDatabase, closeDb } = await load('src/vault/schema.ts');
const { createEntity } = await load('src/vault/entities.ts');
const { createFact } = await load('src/vault/facts.ts');
initDatabase(':memory:', { quiet: true });
let entities, facts;
try {
  const prototype = createEntity('person', 'Contact Name0');
  const base = createFact(prototype.id, 'meeting_note', 'Historic delivery review with separate clients. '.repeat(40));
  entities = Array.from({ length: 300 }, (_, i) => ({ ...prototype, id: `person-${i}`, name: `Contact Name${i}` }));
  facts = entities.flatMap(entity => Array.from({ length: 10 }, (_, j) => ({
    ...base, id: `${entity.id}-${j}`, subject_id: entity.id,
  })));
} finally { closeDb(); }
const query = entities.slice(0, 25).map(e => e.name).join(', ') + ' meeting';
const timings = {}, outputs = {}, sources = {}, normalizations = {};
for (const [name, path] of Object.entries(paths)) {
  const { rankRecall } = await load(path);
  sources[name] = hash(readFileSync(path));
  rankRecall(query, entities, facts); // One warm-up per implementation.
  timings[name] = [];
  for (let run = 0; run < 3; run++) {
    const started = performance.now();
    const result = rankRecall(query, entities, facts);
    timings[name].push(performance.now() - started);
    outputs[name] = JSON.stringify(result);
  }
  const original = String.prototype.normalize;
  normalizations[name] = {};
  try {
    let calls = 0;
    String.prototype.normalize = function (...args) { calls++; return original.apply(this, args); };
    for (const count of [1, 25]) {
      calls = 0;
      rankRecall(entities.slice(0, count).map(e => e.name).join(', ') + ' meeting', entities, facts);
      normalizations[name][count] = calls;
    }
  } finally { String.prototype.normalize = original; }
}
const selectionUnchanged = outputs.before === outputs.after;
if (!selectionUnchanged) throw new Error('Pre-fix and fixed ranker outputs differ');
console.log(JSON.stringify({ command: 'bun docs/brief-delivery/evidence/Q-15/review-fixes/ranking-cost.mjs <pre-fix-ranker.ts> <baseline-ranker.ts>',
  runtime: Bun.version, sources, workload: { people: entities.length, facts: facts.length,
    objectChars: facts[0].object.length, namedPeople: 25, queryChars: query.length },
  method: 'Sequential same-process runs; one warm-up then three timed samples per implementation. Normalization counts are measured separately.',
  timingsMs: timings, normalizationCalls: normalizations, selectionUnchanged,
  limitation: 'Local synthetic stress case, not daemon latency or a wall-time CI gate. Baseline retains its older relevance policy.' }, null, 2));
