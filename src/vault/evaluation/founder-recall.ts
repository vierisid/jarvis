import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Tiktoken } from 'js-tiktoken/lite';
import cl100k from 'js-tiktoken/ranks/cl100k_base';
import type { Fact, FactOptions } from '../facts.ts';
import type { EntityType } from '../entities.ts';

export const FOUNDER_RECALL_PROTOCOL = 'founder-recall-v1';
export const IMPLEMENTATION_ROOT = resolve(import.meta.dir, '../../..');
const tokenizer = new Tiktoken(cl100k);
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type FixtureFact = { key: string; predicate: string; object: string; options?: FactOptions;
  correction?: { key: string; object: string }; followups?: FixtureFact[]; repeats?: number };
export type FounderCase = {
  id: string; category: string; queries: string[];
  entities: Array<{ key: string; name: string; type: EntityType; facts: FixtureFact[] }>;
  required: string[]; allowed?: string[]; forbidden?: string[]; forbiddenSubjects?: string[];
  bindings?: Array<{ subject: string; predicate: string; scope?: string; expected: string | null }>;
  noise?: { entities: number; factsPerEntity: number; predicate: string; object: string };
  abstain?: boolean; expectEmptySubject?: boolean; expectOmission?: boolean; maxChars?: number;
};
export type FounderCorpus = { version: string; split: string; provenance: string; now: number;
  orders: number[]; tokenizer: string; maxTokens: number; cases: FounderCase[] };
export function loadFounderCorpus(split: 'development' | 'heldout') {
  const bytes = readFileSync(new URL(`./fixtures/founder-recall-${split}.json`, import.meta.url));
  const corpus = JSON.parse(bytes.toString()) as FounderCorpus;
  if (corpus.version !== FOUNDER_RECALL_PROTOCOL || corpus.split !== split || corpus.tokenizer !== 'cl100k_base'
    || new Set(corpus.cases.map(c => c.id)).size !== corpus.cases.length || !corpus.orders.includes(0)) throw new Error('Invalid corpus contract');
  return { corpus, sha256: digest(bytes) };
}

type Engine = {
  schema: typeof import('../schema.ts'); entities: typeof import('../entities.ts');
  facts: typeof import('../facts.ts'); retrieval: typeof import('../retrieval.ts'); format: typeof import('../fact-format.ts');
};
/** Can load an unchanged baseline checkout; both implementations use this exact harness/corpus. */
export async function loadRecallEngine(root = IMPLEMENTATION_ROOT): Promise<Engine> {
  const module = (name: string) => import(pathToFileURL(resolve(root, `src/vault/${name}.ts`)).href);
  const [schema, entities, facts, retrieval, format] = await Promise.all(['schema', 'entities', 'facts', 'retrieval', 'fact-format'].map(module));
  return { schema, entities, facts, retrieval, format };
}
function shuffle<T>(input: T[], seed: number): T[] {
  const out = [...input];
  if (!seed) return out;
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1); [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
/** Stable fixture UUIDs eliminate random-ID token/tiebreak noise without bypassing writers. */
function withIds<T>(scope: string, operation: () => T): T {
  const original = crypto.randomUUID;
  let counter = 0;
  crypto.randomUUID = () => {
    const h = digest(`${scope}:${counter++}`);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  try { return operation(); } finally { crypto.randomUUID = original; }
}
type RecordRef = { key: string; subject: string; factId: string };
function seedCase(engine: Engine, fixture: FounderCase, order: number): RecordRef[] {
  const refs: RecordRef[] = [];
  const entities = [...fixture.entities];
  if (fixture.noise) for (let i = 0; i < fixture.noise.entities; i++) entities.push({
    key: `noise-subject-${i}`, name: `Archive department ${i}`, type: 'project',
    facts: Array.from({ length: fixture.noise.factsPerEntity }, (_, j) => ({ key: `noise-${i}-${j}`,
      predicate: fixture.noise!.predicate, object: `${fixture.noise!.object} ${i}/${j}` })),
  });
  for (const entry of shuffle(entities, order)) {
    const entity = withIds(`${fixture.id}:entity:${entry.key}`, () => engine.entities.createEntity(entry.type, entry.name));
    const add = (value: FixtureFact) => {
      const options: FactOptions = { source: 'synthetic_fixture', sourceRef: `fixture:${fixture.id}:${value.key}`, ...value.options };
      const fact = withIds(`${fixture.id}:fact:${value.key}`, () => engine.facts.createFact(entity.id, value.predicate, value.object, options));
      refs.push({ key: value.key, subject: entry.key, factId: fact.id });
      for (let n = 0; n < (value.repeats ?? 0); n++) withIds(`${fixture.id}:repeat:${value.key}:${n}`, () =>
        engine.facts.createFact(entity.id, value.predicate, value.object, { ...options, sourceRef: `${options.sourceRef}:repeat:${n}` }));
      if (value.correction) {
        const corrected = withIds(`${fixture.id}:correction:${value.key}`, () => engine.facts.correctFact(fact.id, value.correction!.object, 'Synthetic explicit correction'));
        refs.push({ key: value.correction.key, subject: entry.key, factId: corrected.id });
      }
      // Only independent bundles are shuffled. Corrections/contradictions retain their causal order.
      value.followups?.forEach(add);
    };
    for (const value of shuffle(entry.facts, order)) add(value);
  }
  if (new Set(refs.map(r => r.key)).size !== refs.length) throw new Error(`Duplicate fixture key: ${fixture.id}`);
  for (const key of [...fixture.required, ...fixture.allowed ?? [], ...fixture.forbidden ?? [],
    ...(fixture.bindings ?? []).flatMap(b => b.expected ? [b.expected] : [])]) {
    if (!refs.some(r => r.key === key)) throw new Error(`Unknown expected key ${fixture.id}/${key}`);
  }
  for (const key of fixture.forbiddenSubjects ?? []) if (!entities.some(e => e.key === key)) throw new Error(`Unknown subject ${key}`);
  return refs;
}

function truthSnapshot(engine: Engine) {
  return digest(JSON.stringify(['entities', 'facts', 'fact_evidence'].map(table => engine.schema.getDb().query(`SELECT * FROM ${table} ORDER BY id`).all())));
}
export function evaluateFounderCase(engine: Engine, fixture: FounderCase, corpus: FounderCorpus, order: number,
  transform: (context: string) => string = value => value) {
  const originalClock = Date.now;
  Date.now = () => corpus.now;
  try {
    engine.schema.initDatabase(':memory:', { quiet: true });
    const refs = seedCase(engine, fixture, order);
    const before = truthSnapshot(engine);
    const records = refs.map(ref => ({ ...ref, fact: engine.facts.getFact(ref.factId)! }));
    return fixture.queries.map(query => {
      const started = performance.now();
      const profiles = engine.retrieval.retrieveForMessage(query);
      const context = transform(engine.retrieval.formatKnowledgeContext(profiles, fixture.maxChars));
      const elapsedMs = performance.now() - started;
      const lines = context.split('\n').filter(line => line.startsWith('  - ') && !line.includes('No current facts recorded.') && !line.startsWith('  - Unverified relationship:'));
      const selected = new Set(profiles.flatMap(profile => profile.facts.map(fact => fact.id)));
      const found = records.filter(r => lines.some(line => line.includes(` | {"id":${JSON.stringify(r.factId)},`)));
      const unqualified = found.filter(r => !lines.includes(`  - ${engine.format.formatFact(r.fact)}`)).map(r => r.key);
      const unidentifiedLines = lines.filter(line => !found.some(r => line.includes(` | {"id":${JSON.stringify(r.factId)},`))).length;
      const keys = found.map(r => r.key).sort();
      const missing = fixture.required.filter(key => !keys.includes(key));
      const irrelevant = keys.filter(key => !(fixture.allowed ?? fixture.required).includes(key));
      const forbidden = keys.filter(key => fixture.forbidden?.includes(key));
      const wrongPerson = found.filter(r => fixture.forbiddenSubjects?.includes(r.subject)).map(r => r.key);
      const bindings = (fixture.bindings ?? []).map(binding => {
        const fact = engine.facts.queryFact(binding.subject, binding.predicate, binding.scope);
        const expectedId = binding.expected ? refs.find(r => r.key === binding.expected)!.factId : null;
        return { ...binding, actualFactId: fact?.id ?? null, expectedFactId: expectedId, pass: (fact?.id ?? null) === expectedId };
      });
      const tokens = tokenizer.encode(context, [], []).length;
      const budgetPassed = context.length <= (fixture.maxChars ?? 12_000) && tokens <= corpus.maxTokens;
      const omissionDisclosed = context.includes('[Additional memory omitted by relevance and context limits; this is not an exhaustive record.]');
      const omissions = records.filter(r => !keys.includes(r.key)).map(r => ({ key: r.key, factId: r.factId,
        reason: r.fact.status === 'superseded' || r.fact.superseded_by ? 'superseded'
          : r.fact.valid_from !== null && r.fact.valid_from > corpus.now || r.fact.valid_to !== null && r.fact.valid_to <= corpus.now ? 'outside_validity'
            : selected.has(r.factId) ? 'context_limit_or_dependency' : 'not_selected_by_ranking' }));
      const qualified = unqualified.length === 0 && unidentifiedLines === 0 && (!found.length || context.startsWith(engine.format.MEMORY_USE_RULES));
      const pass = !missing.length && !irrelevant.length && !forbidden.length && !wrongPerson.length && qualified && budgetPassed
        && bindings.every(b => b.pass) && (!fixture.abstain || context === '')
        && (!fixture.expectEmptySubject || context.includes('No current facts recorded.')) && (!fixture.expectOmission || omissionDisclosed);
      if (truthSnapshot(engine) !== before) throw new Error('Recall changed canonical memory');
      return { id: fixture.id, category: fixture.category, query, order, pass, required: fixture.required,
        found: found.map(r => ({ key: r.key, factId: r.factId, subjectId: r.fact.subject_id,
          ledgerEvidenceIds: r.fact.evidence.map(e => e.id).sort() })).sort((a, b) => a.key.localeCompare(b.key)),
        missing, irrelevant, forbidden, wrongPerson, unqualified, unidentifiedLines, qualified, bindings,
        omissionDisclosed, omissions, chars: context.length, tokens, budgetPassed, elapsedMs, contextSha256: digest(context) };
    });
  } finally { engine.schema.closeDb(); Date.now = originalClock; }
}
type Row = ReturnType<typeof evaluateFounderCase>[number];
/** Descriptive Wilson interval; authored cases are not an independent population sample. */
export function rate(numerator: number, denominator: number) {
  if (!denominator) return { numerator, denominator, rate: null, wilson95: null };
  const p = numerator / denominator, z = 1.96, d = 1 + z * z / denominator;
  const center = (p + z * z / (2 * denominator)) / d;
  const radius = z * Math.sqrt(p * (1 - p) / denominator + z * z / (4 * denominator * denominator)) / d;
  return { numerator, denominator, rate: p, wilson95: [Math.max(0, center - radius), Math.min(1, center + radius)] };
}
const percentile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)] ?? null;
export function summarizeFounderRows(rows: Row[]) {
  // Primary rates use only the original order. Shuffles are paired robustness checks, not extra independent samples.
  const primary = rows.filter(row => row.order === 0);
  const sum = (fn: (row: Row) => number) => primary.reduce((n, row) => n + fn(row), 0);
  const ids = [...new Set(rows.map(r => r.id))];
  const stable = ids.filter(id => {
    const queries = [...new Set(rows.filter(r => r.id === id).map(r => r.query))];
    return queries.every(query => new Set(rows.filter(r => r.id === id && r.query === query)
      .map(r => JSON.stringify(r.found.map(f => f.key)))).size === 1);
  }).length;
  return { cases: ids.length, observations: rows.length, passingObservations: rows.filter(r => r.pass).length,
    casePass: rate(ids.filter(id => rows.filter(r => r.id === id).every(r => r.pass)).length, ids.length),
    relevantFactInclusion: rate(sum(r => r.required.length - r.missing.length), sum(r => r.required.length)),
    precision: rate(sum(r => r.found.length - r.irrelevant.length), sum(r => r.found.length)),
    qualificationRetention: rate(sum(r => r.qualified ? r.found.length : 0), sum(r => r.found.length)),
    bindingAccuracy: rate(sum(r => r.bindings.filter(b => b.pass).length), sum(r => r.bindings.length)),
    stableCases: rate(stable, ids.length), wrongPersonFacts: sum(r => r.wrongPerson.length),
    tokenBudget: rate(primary.filter(r => r.budgetPassed).length, primary.length),
    tokens: { p50: percentile(primary.map(r => r.tokens), .5), p95: percentile(primary.map(r => r.tokens), .95), max: Math.max(0, ...rows.map(r => r.tokens)) },
    latencyMs: { p50: percentile(primary.map(r => r.elapsedMs), .5), p95: percentile(primary.map(r => r.elapsedMs), .95) } };
}
export async function runFounderRecallBenchmark(split: 'development' | 'heldout', root = IMPLEMENTATION_ROOT) {
  const { corpus, sha256 } = loadFounderCorpus(split);
  const engine = await loadRecallEngine(root);
  const sourceHashes = Object.fromEntries(['facts', 'fact-policy', 'fact-format', 'recall-ranking', 'recall-context', 'retrieval']
    .map(file => [file, digest(readFileSync(resolve(root, `src/vault/${file}.ts`)))]));
  const rows = corpus.cases.flatMap(fixture => corpus.orders.flatMap(order => evaluateFounderCase(engine, fixture, corpus, order)));
  return { protocol: FOUNDER_RECALL_PROTOCOL, split, corpusSha256: sha256, sourceHashes,
    harnessSha256: digest(readFileSync(import.meta.path)), now: corpus.now, provenance: corpus.provenance,
    tokenizer: { package: 'js-tiktoken@1.0.21', encoding: corpus.tokenizer, maxTokens: corpus.maxTokens,
      scope: 'Exact reference-encoding tokens for the memory block only; not deployed-profile billing or full-prompt tokens.' },
    uncertainty: 'Wilson intervals are descriptive for authored cases; fact observations within a case are correlated. No field or blinded accuracy claim.',
    summary: summarizeFounderRows(rows), rows };
}
export type FounderReport = Awaited<ReturnType<typeof runFounderRecallBenchmark>>;
export function compareFounderReports(baseline: FounderReport, candidate: FounderReport) {
  if (baseline.protocol !== candidate.protocol || baseline.corpusSha256 !== candidate.corpusSha256
    || baseline.harnessSha256 !== candidate.harnessSha256 || baseline.split !== candidate.split
    || baseline.now !== candidate.now || JSON.stringify(baseline.tokenizer) !== JSON.stringify(candidate.tokenizer)) throw new Error('Unmatched benchmark protocol/corpus');
  const key = (r: Row) => JSON.stringify([r.id, r.query, r.order]);
  const prior = new Map(baseline.rows.map(row => [key(row), row]));
  if (prior.size !== baseline.rows.length || new Set(candidate.rows.map(key)).size !== candidate.rows.length
    || prior.size !== candidate.rows.length || candidate.rows.some(row => !prior.has(key(row)))) throw new Error('Unmatched observations');
  const regressions = candidate.rows.flatMap(row => {
    const before = prior.get(key(row))!;
    const worse = before.pass && !row.pass || row.missing.some(id => !before.missing.includes(id))
      || row.wrongPerson.length > before.wrongPerson.length || row.unqualified.length > before.unqualified.length
      || row.irrelevant.length > before.irrelevant.length || before.budgetPassed && !row.budgetPassed
      || before.qualified && !row.qualified
      || row.bindings.some((b, i) => before.bindings[i]?.pass && !b.pass);
    return worse ? [{ id: row.id, order: row.order, query: row.query }] : [];
  });
  const safetyFailures = candidate.rows.filter(r => r.wrongPerson.length || !r.qualified || r.forbidden.length || r.bindings.some(b => !b.pass));
  return { matchedObservations: prior.size, baseline: baseline.summary, candidate: candidate.summary,
    improvedObservations: candidate.rows.filter(r => !prior.get(key(r))!.pass && r.pass).length,
    regressions, safetyFailures: safetyFailures.map(r => ({ id: r.id, order: r.order })),
    pass: !regressions.length && !safetyFailures.length && candidate.summary.stableCases.rate === 1 };
}
