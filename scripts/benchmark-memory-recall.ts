import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { initDatabase, closeDb } from '../src/vault/schema.ts';
import { createEntity } from '../src/vault/entities.ts';
import * as facts from '../src/vault/facts.ts';
import { getKnowledgeForMessage } from '../src/vault/retrieval.ts';

type FixtureFact = { key: string; predicate: string; object: string; source?: string;
  confidence?: number; confirmed?: boolean; correction?: string; replacementKey?: string };
type Case = { id: string; category: string; queries: string[];
  entities: Array<{ name: string; facts: FixtureFact[] }>;
  noise?: { count: number; name: string; predicate: string; object: string };
  required: string[]; allowed?: string[]; forbiddenValues?: string[];
  maxIrrelevant?: number; abstain?: boolean };
type BenchmarkRow = { id: string; category: string; query: string; reverse: boolean;
  pass: boolean; missing: string[]; irrelevant: string[]; found: string[];
  qualified: number; forbidden: string[]; chars: number; elapsedMs: number;
  relevantFactChars: number; retrievedFactChars: number; factCharPrecision: number };

// Exercise real ingestion and retrieval on either side of the C8 merge boundary.
// Never manufacture C8 columns or labels in a legacy database.
function seed(fixture: Case, reverse: boolean) {
  initDatabase(':memory:', { quiet: true });
  const labels = new Map<string, { predicate: string; object: string; source: string | null; confidence: number; id: string }>();
  const entities = [...fixture.entities];
  if (fixture.noise) for (let i = 0; i < fixture.noise.count; i++) entities.unshift({
    name: `${fixture.noise.name} ${i}`, facts: [{ key: `noise-${i}`, ...fixture.noise }],
  });
  if (reverse) entities.reverse();
  for (const entry of entities) {
    const entity = createEntity('person', entry.name);
    // Corrections and subsequent inferences are causally ordered, not independent
    // inserts. Reverse unrelated rows without changing which assertion came later.
    for (const value of reverse && !entry.facts.some(value => value.correction) ? [...entry.facts].reverse() : entry.facts) {
      let fact = facts.createFact(entity.id, value.predicate, value.object, {
        source: value.source ?? 'benchmark', confidence: value.confidence ?? 0.8,
      });
      if (value.confirmed) {
        facts.verifyFact(fact.id);
        fact = facts.getFact(fact.id)!;
      }
      if (value.correction) {
        const correct = Reflect.get(facts, 'correctFact') as undefined | ((id: string, object: string, reason: string) => facts.Fact);
        fact = correct ? correct(fact.id, value.correction, 'Benchmark explicit user correction')
          : facts.updateFact(fact.id, { object: value.correction })!;
        if (!correct) { facts.verifyFact(fact.id); fact = facts.getFact(fact.id)!; }
      }
      labels.set(value.replacementKey ?? value.key, {
        predicate: fact.predicate, object: fact.object, id: fact.id,
        source: fact.source, confidence: fact.confidence,
      });
    }
  }
  return labels;
}

export function runRecallBenchmark(split: 'development' | 'heldout' | 'heldout-v2') {
  const data = readFileSync(new URL(`../src/vault/__fixtures__/recall-${split}.json`, import.meta.url), 'utf8');
  const fixtures = JSON.parse(data) as Case[];
  const rows: BenchmarkRow[] = [];
  for (const fixture of fixtures) for (const reverse of [false, true]) {
    const labels = seed(fixture, reverse);
    for (const query of fixture.queries) {
      const start = performance.now();
      const context = getKnowledgeForMessage(query);
      const elapsedMs = performance.now() - start;
      // Legacy formatting has no IDs. Match each actual line at most once so
      // identical distractor values do not inflate the retrieved-fact count.
      const availableLines = context.split('\n');
      const found: string[] = [];
      const foundLines = new Map<string, string>();
      let relevantFactChars = 0, retrievedFactChars = 0;
      for (const [key, value] of labels) {
        const index = availableLines.findIndex(line => line.includes(`${value.predicate}: ${value.object}`)
          && (!line.includes('"id":') || line.includes(JSON.stringify(value.id))));
        if (index >= 0) {
          const chars = availableLines[index]!.length;
          retrievedFactChars += chars;
          if ((fixture.allowed ?? fixture.required).includes(key)) relevantFactChars += chars;
          found.push(key); foundLines.set(key, availableLines[index]!); availableLines.splice(index, 1);
        }
      }
      const missing = fixture.required.filter(key => !found.includes(key));
      const irrelevant = found.filter(key => !(fixture.allowed ?? fixture.required).includes(key));
      const qualified = found.filter(key => {
        const value = labels.get(key)!;
        // The same line that was counted above: duplicate values must not let a
        // qualified record vouch for an unqualified one.
        const line = foundLines.get(key) ?? '';
        return line.includes(`"confidence":${value.confidence}`) && line.includes(`"source":${JSON.stringify(value.source ?? 'unspecified')}`)
          && line.includes('recorded') && line.includes('basis');
      });
      const forbidden = (fixture.forbiddenValues ?? []).filter(value => context.includes(value));
      const factCharPrecision = retrievedFactChars ? relevantFactChars / retrievedFactChars : 1;
      const pass = missing.length === 0 && forbidden.length === 0 && qualified.length === found.length
        && context.length <= 12_000 && irrelevant.length <= (fixture.maxIrrelevant ?? 0) && factCharPrecision >= 0.8
        && (!fixture.abstain || context === '');
      rows.push({ id: fixture.id, category: fixture.category, query, reverse, pass, missing, irrelevant,
        found, qualified: qualified.length, forbidden, chars: context.length, elapsedMs, relevantFactChars, retrievedFactChars, factCharPrecision });
    }
    closeDb();
  }
  const requiredCount = rows.reduce((sum, row) => sum + fixtures.find(f => f.id === row.id)!.required.length, 0);
  const retrievedCount = rows.reduce((sum, row) => sum + row.found.length, 0);
  const missingCount = rows.reduce((sum, row) => sum + row.missing.length, 0);
  const irrelevantCount = rows.reduce((sum, row) => sum + row.irrelevant.length, 0);
  const qualifiedCount = rows.reduce((sum, row) => sum + row.qualified, 0);
  const factChars = rows.reduce((sum, row) => sum + row.retrievedFactChars, 0);
  const stableCases = fixtures.filter(fixture => {
    const sets = rows.filter(row => row.id === fixture.id).map(row => JSON.stringify([...row.found].sort()));
    return new Set(sets).size === 1;
  }).length;
  return { split, fixtureSha256: createHash('sha256').update(data).digest('hex'), stableCases, cases: fixtures.length,
    truthContract: Reflect.has(facts, 'correctFact') ? 'C8' : 'legacy',
    tasks: rows.length, passed: rows.filter(row => row.pass).length,
    necessaryFactRecall: requiredCount ? (requiredCount - missingCount) / requiredCount : 1,
    factPrecision: retrievedCount ? (retrievedCount - irrelevantCount) / retrievedCount : 1,
    factCharPrecision: factChars ? rows.reduce((sum, row) => sum + row.relevantFactChars, 0) / factChars : 1,
    qualifiedCoverage: retrievedCount ? qualifiedCount / retrievedCount : 1,
    maxContextChars: Math.max(...rows.map(row => row.chars)),
    maxElapsedMs: Math.max(...rows.map(row => row.elapsedMs)), rows };
}

if (import.meta.main) {
  const split = process.argv[2];
  if (split !== 'development' && split !== 'heldout' && split !== 'heldout-v2') throw new Error('Usage: bun scripts/benchmark-memory-recall.ts development|heldout|heldout-v2 [--check]');
  const result = runRecallBenchmark(split);
  console.log(JSON.stringify(result, null, 2));
  if (process.argv.includes('--check') && (result.passed !== result.tasks || result.stableCases !== result.cases)) process.exitCode = 1;
}
